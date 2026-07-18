"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { api, type LearningStreamEvent } from "./api";

/**
 * v2 Phase 3 (PR-N) — subscribe to the workspace's near-gate / gate-passed
 * SSE stream and surface a Sonner toast when an event lands. Kept OUTSIDE
 * `useLearning`-style pages so it can mount workspace-wide (inside AppShell)
 * and fire toasts wherever the user is — including mid-push, when the
 * threshold-crossing actually happens.
 *
 * `withCredentials: true` sends the shared `clickup_sync_sid` cookie. Same
 * 401-fallback caveat as `useRunStream` (EventSource surfaces no status
 * code); the ordinary API-fetch paths still handle expired sessions.
 */
export function useLearningStream(workspaceId: string | null): void {
  useEffect(() => {
    if (!workspaceId) return;
    const es = new EventSource(api.learningStreamUrl(workspaceId), {
      withCredentials: true,
    });

    es.onmessage = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as LearningStreamEvent;
        renderToast(event);
      } catch {
        // ignore malformed frames (keep-alives, etc.)
      }
    };

    // EventSource auto-reconnects; silent errors are fine here — a missed
    // toast is harmless (the /learning page re-derives from the summary).
    es.onerror = () => {
      /* noop */
    };

    return () => {
      es.close();
    };
  }, [workspaceId]);
}

function renderToast(event: LearningStreamEvent): void {
  const label = fieldLabel(event.field);
  const pattern = `${event.predicted} → ${event.confirmed}`;
  if (event.kind === "near-gate") {
    toast(`One more correction and ${label} “${pattern}” will start nudging.`, {
      description: `Loop status: ${event.count} of 3 corrections logged.`,
      duration: 8000,
    });
  } else if (event.kind === "gate-passed") {
    toast.success(`Loop learned ${label}: ${pattern}`, {
      description: `Future runs will suggest ${event.confirmed} whenever the model predicts ${event.predicted}.`,
      duration: 10000,
    });
  }
}

function fieldLabel(field: LearningStreamEvent["field"]): string {
  switch (field) {
    case "assignee":
      return "assignee";
    case "sprint":
      return "sprint";
    default:
      return field;
  }
}
