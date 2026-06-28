import { Injectable, Logger } from "@nestjs/common";
import { Observable } from "rxjs";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "../config/config.service";
import { createRedis } from "../analysis/queue/redis";
import { ClicksyAdminClient } from "./clicksy-admin.client";
import { KbProgressEvent, KbQueue, kbChannel } from "./kb.queue";
import { hasCoverageGap, lookbackDaysForRange, type KbRange, type KbScope } from "./kb.dto";

/** The queue name Clicksy logs space backfills under (Clicksy QUEUES constant). */
const CLICKSY_BACKFILL_QUEUE = "clickup-backfills";

export interface KbStatusView {
  status: string;
  embeddedCount: number;
  // NOTE: `total` stays whole-workspace/unscoped (count of all non-deleted mirrored
  // tasks), so after onboarding to a NARROW scope `embeddedCount < total` is EXPECTED,
  // not a bug — the embed only covers the declared scope while total counts everything.
  total: number;
  lastRunAt: string | null;
  // The currently-persisted onboarding scope filter (null = whole-workspace / no
  // sub-filter) and range preset, so the settings UI can re-hydrate the last run.
  scope: KbScope | null;
  range: string | null;
}

/** One row of GET /kb/spaces — a configured space + how much is mirrored so far. */
export interface KbSpaceView {
  spaceId: string;
  name: string;
  enabled: boolean;
  taskCount: number;
}

/** GET /kb/scope-options — the distinct sub-filter values for the chosen spaces. */
export interface KbScopeOptionsView {
  folders: string[];
  lists: Array<{ listId: string; listName: string }>;
  clients: string[];
}

const SCOPE_AXES = ["spaceIds", "folderNames", "listIds", "clients"] as const;

/**
 * Canonical, comparable form of a scope filter for the cursor-reset decision.
 * Treats undefined/null/`{}` and empty-array axes as equivalent ("no filter"),
 * and sorts each axis so reordering the same selection is NOT a change. Stored
 * SQL-null (pre-migration rows) reads back as `null` and normalizes to `{}`.
 */
export function canonicalScope(scope: unknown): string {
  const s = (scope ?? {}) as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const axis of SCOPE_AXES) {
    const v = s[axis];
    if (Array.isArray(v) && v.length > 0) out[axis] = [...v].map(String).sort();
  }
  return JSON.stringify(out);
}

