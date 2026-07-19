import type {
  ClickUpTaskLookupView,
  CreateMeetingRequest,
  CreateMeetingResponse,
  ConfirmRosterRequest,
  RunResponse,
  RunListView,
  RunStatus,
  FeedbackItem,
  SubmitFeedbackResponse,
  ChatHistoryResponse,
  SendChatResponse,
  RunSnapshotPayload,
  WorkspaceModels,
  WorkspaceTunables,
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

/**
 * The active workspace id (mirrors Clicksy's apps/web/src/api/client.ts pattern).
 * When set, `withActiveWorkspace()` auto-appends `?workspaceId=` to workspace-scoped
 * calls so non-default-workspace runs resolve instead of 404ing. The WorkspaceProvider
 * primes this synchronously (lazy state initializer) before gated children fetch.
 */
let activeWorkspaceId: string | null = null;
export function setActiveWorkspaceId(id: string | null) {
  activeWorkspaceId = id;
}

/** Response from POST /meetings/:id/roster — confirms roster, returns the run
 * to watch + a per-participant summary of what the roster-memory KB learned
 * (v2 Phase 7). `learned` is always present; zeros on legacy backends read
 * fine since every field is a plain number. */
export interface ConfirmRosterResponse {
  runId: string;
  learned: {
    kept: number;
    learned: number;
    corrected: number;
    blocklisted: number;
    skipped: number;
  };
}

// ── Roster memory KB browser (v2 Phase 7 PR-D) ────────────────────────
/** Provenance of a saved alias mapping. `admin_seeded` = manual create/edit
 * from the /kb Participants tab; other values come from roster confirmations. */
export type ParticipantAliasSource =
  | "user_confirmed"
  | "user_corrected"
  | "user_blocklisted"
  | "admin_seeded";

/** One row from GET /workspaces/:id/participant-aliases. `clickupName` is
 * joined server-side (all roles can read even if `/clickup/members` is Owner
 * /Admin gated); null = mapping points at a departed member OR blocklist row. */
export interface ParticipantAliasRow {
  id: string;
  workspaceId: string;
  alias: string;
  aliasRaw: string;
  clickupUserId: string | null;
  clickupName: string | null;
  source: ParticipantAliasSource;
  confirmations: number;
  lastSeenAt: string;
  createdAt: string;
  createdBy: string;
}

export interface ParticipantAliasesPage {
  rows: ParticipantAliasRow[];
  nextCursor: string | null;
  total: number;
}

export interface CreateParticipantAliasBody {
  aliasRaw: string;
  clickupUserId: string | null;
}
export interface UpdateParticipantAliasBody {
  aliasRaw?: string;
  clickupUserId?: string | null;
}
export interface BulkImportParticipantAliasBody {
  rows: Array<{ aliasRaw: string; clickupUserId?: string | null }>;
}
export interface BulkImportResult {
  imported: number;
  updated: number;
  skipped: number;
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

/** A client dropdown option (Phase 2c.3). */
export interface ClientOption {
  optionId: string;
  name: string;
}
/** A selectable sprint target list (Phase 2c.3). */
export interface SprintListOption {
  listId: string;
  name: string;
}

/** Stored per-workspace push config — GET/PUT /workspaces/:id/push-config. */
export interface PushConfigView {
  workspaceId: string;
  targetListId: string;
  targetListName: string | null;
  assignableMembers: AssignableMember[];
  defaultStatus: string | null;
  // Phase 2c.3 HITL fields (populated by refresh-fields).
  clientFieldId?: string | null;
  clientFieldName?: string | null;
  clientOptions?: ClientOption[];
  sprintLists?: SprintListOption[];
  pointsEnabled?: boolean;
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
  /**
   * The meeting's client, chosen on the upload screen (client-at-upload). The
   * push screen pre-fills each task's client from this. Null when the workspace
   * has no client field or none was chosen.
   */
  meetingClient: {
    clientOptionId: string | null;
    clientName: string | null;
  } | null;
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
  /** Phase 2c.3 — confirmed client dropdown option UUID. */
  clientOptionId?: string | null;
  /** Phase 2c.3 — confirmed sprint points. */
  points?: number | null;
}

/** GET /workspaces/:id/learning — the learning loop's "what we've learned". */
export type LearnField = "assignee" | "sprint";

export interface LearningCorrection {
  /** v2 Phase 3 — the field this pattern applies to. */
  field: LearnField;
  /** v2 Phase 3 — stable slug used on `/learning/patterns/:key/history`. */
  key: string;
  predicted: string;
  confirmed: string;
  count: number;
  agreement: number;
  gatePassed: boolean;
}
export interface LearningFieldSummary {
  field: LearnField;
  corrections: LearningCorrection[];
  rawOverrideRate: number | null;
  rawSample: number;
  nudgeAcceptanceRate: number | null;
  nudgeSample: number;
  unresolved: number;
}
export interface LearningSummary {
  totalOverrides: number;
  fields: LearningFieldSummary[];
}

/** v2 Phase 3 — GET /workspaces/:id/learning/gate — the loop's thresholds. */
export interface LearningGateView {
  minCorrections: number;
  minAgreement: number;
  nearGateThreshold: number;
  fields: LearnField[];
}

/** v2 Phase 3 — GET /workspaces/:id/learning/patterns/:key/history — one pattern's timeline. */
export interface LearningPatternHistoryEntry {
  runId: string;
  meetsyTaskId: string;
  createdAt: string;
  nudgeShown: boolean;
}
export interface LearningPatternHistoryView {
  key: string;
  field: LearnField;
  predicted: string;
  confirmed: string;
  count: number;
  agreement: number;
  gatePassed: boolean;
  entries: LearningPatternHistoryEntry[];
}

/** v2 Phase 3 — one message on the near-gate SSE channel. */
export interface LearningStreamEvent {
  workspaceId: string;
  field: LearnField;
  predicted: string;
  confirmed: string;
  count: number;
  at: number;
  kind: "near-gate" | "gate-passed";
}

/** v2 Phase 1 — GET /workspaces/:id/learning/me — per-user weekly digest. */
export interface LearningMeWeek {
  weekStart: string;
  overrides: number;
  agreements: number;
  nudgesShown: number;
  nudgesAccepted: number;
}
export interface LearningMeView {
  userId: string;
  totalOverrides: number;
  weeks: LearningMeWeek[];
}

/** Per-task outcome from POST /runs/:id/push. */
export interface PushResult {
  meetsyTaskId: string;
  status: PushStatus;
  clickupTaskId: string | null;
  clickupUrl: string | null;
  error: string | null;
}

// ── Knowledge-base onboarding (Meetsy KB) ──────────────────────────────
// Path-scoped under `/workspaces/:id/kb/*` (the `:id` is the workspaceId).
// Because the workspace is in the PATH, `withActiveWorkspace()` skips these
// (it bails on `/workspaces/` paths), so no duplicate `?workspaceId=` is added.

/** How far back the KB embeds mirrored tasks. */
export type KbRange = "3m" | "6m" | "12m" | "24m" | "36m" | "all";

/** GET /workspaces/:id/kb/tasks — one row per embedded ClickUp task (v2 Phase 4). */
export interface KbTaskRow {
  taskId: string;
  taskName: string;
  url: string | null;
  status: string | null;
  client: string | null;
  assigneesNames: string | null;
  updatedDate: string | null;
  chunkCount: number;
}
export interface KbTasksPage {
  tasks: KbTaskRow[];
  nextCursor: string | null;
  total: number;
}

/** GET /workspaces/:id/kb/search — one hit per matching KbChunk (hybrid RRF). */
export interface KbSearchHit {
  sourceId: string;
  score: number;
  snippet: string;
  metadata: {
    status: string | null;
    assignee: string | null;
    component: string | null;
    client: string | null;
    department: string | null;
    taskUpdatedAt: string | null;
  };
}

/** GET /workspaces/:id/kb/status — current onboarding/embedding state. */
export interface KbStatusView {
  status: "idle" | "onboarding" | "ready" | "error";
  embeddedCount: number;
  /** Whole-workspace task total — stays fixed, so embeddedCount < total after a narrow. */
  total: number;
  lastRunAt: string | null;
  /** The scope the current KB was embedded with (null = whole workspace in range). */
  scope: KbScope | null;
  /** The range the current KB was embedded with. Typed loosely; narrow to KbRange defensively. */
  range: string | null;
}

/** One SSE frame from the status stream. Terminal when status is ready|error. */
export interface KbProgressEvent {
  workspaceId: string;
  status: KbStatusView["status"];
  embedded: number;
  total: number;
  message: string;
  at: number;
}

/**
 * The distilled facts the KB learned. STRICT mirror of meetsy-api's
 * `src/kb/summary.types.ts` — JSON-native by construction (string | number |
 * boolean | null or plain arrays/objects of those). The backend produces this
 * from SQL (no LLM), so the shape is exact; render it as typed sections.
 */
export interface KbFacts {
  roster: RosterEntry[];
  components: ComponentEntry[];
  throughput: Throughput;
  categories: Categories;
  workload: WorkloadEntry[];
  blockers: Blockers;
  coverage: Coverage;
}

/** One distinct assignee + what they historically own. */
export interface RosterEntry {
  name: string;
  email: string | null;
  taskCount: number;
  openCount: number;
  closedCount: number;
  /** Top 3 components (list/folder/tag) this person appears on, by task volume. */
  topComponents: ComponentEntry[];
}

export interface ComponentEntry {
  component: string;
  taskCount: number;
}

/** Created vs closed per ISO week + open/closed totals + median cycle time. */
export interface Throughput {
  /** Last N ISO weeks, oldest→newest. `week` is the week-start `YYYY-MM-DD`. */
  weeks: ThroughputWeek[];
  openTotal: number;
  closedTotal: number;
  /** median(closed_date − created_date) in days over closed tasks; null if none. */
  medianCycleTimeDays: number | null;
}

export interface ThroughputWeek {
  week: string;
  created: number;
  closed: number;
}

export interface Categories {
  statusDistribution: CategoryBucket[];
  topTags: CategoryBucket[];
  clients: CategoryBucket[];
  departments: CategoryBucket[];
  sprints: CategoryBucket[];
}

export interface CategoryBucket {
  label: string;
  count: number;
}

export interface WorkloadEntry {
  user: string;
  hours: number;
}

export interface Blockers {
  overdueOpen: BlockerGroup;
  stale: BlockerGroup;
  reopened: BlockerGroup;
}

export interface BlockerGroup {
  count: number;
  samples: BlockerSample[];
}

export interface BlockerSample {
  taskId: string;
  taskName: string;
}

export interface Coverage {
  totalTasks: number;
  embeddedCount: number;
  dateRange: { earliest: string | null; latest: string | null };
  /** % of tasks whose comment sync completed (commentsSyncedAt set), 0–100. */
  commentCoveragePct: number;
}

/** GET /workspaces/:id/kb/summary — facts + an optional narrative paragraph. */
export interface KbSummaryView {
  facts: KbFacts;
  narrative: string | null;
  generatedAt: string;
}

/** One Clicksy-synced space available to scope the KB onboarding. */
export interface KbSpace {
  spaceId: string;
  name: string;
  enabled: boolean;
  taskCount: number;
}

/** GET /workspaces/:id/kb/spaces. */
export interface KbSpacesView {
  spaces: KbSpace[];
}

/** GET /workspaces/:id/kb/scope-options — distinct sub-scope values. */
export interface KbScopeOptions {
  folders: string[];
  lists: Array<{ listId: string; listName: string }>;
  clients: string[];
}

/** Optional narrowing for onboarding (omit empty arrays; omit the object if all empty). */
export interface KbScope {
  spaceIds?: string[];
  folderNames?: string[];
  listIds?: string[];
  clients?: string[];
}

/** Body for POST /workspaces/:id/kb/onboard. */
export interface KbOnboardBody {
  range: KbRange;
  scope?: KbScope;
}

/** One uploaded SOP/reference document row — GET /workspaces/:id/kb/documents. */
export interface KbDocumentRow {
  id: string;
  status?: string;
  filename?: string;
  name?: string;
  createdAt?: string;
  [key: string]: unknown;
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
/**
 * Auto-appends the active `workspaceId` to a workspace-scoped path, unless:
 *  - there's no active workspace yet,
 *  - the path already names a workspace explicitly (`workspaceId=`), or
 *  - it's a `/workspaces/:id/...` route where the id is in the path itself.
 */
function withActiveWorkspace(path: string): string {
  if (!activeWorkspaceId) return path;
  if (path.includes("workspaceId=")) return path; // already explicit
  if (path.startsWith("/workspaces/")) return path; // chosen-ws path route
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}workspaceId=${encodeURIComponent(activeWorkspaceId)}`;
}

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
    res = await fetch(`${API_URL}${withActiveWorkspace(path)}`, {
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

  // Some endpoints legitimately return an empty body with 200/204 — e.g.
  // push-config when a workspace has no saved config (Nest serializes a `null`
  // return as an EMPTY response, not the string "null"). Calling res.json() on
  // an empty body throws "Unexpected end of JSON input", which the caller would
  // surface as a spurious load error. Treat an empty body as null.
  if (res.status === 204) return null as T;
  const text = await res.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
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
   * GET /workspaces/:id/runs — paginated run history (newest first). Powers
   * v2 Phase 1's /home recent-runs card + /meetings history list.
   */
  listRuns(
    workspaceId: string,
    opts: { limit?: number; offset?: number; status?: RunStatus } = {},
  ): Promise<RunListView> {
    const qs = new URLSearchParams();
    if (opts.limit != null) qs.set("limit", String(opts.limit));
    if (opts.offset != null) qs.set("offset", String(opts.offset));
    if (opts.status) qs.set("status", opts.status);
    const q = qs.toString();
    return request<RunListView>(
      `/workspaces/${encodeURIComponent(workspaceId)}/runs${q ? `?${q}` : ""}`,
    );
  },

  /**
   * GET /workspaces/:id/runs/search — full-text search across meeting title +
   * transcript. Same RunListView shape as listRuns; empty `q` is a 400.
   */
  searchRuns(
    workspaceId: string,
    opts: { q: string; limit?: number; offset?: number; status?: RunStatus },
  ): Promise<RunListView> {
    const qs = new URLSearchParams();
    qs.set("q", opts.q);
    if (opts.limit != null) qs.set("limit", String(opts.limit));
    if (opts.offset != null) qs.set("offset", String(opts.offset));
    if (opts.status) qs.set("status", opts.status);
    return request<RunListView>(
      `/workspaces/${encodeURIComponent(workspaceId)}/runs/search?${qs.toString()}`,
    );
  },

  /**
   * Absolute URL for the SSE progress stream (consumed by EventSource).
   * The stream is now an authenticated route — the EventSource is created with
   * `{ withCredentials: true }` so the cookie is sent (see `useRunStream`).
   */
  runStreamUrl(runId: string): string {
    const base = `${API_URL}/runs/${encodeURIComponent(runId)}/stream`;
    return activeWorkspaceId
      ? `${base}?workspaceId=${encodeURIComponent(activeWorkspaceId)}`
      : base;
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

  /**
   * POST /runs/:id/push/retry — v2 Phase 2. Enqueue a retry for every `failed`
   * TaskPush row on this run (optionally filtered by task ids). Returns the
   * BullMQ job ids that were enqueued and, per-task, why anything was skipped
   * (`not_found` / `not_failed:<status>` / `enqueue_failed:<msg>`).
   */
  retryFailedPushes(
    runId: string,
    taskIds?: string[],
  ): Promise<{
    enqueued: string[];
    skipped: Array<{ meetsyTaskId: string; reason: string }>;
  }> {
    return request<{
      enqueued: string[];
      skipped: Array<{ meetsyTaskId: string; reason: string }>;
    }>(`/runs/${encodeURIComponent(runId)}/push/retry`, {
      method: "POST",
      body: JSON.stringify({ taskIds: taskIds ?? [] }),
    });
  },

  /**
   * GET /workspaces/:id/clickup/tasks/:taskId — resolve a ClickUp task id to
   * its title/status/assignee/url. Returns null (200) when the task isn't in
   * the workspace's read-only KB mirror — chips pointing at task ids that
   * predate onboarding legitimately return no metadata.
   */
  getClickupTask(
    workspaceId: string,
    taskId: string,
  ): Promise<ClickUpTaskLookupView | null> {
    return request<ClickUpTaskLookupView | null>(
      `/workspaces/${encodeURIComponent(workspaceId)}/clickup/tasks/${encodeURIComponent(taskId)}`,
    );
  },

  /** POST /workspaces/:id/push-config/refresh-fields — fetch client dropdown + sprint lists from ClickUp (Owner/Admin). */
  refreshPushFields(workspaceId: string): Promise<PushConfigView> {
    return request<PushConfigView>(
      `/workspaces/${encodeURIComponent(workspaceId)}/push-config/refresh-fields?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: "POST" },
    );
  },

  /** GET /workspaces/:id/learning — the learning loop's corrections + honest metrics. */
  getLearning(workspaceId: string): Promise<LearningSummary> {
    return request<LearningSummary>(
      `/workspaces/${encodeURIComponent(workspaceId)}/learning?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  },

  /** GET /workspaces/:id/learning/gate — the loop's thresholds (v2 Phase 3). */
  getLearningGate(workspaceId: string): Promise<LearningGateView> {
    return request<LearningGateView>(
      `/workspaces/${encodeURIComponent(workspaceId)}/learning/gate`,
    );
  },

  /**
   * GET /workspaces/:id/learning/patterns/:key/history — one pattern's timeline
   * (v2 Phase 3). `key` is the base64url-encoded slug the summary returned;
   * clients never construct it.
   */
  getLearningPatternHistory(
    workspaceId: string,
    key: string,
    opts: { limit?: number } = {},
  ): Promise<LearningPatternHistoryView> {
    const qs = new URLSearchParams();
    if (opts.limit != null) qs.set("limit", String(opts.limit));
    const q = qs.toString();
    return request<LearningPatternHistoryView>(
      `/workspaces/${encodeURIComponent(workspaceId)}/learning/patterns/${encodeURIComponent(key)}/history${q ? `?${q}` : ""}`,
    );
  },

  /**
   * Absolute URL for the near-gate SSE stream (v2 Phase 3). Consumed by
   * EventSource with `{ withCredentials: true }` inside `useLearningStream`.
   * Path-scoped to `/workspaces/:id/learning/stream` — no `?workspaceId=` query.
   */
  learningStreamUrl(workspaceId: string): string {
    return `${API_URL}/workspaces/${encodeURIComponent(workspaceId)}/learning/stream`;
  },

  /**
   * GET /workspaces/:id/learning/me — per-user weekly digest. Powers /home's
   * "Learning digest" card. Always returns 6 zero-padded weeks.
   */
  getLearningMe(workspaceId: string): Promise<LearningMeView> {
    return request<LearningMeView>(
      `/workspaces/${encodeURIComponent(workspaceId)}/learning/me`,
    );
  },

  // ── Knowledge-base onboarding (Meetsy KB) ─────────────────────────────
  // All path-scoped (`/workspaces/:id/kb/*`); the workspace lives in the path.

  /** GET /workspaces/:id/kb/status — onboarding/embedding state (any authed). */
  kbStatus(ws: string): Promise<KbStatusView> {
    return request<KbStatusView>(
      `/workspaces/${encodeURIComponent(ws)}/kb/status`,
    );
  },

  /** POST /workspaces/:id/kb/onboard — start embedding (Owner/Admin). */
  kbOnboard(ws: string, body: KbOnboardBody): Promise<KbStatusView> {
    return request<KbStatusView>(
      `/workspaces/${encodeURIComponent(ws)}/kb/onboard`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },

  /**
   * Absolute URL for the KB status SSE stream (consumed by EventSource with
   * `{ withCredentials: true }`). Path-scoped — NO `?workspaceId=` query.
   */
  kbStatusStreamUrl(ws: string): string {
    return `${API_URL}/workspaces/${encodeURIComponent(ws)}/kb/status/stream`;
  },

  /**
   * GET /workspaces/:id/kb/tasks — paginated embedded-task list (v2 Phase 4).
   * `cursor` opaque, `filter` narrows on task name / client / assignee (ILIKE).
   */
  kbTasks(
    ws: string,
    opts: { cursor?: string; filter?: string; limit?: number } = {},
  ): Promise<KbTasksPage> {
    const qs = new URLSearchParams();
    if (opts.cursor) qs.set("cursor", opts.cursor);
    if (opts.filter) qs.set("filter", opts.filter);
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<KbTasksPage>(
      `/workspaces/${encodeURIComponent(ws)}/kb/tasks${suffix}`,
    );
  },

  /**
   * GET /workspaces/:id/kb/search?q=…&k=… — hybrid (vector + FTS) search over
   * `clickup_task` chunks (any authed).
   */
  kbSearch(ws: string, q: string, k = 10): Promise<KbSearchHit[]> {
    const qs = new URLSearchParams({ q });
    if (k !== 10) qs.set("k", String(k));
    return request<KbSearchHit[]>(
      `/workspaces/${encodeURIComponent(ws)}/kb/search?${qs.toString()}`,
    );
  },

  /** GET /workspaces/:id/kb/summary — distilled facts + narrative (any authed). */
  kbSummary(ws: string, refresh = false): Promise<KbSummaryView> {
    return request<KbSummaryView>(
      `/workspaces/${encodeURIComponent(ws)}/kb/summary${refresh ? "?refresh=1" : ""}`,
    );
  },

  /** GET /workspaces/:id/kb/spaces — Clicksy-synced spaces (any authed). */
  kbSpaces(ws: string): Promise<KbSpacesView> {
    return request<KbSpacesView>(
      `/workspaces/${encodeURIComponent(ws)}/kb/spaces`,
    );
  },

  /** GET /workspaces/:id/kb/scope-options — distinct sub-scope values (any authed). */
  kbScopeOptions(ws: string, spaceIds?: string[]): Promise<KbScopeOptions> {
    const csv = (spaceIds ?? []).map(encodeURIComponent).join(",");
    return request<KbScopeOptions>(
      `/workspaces/${encodeURIComponent(ws)}/kb/scope-options${csv ? `?spaceIds=${csv}` : ""}`,
    );
  },

  /** GET /workspaces/:id/kb/documents — uploaded SOP/reference docs. */
  kbListDocuments(ws: string): Promise<KbDocumentRow[]> {
    return request<KbDocumentRow[]>(
      `/workspaces/${encodeURIComponent(ws)}/kb/documents`,
    );
  },

  /** DELETE /workspaces/:id/kb/documents/:docId (Owner/Admin). */
  kbDeleteDocument(ws: string, docId: string): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>(
      `/workspaces/${encodeURIComponent(ws)}/kb/documents/${encodeURIComponent(docId)}`,
      { method: "DELETE" },
    );
  },

  /**
   * POST /workspaces/:id/kb/documents — multipart upload (Owner/Admin).
   *
   * Dedicated helper, NOT through `request()`: that wrapper hardcodes
   * `Content-Type: application/json`, which would corrupt the multipart body.
   * Here the browser sets `multipart/form-data` + boundary itself (we MUST NOT
   * set Content-Type). We still send the cookie (`credentials: include`) and the
   * CSRF double-submit header, and centralize the 401 → Clicksy-login handoff.
   */
  async kbUploadDocument(
    ws: string,
    file: File,
  ): Promise<{ id: string; status: string; deduped: boolean }> {
    const form = new FormData();
    form.append("file", file);

    const headers: Record<string, string> = {};
    const csrf = getCsrfToken();
    if (csrf) headers["x-csrf-token"] = csrf;

    let res: Response;
    try {
      res = await fetch(
        `${API_URL}/workspaces/${encodeURIComponent(ws)}/kb/documents`,
        { method: "POST", body: form, credentials: "include", headers },
      );
    } catch {
      throw new ApiError(
        `Cannot reach the API at ${API_URL}. Is it running?`,
        0,
      );
    }

    if (res.status === 401) {
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
        // body wasn't JSON
      }
      throw new ApiError(
        detail || `Upload failed (${res.status} ${res.statusText})`,
        res.status,
      );
    }
    return (await res.json()) as {
      id: string;
      status: string;
      deduped: boolean;
    };
  },

  // ── v2 Phase 5: /tuning (per-workspace ML config) ──────────────────────
  /** GET /workspaces/:id/ml-config — reads current tunables + models (any authed). */
  mlConfigGet(ws: string): Promise<WorkspaceMlConfigView> {
    return request<WorkspaceMlConfigView>(
      `/workspaces/${encodeURIComponent(ws)}/ml-config`,
    );
  },

  /** PUT /workspaces/:id/ml-config — persists Owner-supplied tunables + models. */
  mlConfigPut(
    ws: string,
    body: RunSnapshotPayload,
  ): Promise<WorkspaceMlConfigView> {
    return request<WorkspaceMlConfigView>(
      `/workspaces/${encodeURIComponent(ws)}/ml-config`,
      { method: "PUT", body: JSON.stringify(body) },
    );
  },

  /** POST /workspaces/:id/ml-config/preview — replay last N runs against candidate. */
  mlConfigPreview(
    ws: string,
    body: RunSnapshotPayload,
    limit?: number,
  ): Promise<MlConfigPreviewView> {
    const qs = limit !== undefined ? `?limit=${limit}` : "";
    return request<MlConfigPreviewView>(
      `/workspaces/${encodeURIComponent(ws)}/ml-config/preview${qs}`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },

  // ── Roster memory KB browser (v2 Phase 7 PR-D) ────────────────────────

  /** GET /workspaces/:id/participant-aliases — paginated KB rows (any authed). */
  listParticipantAliases(
    ws: string,
    opts: { cursor?: string; filter?: string; limit?: number } = {},
  ): Promise<ParticipantAliasesPage> {
    const qs = new URLSearchParams();
    if (opts.cursor) qs.set("cursor", opts.cursor);
    if (opts.filter) qs.set("filter", opts.filter);
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<ParticipantAliasesPage>(
      `/workspaces/${encodeURIComponent(ws)}/participant-aliases${suffix}`,
    );
  },

  /** POST /workspaces/:id/participant-aliases — seed/overwrite (Owner/Admin). */
  createParticipantAlias(
    ws: string,
    body: CreateParticipantAliasBody,
  ): Promise<ParticipantAliasRow> {
    return request<ParticipantAliasRow>(
      `/workspaces/${encodeURIComponent(ws)}/participant-aliases`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },

  /** PATCH /workspaces/:id/participant-aliases/:aliasId — edit (Owner/Admin). */
  updateParticipantAlias(
    ws: string,
    aliasId: string,
    body: UpdateParticipantAliasBody,
  ): Promise<ParticipantAliasRow> {
    return request<ParticipantAliasRow>(
      `/workspaces/${encodeURIComponent(ws)}/participant-aliases/${encodeURIComponent(aliasId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    );
  },

  /** DELETE /workspaces/:id/participant-aliases/:aliasId — remove (Owner/Admin). */
  deleteParticipantAlias(
    ws: string,
    aliasId: string,
  ): Promise<{ ok: true }> {
    return request<{ ok: true }>(
      `/workspaces/${encodeURIComponent(ws)}/participant-aliases/${encodeURIComponent(aliasId)}`,
      { method: "DELETE" },
    );
  },

  /** POST /workspaces/:id/participant-aliases/bulk-import — CSV batch (Owner/Admin). */
  bulkImportParticipantAliases(
    ws: string,
    body: BulkImportParticipantAliasBody,
  ): Promise<BulkImportResult> {
    return request<BulkImportResult>(
      `/workspaces/${encodeURIComponent(ws)}/participant-aliases/bulk-import`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
};

// ── v2 Phase 5 view types (mirror apps/meetsy-api/src/tuning/*.ts) ────────
export interface WorkspaceMlConfigView {
  tunables: WorkspaceTunables;
  models: WorkspaceModels;
  updatedBy: string | null;
  updatedAt: string | null;
  isDefault: boolean;
}

export interface MlConfigPreviewRun {
  runId: string;
  meetingTitle: string | null;
  meetingDate: string | null;
  taskCount: number;
  duplicates: {
    baseline: { flag: number; suggest: number };
    candidate: { flag: number; suggest: number };
    changed: number;
  } | null;
}

export interface MlConfigPreviewView {
  runs: MlConfigPreviewRun[];
  gate: {
    baseline: { patternsGating: number; patternsNearGate: number };
    candidate: { patternsGating: number; patternsNearGate: number };
  };
  skipped: Array<{ field: string; reason: string }>;
}

export { ApiError };
