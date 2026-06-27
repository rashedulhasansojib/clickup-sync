import type {
  CreateMeetingRequest,
  CreateMeetingResponse,
  ConfirmRosterRequest,
  RunResponse,
  FeedbackItem,
  SubmitFeedbackResponse,
  ChatHistoryResponse,
  SendChatResponse,
} from "@ma/shared";
import {
  getCsrfToken,
  redirectToClicksyLogin,
  type AuthPrincipal,
} from "./auth";

/**
 * Typed HTTP client for the NestJS API. All shapes come from `@ma/shared`
 * (the single source of truth) — we never redefine domain types here.
 *
 * Auth (Phase 0): the shared HTTP-only `clickup_sync_sid` cookie. Every request
 * sends `credentials: 'include'`; mutating verbs add the `x-csrf-token`
 * double-submit header. A 401 from ANY call redirects to Clicksy's login —
 * there are no client-side tokens to refresh.
 */

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Verbs that require the CSRF double-submit header (mirrors the backend). */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Response from POST /meetings/:id/roster — confirms roster, returns the run to watch. */
export interface ConfirmRosterResponse {
  runId: string;
}

// ── ClickUp write-back (Phase 1) ───────────────────────────────────────
// Shapes mirror meetsy-api's clickup controllers/DTOs exactly. They live here
// (not @ma/shared) because the backend keeps them local to meetsy-api too.

/** One org workspace — GET /workspaces. Default first. */
export interface WorkspaceListItem {
  id: string;
  name: string;
  isDefault: boolean;
}

/** A picker-ready assignable member (mirror of meetsy-api `AssignableMember`). */
export interface AssignableMember {
  clickupUserId: string;
  name: string;
  email?: string;
}

/** Stored per-workspace push config — GET/PUT /workspaces/:id/push-config. */
export interface PushConfigView {
  workspaceId: string;
  targetListId: string;
  targetListName: string | null;
  assignableMembers: AssignableMember[];
  defaultStatus: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

/** Body for PUT /workspaces/:id/push-config (Owner/Admin). */
export interface PutPushConfigBody {
  targetListId: string;
  targetListName?: string | null;
  assignableMembers: AssignableMember[];
  defaultStatus?: string | null;
}

/** ClickUp space → folder → list tree nodes — GET /clickup/lists. */
export interface ClickUpListNode {
  id: string;
  name: string;
}
export interface ClickUpFolderNode {
  id: string;
  name: string;
  lists: ClickUpListNode[];
}
export interface ClickUpSpaceNode {
  id: string;
  name: string;
  folders: ClickUpFolderNode[];
  /** Lists that live directly in the space (no folder). */
  lists: ClickUpListNode[];
}

export type PushStatus = "pushed" | "failed" | "skipped";

/** One audit row from `meetsy.TaskPush` — GET /runs/:id/push. */
export interface PushAuditRow {
  meetsyTaskId: string;
  status: PushStatus;
  clickupTaskId: string | null;
  clickupUrl: string | null;
  error: string | null;
  createdAt: string;
}

/** Pre-resolved assignee suggestion for a task — GET /runs/:id/push. */
export interface AssigneeSuggestion {
  meetsyTaskId: string;
  assigneeName: string | null;
  suggestedClickupUserId: string | null;
}

/** GET /runs/:id/push — config + per-task audit + assignee suggestions. */
export interface RunPushStatus {
  config: PushConfigView | null;
  pushes: PushAuditRow[];
  suggestions: AssigneeSuggestion[];
}

/** One (edited, human-confirmed) task to push — body of POST /runs/:id/push. */
export interface PushTaskInput {
  meetsyTaskId: string;
  /** Per-task list override; defaults to the workspace target list. */
  listId?: string;
  /** Confirmed ClickUp assignee from the allowlist; null = unassigned. */
  clickupUserId?: string | null;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  evidence?: Array<{
    quote: string;
    speaker?: string | null;
    timestamp?: string | null;
  }>;
  priority: "urgent" | "high" | "normal" | "low";
  dueDate?: string | null;
  tags?: string[];
  subtasks?: string[];
  dependencies?: string[];
}

/** Per-task outcome from POST /runs/:id/push. */
export interface PushResult {
  meetsyTaskId: string;
  status: PushStatus;
  clickupTaskId: string | null;
  clickupUrl: string | null;
  error: string | null;
}

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Single fetch wrapper for every API call.
 *  - `credentials: 'include'` so the `clickup_sync_sid` cookie rides along.
 *  - On mutating verbs, sets `x-csrf-token` from the non-HTTP-only `csrf` cookie.
 *  - On 401 (no/stale session), redirects to Clicksy's login and throws — this
 *    is the single, centralized place that handles an unauthenticated response.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (MUTATING_METHODS.has(method)) {
    const csrf = getCsrfToken();
    if (csrf) headers["x-csrf-token"] = csrf;
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: "include",
      headers,
    });
  } catch {
    throw new ApiError(`Cannot reach the API at ${API_URL}. Is it running?`, 0);
  }

  if (res.status === 401) {
    // No valid session — hand off to Clicksy's login. The throw unwinds the
    // caller; callers (e.g. the auth gate) should swallow it as the page is
    // already navigating away. Do NOT redirect again from the caller.
    redirectToClicksyLogin();
    throw new ApiError("Not authenticated — redirecting to sign in…", 401);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string | string[] };
      detail = Array.isArray(body.message)
        ? body.message.join(", ")
        : (body.message ?? "");
    } catch {
      // body wasn't JSON; fall back to status text
    }
    throw new ApiError(
      detail || `Request failed (${res.status} ${res.statusText})`,
      res.status,
    );
  }

  return (await res.json()) as T;
}