/** Trim, drop empties, dedupe (case-sensitively) and sort alphabetically. */
function uniqueSorted(values: Array<string | null>): string[] {
  const set = new Set<string>();
  for (const v of values) {
    const t = v?.trim();
    if (t) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Orchestrates KB onboarding's HTTP-facing entry + the (slow) coverage step.
 *
 * onboard() responds fast: it marks the workspace `onboarding` and enqueues the
 * job. The WORKER then calls ensureCoverage() (which may trigger a Clicksy
 * backfill + poll for minutes) before embedding — keeping the heavy/slow work
 * off the request path, mirroring AnalysisService.confirmRoster() → worker.
 */
@Injectable()
export class KbOnboardingService {
  private readonly logger = new Logger(KbOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clicksy: ClicksyAdminClient,
    private readonly queue: KbQueue,
    private readonly config: ConfigService,
  ) {}

  /** POST /workspaces/:id/kb/onboard — mark onboarding + enqueue (fast). */
  async onboard(workspaceId: string, range: KbRange, scope?: KbScope): Promise<KbStatusView> {
    const existing = await this.prisma.kbSyncState.findUnique({ where: { workspaceId } });
    // If the requested (range, scope) differs from what was last persisted, reset
    // the keyset cursor so the worker re-scans from windowStart(range). Otherwise a
    // newly-added space's history (older than the current cursor) would be skipped.
    const changed =
      !existing ||
      (existing.range ?? null) !== range ||
      canonicalScope(existing.scope) !== canonicalScope(scope);
    const scopeValue: Prisma.InputJsonValue | typeof Prisma.DbNull = scope
      ? (scope as Prisma.InputJsonValue)
      : Prisma.DbNull;
    await this.prisma.kbSyncState.upsert({
      where: { workspaceId },
      create: { workspaceId, status: "onboarding", lastRunAt: new Date(), range, scope: scopeValue },
      update: {
        status: "onboarding",
        lastRunAt: new Date(),
        range,
        scope: scopeValue,
        ...(changed ? { lastTaskCursor: null } : {}),
      },
    });
    await this.queue.enqueue({ workspaceId, range, scope });
    return this.status(workspaceId);
  }

  /**
   * GET /workspaces/:id/kb/spaces — the spaces Clicksy is configured to sync for
   * this workspace, each with the count of non-deleted mirrored tasks (so the UI
   * can honestly show "0 tasks mirrored yet"). Returns ALL configured spaces,
   * including disabled ones, exposing the `enabled` flag.
   */
  async listSpaces(workspaceId: string): Promise<{ spaces: KbSpaceView[] }> {
    const [spaces, counts] = await Promise.all([
      this.prisma.workspaceSpace.findMany({
        where: { workspaceId },
        select: { spaceId: true, name: true, enabled: true },
        orderBy: { name: "asc" },
      }),
      this.prisma.clickupTask.groupBy({
        by: ["spaceId"],
        where: { workspaceId, isDeleted: false },
        _count: { _all: true },
      }),
    ]);
    const countBySpace = new Map<string, number>();
    for (const c of counts) {
      if (c.spaceId) countBySpace.set(c.spaceId, c._count._all);
    }
    return {
      spaces: spaces.map((s) => ({
        spaceId: s.spaceId,
        name: s.name,
        enabled: s.enabled,
        taskCount: countBySpace.get(s.spaceId) ?? 0,
      })),
    };
  }

  /**
   * GET /workspaces/:id/kb/scope-options — distinct sub-filter values from the
   * mirrored tasks, scoped to the workspace and (if provided) the given spaces.
   * `folders` = distinct folder NAMEs; `lists` = distinct (listId, listName);
   * `clients` = distinct client NAMEs. Nulls/empties dropped, each sorted.
   */
  async scopeOptions(workspaceId: string, spaceIds?: string[]): Promise<KbScopeOptionsView> {
    const where: Prisma.ClickupTaskWhereInput = {
      workspaceId,
      isDeleted: false,
      ...(spaceIds?.length ? { spaceId: { in: spaceIds } } : {}),
    };
    const [folderRows, listRows, clientRows] = await Promise.all([
      this.prisma.clickupTask.findMany({ where, select: { folderName: true }, distinct: ["folderName"] }),
      this.prisma.clickupTask.findMany({
        where,
        select: { listId: true, listName: true },
        distinct: ["listId", "listName"],
      }),
      this.prisma.clickupTask.findMany({ where, select: { client: true }, distinct: ["client"] }),
    ]);
    // Contract: distinct (listId, listName) pairs. The DB `distinct` already gives
    // the pairs; just drop rows missing either side and sort by name.
    const lists = listRows
      .filter((r): r is { listId: string; listName: string } => !!r.listId && !!r.listName?.trim())
      .map((r) => ({ listId: r.listId, listName: r.listName.trim() }))
      .sort((a, b) => a.listName.localeCompare(b.listName));
    return {
      folders: uniqueSorted(folderRows.map((r) => r.folderName)),
      lists,
      clients: uniqueSorted(clientRows.map((r) => r.client)),
    };
  }

  /** GET /workspaces/:id/kb/status. */
  async status(workspaceId: string): Promise<KbStatusView> {
    const [state, total] = await Promise.all([
      this.prisma.kbSyncState.findUnique({ where: { workspaceId } }),
      this.prisma.clickupTask.count({ where: { workspaceId, isDeleted: false } }),
    ]);
    return {
      status: state?.status ?? "idle",
      embeddedCount: state?.embeddedCount ?? 0,
      total,
      lastRunAt: state?.lastRunAt ? state.lastRunAt.toISOString() : null,
      scope: (state?.scope as KbScope | null) ?? null,
      range: state?.range ?? null,
    };
  }

  /**
   * GET /workspaces/:id/kb/status/stream — optional SSE of onboarding progress.
   * Subscribes to the worker's Redis progress channel; completes when the run
   * reaches a terminal state. Mirrors AnalysisService.streamRun (lean variant).
   */
  streamProgress(workspaceId: string): Observable<{ data: KbProgressEvent }> {
    return new Observable<{ data: KbProgressEvent }>((subscriber) => {
      const { host, port } = this.config.redis;
      const redis = createRedis(host, port);
      redis.on("message", (_channel, payload) => {
        try {
          const event = JSON.parse(payload) as KbProgressEvent;
          subscriber.next({ data: event });
          if (event.status === "ready" || event.status === "error") subscriber.complete();
        } catch {
          this.logger.warn(`Dropping malformed KB progress event on ${kbChannel(workspaceId)}`);
        }
      });
      void redis.subscribe(kbChannel(workspaceId)).then(async () => {
        // Late-subscriber catch-up: if already terminal, emit + complete.
        const state = await this.prisma.kbSyncState.findUnique({ where: { workspaceId } });
        if (state && (state.status === "ready" || state.status === "error")) {
          subscriber.next({
            data: {
              workspaceId,
              status: state.status,
              embedded: state.embeddedCount,
              total: state.embeddedCount,
              message: `Onboarding ${state.status}`,
              at: Date.now(),
            },
          });
          subscriber.complete();
        }
      });
      return () => redis.disconnect();
    });
  }

  /**
   * Coverage check (worker-side): for each of the workspace's spaces, if Clicksy
   * has mirrored a narrower window than requested, trigger a task + comment
   * backfill, then poll until they drain. Degrades to a no-op when Clicksy admin
   * is unconfigured/unreachable so onboarding embeds whatever IS mirrored.
   */
  async ensureCoverage(workspaceId: string, range: KbRange, scope?: KbScope): Promise<void> {
    const requestedDays = lookbackDaysForRange(range);
    // Coverage/backfill stays PER-SPACE: only `spaceIds` narrows it. The other
    // sub-filters (folderNames/listIds/clients) intentionally do NOT touch backfill
    // — they only filter what gets embedded (see KbProcessor.scopeWhere).
    const spaces = await this.prisma.workspaceSpace.findMany({
      where: {
        workspaceId,
        enabled: true,
        ...(scope?.spaceIds?.length ? { spaceId: { in: scope.spaceIds } } : {}),
      },
      select: { spaceId: true },
    });
    if (spaces.length === 0) {
      this.logger.log(`No spaces configured for workspace ${workspaceId}; skipping coverage check`);
      return;
    }
    if (!this.clicksy.isConfigured) {
      this.logger.warn(
        `Clicksy admin not configured (CLICKSY_ADMIN_URL / ADMIN_API_KEY); embedding already-mirrored data only`,
      );
      return;
    }

    const gappy: string[] = [];
    for (const { spaceId } of spaces) {
      const mirroredDays = await this.mirroredDaysForSpace(workspaceId, spaceId);
      if (hasCoverageGap(requestedDays, mirroredDays)) gappy.push(spaceId);
    }
    if (gappy.length === 0) {
      this.logger.log(`Workspace ${workspaceId} already covers the requested ${requestedDays}d window`);
      return;
    }

    this.logger.log(`Triggering Clicksy backfill for ${gappy.length} space(s): ${gappy.join(", ")}`);
    let triggered = false;
    // Clicksy's backfill caps lookbackDays at 3650; the "all" range (36_500) and any
    // value above the cap must be clamped or Clicksy rejects with 400. The KB's own
    // embed window is unaffected (it embeds whatever ends up mirrored).
    const backfillDays = Math.min(requestedDays, 3650);
    for (const spaceId of gappy) {
      const t = await this.clicksy.triggerTaskBackfill(workspaceId, spaceId, backfillDays);
      const c = await this.clicksy.triggerCommentBackfill(workspaceId, spaceId);
      triggered = triggered || t || c;
    }
    // Wait only until tasks are mirrored; let time-entry sync continue async in
    // Clicksy (the embed doesn't need it). See pollUntilTasksFetched.
    if (triggered) await this.clicksy.pollUntilTasksFetched(workspaceId);
  }

  /**
   * Widest backfill lookback (days) Clicksy has COMPLETED for a space — read from
   * its `sync_job_logs` (queue `clickup-backfills`, entity `space`). 0 if none.
   * The DB shape is live-verified by the orchestrator; the gap decision math
   * (`hasCoverageGap`) is unit-tested.
   */
  private async mirroredDaysForSpace(workspaceId: string, spaceId: string): Promise<number> {
    const rows = await this.prisma.syncJobLog.findMany({
      where: {
        workspaceId,
        queueName: CLICKSY_BACKFILL_QUEUE,
        entityType: "space",
        entityId: spaceId,
        status: "completed",
      },
      select: { payload: true },
    });
    let max = 0;
    for (const r of rows) {
      const days = (r.payload as { lookbackDays?: unknown } | null)?.lookbackDays;
      if (typeof days === "number" && days > max) max = days;
    }
    return max;
  }
}
