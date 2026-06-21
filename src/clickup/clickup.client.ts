import { Injectable, Logger } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { firstValueFrom } from "rxjs";
import {
  ClickUpMember,
  ClickUpTask,
  ClickUpTaskPage,
  ClickUpTimeEntry,
  ClickUpWebhook,
  CreateTimeEntryPayload,
} from "./clickup.types";
import { buildTimeEntriesQuery, resolveTimeEntriesWindow } from "./time-entries.util";
import { WorkspaceService } from "../workspaces/workspace.service";

const MAX_429_RETRIES = 3;
const MAX_BACKOFF_MS = 60_000;
// ClickUp's GET /team/{team}/time_entries has no pagination — it returns the
// whole [start_date, end_date] window in one response. A multi-year window on a
// busy task risks a large/truncated response, so split it into <=1-year slices
// and concatenate. A window within a single slice issues exactly one request,
// so existing hot paths (webhooks, hourly sweep) are unchanged.
const TIME_ENTRIES_SLICE_MS = 365 * 24 * 60 * 60 * 1000;

@Injectable()
export class ClickupClient {
  private readonly logger = new Logger(ClickupClient.name);
  private readonly baseUrl = "https://api.clickup.com/api/v2";

  constructor(
    private readonly http: HttpService,
    private readonly workspaces: WorkspaceService,
  ) {}