export const api = {
  /** GET /auth/me — the authenticated principal (401 → redirect to Clicksy login). */
  me(): Promise<AuthPrincipal> {
    return request<AuthPrincipal>("/auth/me");
  },

  /** POST /meetings — upload transcript, get meeting + extracted roster + queued run. */
  createMeeting(body: CreateMeetingRequest): Promise<CreateMeetingResponse> {
    return request<CreateMeetingResponse>("/meetings", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** POST /meetings/:id/roster — confirm/edit roster, kick off analysis. */
  confirmRoster(
    meetingId: string,
    body: ConfirmRosterRequest,
  ): Promise<ConfirmRosterResponse> {
    return request<ConfirmRosterResponse>(
      `/meetings/${encodeURIComponent(meetingId)}/roster`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },

  /** GET /runs/:id — poll run status + result. */
  getRun(runId: string): Promise<RunResponse> {
    return request<RunResponse>(`/runs/${encodeURIComponent(runId)}`);
  },

  /**
   * Absolute URL for the SSE progress stream (consumed by EventSource).
   * The stream is now an authenticated route — the EventSource is created with
   * `{ withCredentials: true }` so the cookie is sent (see `useRunStream`).
   */
  runStreamUrl(runId: string): string {
    return `${API_URL}/runs/${encodeURIComponent(runId)}/stream`;
  },

  /** POST /runs/:id/feedback — submit per-task 👍/👎 (+ optional comments). */
  submitFeedback(
    runId: string,
    items: FeedbackItem[],
  ): Promise<SubmitFeedbackResponse> {
    return request<SubmitFeedbackResponse>(
      `/runs/${encodeURIComponent(runId)}/feedback`,
      {
        method: "POST",
        body: JSON.stringify({ items }),
      },
    );
  },

  /** GET /runs/:id/chat — fetch chat history for a run. */
  getChat(runId: string): Promise<ChatHistoryResponse> {
    return request<ChatHistoryResponse>(
      `/runs/${encodeURIComponent(runId)}/chat`,
    );
  },

  /** POST /runs/:id/chat — send a message; may recover/revise tasks. */
  sendChat(runId: string, message: string): Promise<SendChatResponse> {
    return request<SendChatResponse>(
      `/runs/${encodeURIComponent(runId)}/chat`,
      {
        method: "POST",
        body: JSON.stringify({ message }),
      },
    );
  },

  // ── ClickUp write-back (Phase 1) ─────────────────────────────────────

  /** GET /workspaces — org workspaces for the push-config picker (default first). */
  listWorkspaces(): Promise<WorkspaceListItem[]> {
    return request<WorkspaceListItem[]>("/workspaces");
  },

  /** GET /workspaces/:id/push-config — current config (null if unset). */
  getPushConfig(workspaceId: string): Promise<PushConfigView | null> {
    return request<PushConfigView | null>(
      `/workspaces/${encodeURIComponent(workspaceId)}/push-config`,
    );
  },

  /** PUT /workspaces/:id/push-config — set target list + members (Owner/Admin). */
  putPushConfig(
    workspaceId: string,
    body: PutPushConfigBody,
  ): Promise<PushConfigView> {
    return request<PushConfigView>(
      `/workspaces/${encodeURIComponent(workspaceId)}/push-config`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    );
  },

  /** GET /clickup/lists — space→folder→list tree for the target picker (Owner/Admin). */
  getClickUpLists(
    workspaceId: string,
  ): Promise<{ spaces: ClickUpSpaceNode[] }> {
    return request<{ spaces: ClickUpSpaceNode[] }>(
      `/clickup/lists?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  },

  /** GET /clickup/members — assignable members for the checklist (Owner/Admin). */
  getClickUpMembers(
    workspaceId: string,
  ): Promise<{ members: AssignableMember[] }> {
    return request<{ members: AssignableMember[] }>(
      `/clickup/members?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  },

  /** GET /runs/:id/push — push config + audit rows + assignee suggestions. */
  getRunPush(runId: string): Promise<RunPushStatus> {
    return request<RunPushStatus>(
      `/runs/${encodeURIComponent(runId)}/push`,
    );
  },

  /** POST /runs/:id/push — push the edited tasks; idempotent per task. */
  pushRun(
    runId: string,
    tasks: PushTaskInput[],
  ): Promise<{ results: PushResult[] }> {
    return request<{ results: PushResult[] }>(
      `/runs/${encodeURIComponent(runId)}/push`,
      {
        method: "POST",
        body: JSON.stringify({ tasks }),
      },
    );
  },
};

export { ApiError };
