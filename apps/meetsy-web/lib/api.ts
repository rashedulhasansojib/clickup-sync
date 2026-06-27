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
};

export { ApiError };