  private headers(workspaceId: string) {
    return { Authorization: this.workspaces.getApiToken(workspaceId) };
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    workspaceId: string,
    path: string,
    data?: unknown,
    attempt = 0,
  ): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.http.request<T>({
          method,
          url: `${this.baseUrl}${path}`,
          data,
          headers: this.headers(workspaceId),
          timeout: 30000,
        }),
      );
      return response.data;
    } catch (error: any) {
      const status = error?.response?.status;
      // Honor ClickUp's own rate-limit backoff instead of failing the job and
      // leaning on BullMQ's generic retry — Retry-After tells us exactly how
      // long to wait. Bounded so a sustained 429 still surfaces as an error.
      if (status === 429 && attempt < MAX_429_RETRIES) {
        const waitMs = this.retryAfterMs(error?.response?.headers, attempt);
        this.logger.warn(
          `ClickUp ${method} ${path} rate-limited (429); retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_429_RETRIES})`,
        );
        await this.sleep(waitMs);
        return this.request<T>(method, workspaceId, path, data, attempt + 1);
      }
      // Surface ClickUp's actual response body. Axios's error.message is just
      // "Request failed with status code 400" — the real reason (e.g.
      // { err: "...", ECODE: "..." }) lives in error.response.data and was
      // being discarded, making 4xx failures impossible to diagnose from logs.
      const body = error?.response?.data;
      const detail = body
        ? typeof body === "string"
          ? body
          : JSON.stringify(body)
        : "";
      this.logger.error(
        `ClickUp ${method} ${path} failed: ${status || ""} ${error?.message}${detail ? ` — ${detail}` : ""}`,
      );
      throw error;
    }
  }

  private retryAfterMs(
    headers: Record<string, unknown> | undefined,
    attempt: number,
  ): number {
    const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0)
      return Math.min(secs * 1000, MAX_BACKOFF_MS);
    // No/!invalid header → exponential fallback (1s, 2s, 4s…), capped.
    return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getTask(workspaceId: string, taskId: string): Promise<ClickUpTask> {
    return this.request("GET", workspaceId, `/task/${taskId}?include_subtasks=true`);
  }

  getTasksBySpace(
    workspaceId: string,
    spaceId: string,
    options: {
      dateUpdatedGt?: number;
      page?: number;
      includeClosed?: boolean;
      subtasks?: boolean;
      limit?: number;
    },
  ): Promise<ClickUpTaskPage> {
    const teamId = this.workspaces.getTeamId(workspaceId);
    const params = new URLSearchParams();
    params.append("space_ids[]", spaceId);
    if (options.dateUpdatedGt)
      params.append("date_updated_gt", String(options.dateUpdatedGt));
    params.append("include_closed", String(options.includeClosed ?? true));
    params.append("subtasks", String(options.subtasks ?? true));
    params.append("page", String(options.page ?? 0));
    params.append("limit", String(options.limit ?? 100));
    return this.request(
      "GET",
      workspaceId,
      `/team/${teamId}/task?${params.toString()}`,
    );
  }

  async getAllTasksBySpace(
    workspaceId: string,
    spaceId: string,
    options: {
      dateUpdatedGt?: number;
      includeClosed?: boolean;
      subtasks?: boolean;
    },
  ): Promise<{ tasks: ClickUpTask[]; truncated: boolean }> {
    // ~500k tasks (5000 * 100). High enough that a multi-year backfill of any
    // real space stops on a short page well before the cap; the cap only exists
    // as a runaway guard, and `truncated` makes hitting it observable.
    const MAX_PAGES = 5000;
    const all: ClickUpTask[] = [];
    let truncated = false;
    let page = 0;
    for (; page < MAX_PAGES; page++) {
      const res = await this.getTasksBySpace(workspaceId, spaceId, {
        ...options,
        page,
        limit: 100,
      });
      const tasks = res.tasks || [];
      all.push(...tasks);
      if (tasks.length < 100) break;
    }
    if (page === MAX_PAGES) {
      // Ran the full cap without a short page — there are very likely more tasks
      // we did not fetch. Surface it instead of silently treating the truncated
      // list as complete (which would make downstream reconciliation soft-delete
      // the missing tail as "no longer in ClickUp").
      truncated = true;
      this.logger.warn(
        `getAllTasksBySpace(${spaceId}) hit the ${MAX_PAGES}-page cap (~${all.length} tasks); results may be truncated and tasks beyond this window were not fetched`,
      );
    }
    return { tasks: all, truncated };
  }

  async getTimeEntries(
    workspaceId: string,
    taskId: string,
    options?: { assigneeIds?: string[]; startDate?: number; endDate?: number },
  ): Promise<ClickUpTimeEntry[]> {
    const teamId = this.workspaces.getTeamId(workspaceId);
    // Resolve the window once, then fetch it in <=1-year slices (one request per
    // slice) and concatenate. The union is still authoritative for the full
    // window, so the caller's delete-reconciliation stays correct.
    const { startMs, endMs } = resolveTimeEntriesWindow(options ?? {});
    const byId = new Map<string, ClickUpTimeEntry>();
    const out: ClickUpTimeEntry[] = [];
    for (let sliceStart = startMs; sliceStart < endMs; sliceStart += TIME_ENTRIES_SLICE_MS) {
      const sliceEnd = Math.min(sliceStart + TIME_ENTRIES_SLICE_MS, endMs);
      const qs = buildTimeEntriesQuery(taskId, {
        assigneeIds: options?.assigneeIds,
        startDate: sliceStart,
        endDate: sliceEnd,
      });
      const res: any = await this.request(
        "GET",
        workspaceId,
        `/team/${teamId}/time_entries?${qs}`,
      );
      const entries: ClickUpTimeEntry[] = res.data || res.entries || [];
      // Dedupe by time-entry id in case an entry lands on a slice boundary.
      for (const entry of entries) {
        const id = (entry as { id?: string }).id;
        if (id == null) {
          out.push(entry);
        } else if (!byId.has(id)) {
          byId.set(id, entry);
          out.push(entry);
        }
      }
    }
    return out;
  }

  async getTeamMembers(workspaceId: string): Promise<ClickUpMember[]> {
    const teamId = this.workspaces.getTeamId(workspaceId);
    const res: any = await this.request("GET", workspaceId, `/team/${teamId}`);
    return res.team?.members || [];
  }

  /** List the workspace's (non-archived) ClickUp spaces — used by the Settings
   *  "Discover spaces" picker so admins pick spaces to sync instead of typing
   *  raw space ids. */
  async listSpaces(workspaceId: string): Promise<{ id: string; name: string }[]> {
    const teamId = this.workspaces.getTeamId(workspaceId);
    const res: any = await this.request("GET", workspaceId, `/team/${teamId}/space?archived=false`);
    return (res.spaces ?? []).map((s: any) => ({ id: String(s.id), name: s.name ?? String(s.id) }));
  }

  async getWebhooks(workspaceId: string): Promise<ClickUpWebhook[]> {
    const teamId = this.workspaces.getTeamId(workspaceId);
    const res: any = await this.request("GET", workspaceId, `/team/${teamId}/webhook`);
    return res.webhooks || [];
  }
  async createWebhook(
    workspaceId: string,
    endpoint: string,
    events: string[],
  ): Promise<{ id: string; secret: string }> {
    const teamId = this.workspaces.getTeamId(workspaceId);
    const res: any = await this.request("POST", workspaceId, `/team/${teamId}/webhook`, {
      endpoint,
      events,
    });
    return {
      id: res.webhook?.id ?? res.id,
      secret: res.webhook?.secret ?? res.secret ?? "",
    };
  }
  async updateWebhook(
    workspaceId: string,
    webhookId: string,
    update: { endpoint: string; events: string[]; status?: "active" },
  ): Promise<void> {
    // PUT /webhook/{id} updates the subscribed events / endpoint in place and
    // leaves the signing secret unchanged (only POST returns a secret), so
    // signature verification keeps working without re-storing anything.
    await this.request("PUT", workspaceId, `/webhook/${webhookId}`, {
      endpoint: update.endpoint,
      events: update.events,
      status: update.status ?? "active",
    });
  }
  async deleteWebhook(workspaceId: string, webhookId: string): Promise<void> {
    await this.request("DELETE", workspaceId, `/webhook/${webhookId}`);
  }

  async createTimeEntry(
    workspaceId: string,
    payload: CreateTimeEntryPayload,
  ): Promise<ClickUpTimeEntry> {
    const teamId = this.workspaces.getTeamId(workspaceId);
    const res: any = await this.request(
      "POST",
      workspaceId,
      `/team/${teamId}/time_entries`,
      payload,
    );
    return res.data;
  }

  async deleteTimeEntry(workspaceId: string, entryId: string): Promise<void> {
    const teamId = this.workspaces.getTeamId(workspaceId);
    await this.request("DELETE", workspaceId, `/team/${teamId}/time_entries/${entryId}`);
  }
}
