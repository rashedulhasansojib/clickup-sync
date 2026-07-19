"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";
import { api, type RunNotificationStreamEvent } from "./api";

/**
 * v2 SSE progress-polish — subscribe workspace-wide to run terminal events.
 * Mirrors `useLearningStream` (v2 Phase 3 PR-N) — mounted globally inside
 * `SignedInShell` so a toast fires the moment the processor emits a terminal
 * state, no matter which page the user is currently on.
 *
 * The per-run SSE at `/runs/:id/stream` only fires while a user is on that
 * exact run page. A user who uploads a transcript and switches to `/home` to
 * do other work would otherwise never know their analysis finished. This
 * hook closes that gap: the completion toast becomes a first-class signal
 * with a "View" action that navigates to the run page.
 *
 * Suppression: if the user is ALREADY on `/runs/<runId>` for this run,
 * we skip the toast — the on-page stepper is a stronger signal than a
 * toast and a duplicate feels noisy.
 */
export function useRunNotifyStream(workspaceId: string | null): void {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!workspaceId) return;
    const es = new EventSource(api.runsNotifyStreamUrl(workspaceId), {
      withCredentials: true,
    });

    es.onmessage = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as RunNotificationStreamEvent;
        // Suppress if the user is on this run's page — the stepper +
        // terminal render already shows what happened.
        const alreadyOnRun = pathname === `/runs/${event.runId}`;
        if (alreadyOnRun) return;
        renderToast(event, () => router.push(`/runs/${event.runId}`));
      } catch {
        // ignore malformed frames (keep-alives / partial reads)
      }
    };

    // EventSource auto-reconnects; silent errors are fine here — a missed
    // toast is harmless (any workspace page has other signals).
    es.onerror = () => {
      /* noop */
    };

    return () => {
      es.close();
    };
  }, [workspaceId, pathname, router]);
}

function renderToast(
  event: RunNotificationStreamEvent,
  onView: () => void,
): void {
  const meetingLabel = event.meetingTitle.length > 60
    ? `${event.meetingTitle.slice(0, 57)}…`
    : event.meetingTitle;
  const action = { label: "View", onClick: onView };

  if (event.kind === "completed") {
    toast.success(`Analysis ready — ${meetingLabel}`, {
      description: "Open the run to review tasks and push to ClickUp.",
      duration: 10_000,
      action,
    });
    return;
  }
  if (event.kind === "failed") {
    toast.error(`Analysis failed — ${meetingLabel}`, {
      description: event.message ?? "Open the run to retry or see the error.",
      duration: 12_000,
      action,
    });
    return;
  }
  // cancelled — quieter tone, no error icon
  toast(`Analysis cancelled — ${meetingLabel}`, {
    duration: 6_000,
    action,
  });
}
