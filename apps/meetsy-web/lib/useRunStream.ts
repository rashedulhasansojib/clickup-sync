"use client";

import { useEffect, useRef, useState } from "react";
import type { PipelineStage, ProgressEvent as PipelineProgressEvent } from "@ma/shared";
import { api } from "./api";

/**
 * Subscribes to `/runs/:id/stream` (SSE) and exposes a monotonic-friendly view
 * of the pipeline's progress. Consumed by `PipelineStepper` on the run page
 * and — critically — designed to compose with a REST hydration call to
 * `GET /runs/:id` on remount so a hard reload during a run does NOT reset the
 * stepper to "all pending."
 *
 * ### The three bugs this hook is co-designed to fix
 *
 * 1. **Reload during a run showed every step pending.** The backend now
 *    persists `currentStage`+`progress` onto the row on every emit; the run
 *    page seeds this hook via `seed({stage, progress})` before the SSE
 *    handshake completes so the stepper renders correct state IMMEDIATELY.
 * 2. **Finish-during-view required a reload.** We no longer treat an
 *    `EventSource` error as terminal — the browser auto-reconnects. `done`
 *    only flips on a real terminal event (assemble/completed OR
 *    progress>=1 OR status=failed) so a transient blip doesn't strand the
 *    UI at "waiting" or short-circuit into the fallback poll's cap.
 * 3. **Steps flipped to done out of order.** `highestProgress` and
 *    `latestStage` let the stepper derive state monotonically — even if a
 *    ProgressEvent was lost, coalesced, or arrived out of order, the
 *    stepper can still render "everything up to the current stage is done."
 *
 * Named `keepalive` events (server-side ~15s interval) are dropped by the
 * browser's `es.onmessage` handler (they use a different event type) so they
 * never enter our events array — but the SSE HTTP stream stays warm through
 * long-idle stages, avoiding proxy timeouts.
 */
export interface UseRunStream {
  events: PipelineProgressEvent[];
  latest: PipelineProgressEvent | null;
  /** Highest normalized progress (0..1) ever seen — monotonic. */
  highestProgress: number;
  /** The stage of the most recent (by progress) event, or null. */
  latestStage: PipelineStage | null;
  done: boolean;
  /** True after a transport failure that has not since reconnected. Used by
   *  the run page to show a "reconnecting…" banner (NOT to terminate the
   *  stream — EventSource retries automatically). */
  streamError: boolean;
  /**
   * Seed initial state from a REST snapshot (typically `GET /runs/:id` on
   * mount). Idempotent + monotonic-safe: seeds only if we haven't observed
   * anything higher yet. Call BEFORE any SSE event is expected so the
   * stepper never flashes empty on hard reload.
   */
  seed: (snapshot: { stage: PipelineStage; progress: number; message?: string }) => void;
}

export function useRunStream(runId: string | null): UseRunStream {
  const [events, setEvents] = useState<PipelineProgressEvent[]>([]);
  const [done, setDone] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [highestProgress, setHighestProgress] = useState(0);
  const [latestStage, setLatestStage] = useState<PipelineStage | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!runId) return;

    // Reset for a fresh run id — but NOT for a remount of the same run.
    // React's effect re-runs on `[runId]` change only, so hard reload +
    // navigate to the SAME run rehydrates cleanly.
    setEvents([]);
    setDone(false);
    setStreamError(false);
    setHighestProgress(0);
    setLatestStage(null);
    doneRef.current = false;

    // The SSE route is authenticated (cookie session). `withCredentials`
    // makes the browser send the shared `clickup_sync_sid` cookie with the
    // EventSource handshake.
    //
    // Server emits named `keepalive` events every ~15s to keep proxies from
    // closing the idle connection between stages. Named events don't fire
    // `es.onmessage`, so they never enter our events array — they only
    // serve to keep the transport warm.
    const es = new EventSource(api.runStreamUrl(runId), {
      withCredentials: true,
    });

    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      setDone(true);
      es.close();
    };

    es.onmessage = (e: MessageEvent) => {
      // On a successful message, clear any prior transport-error state — the
      // stream is healthy again. Unconditional setState (React no-ops if the
      // value hasn't changed); CRITICAL: `streamError` is NOT in the effect
      // deps below, so this must not read it via closure — otherwise a
      // teardown-and-recreate on `streamError` change would wipe `events` +
      // `highestProgress` (reintroducing bug #1: "reload during a run shows
      // every step pending" — the loop version is worse: every reconnect
      // empties state).
      setStreamError(false);
      try {
        const event = JSON.parse(e.data) as PipelineProgressEvent;
        setEvents((prev) => [...prev, event]);
        setHighestProgress((prev) => Math.max(prev, event.progress));
        setLatestStage(event.stage);

        const reachedEnd =
          (event.stage === "assemble" && event.status === "completed") ||
          event.progress >= 1 ||
          event.status === "failed";

        if (reachedEnd) finish();
      } catch {
        // ignore malformed frames (keepalives have no `data` payload)
      }
    };

    es.onerror = () => {
      // DO NOT treat this as terminal. `EventSource` auto-reconnects with
      // backoff; a proxy blip or short offline period is expected on long
      // runs. We surface a soft `streamError` so the page can show a
      // "reconnecting…" banner, and clear it the moment a message arrives.
      // If we've ALREADY seen the terminal event, close cleanly.
      if (doneRef.current) {
        es.close();
        return;
      }
      setStreamError(true);
    };

    return () => {
      doneRef.current = true;
      es.close();
    };
    // Deps: ONLY [runId]. Adding `streamError` here would create a
    // teardown-recreate loop that wipes `events` + `highestProgress` on
    // every transport blip — the exact bug this hook exists to prevent.
  }, [runId]);

  const seed = useRef((snapshot: {
    stage: PipelineStage;
    progress: number;
    message?: string;
  }) => {
    // Only raise the monotonic markers the stepper actually reads. We
    // DELIBERATELY do NOT inject a synthetic event: injecting a
    // `{status: "completed"}` for the current stage would force that
    // stage to "done" via `stepStateFor`'s `.some(e => e.status ===
    // "completed")` branch — even when `highestProgress` (e.g. 0.60
    // mid-critic) is below that stage's `complete` threshold (0.75).
    // The monotonic `highestProgress` path is enough for correct
    // hydration; the message just fills in on the next real event.
    setHighestProgress((prev) => Math.max(prev, snapshot.progress));
    setLatestStage((prev) => prev ?? snapshot.stage);
  }).current;

  return {
    events,
    latest: events.length ? events[events.length - 1]! : null,
    highestProgress,
    latestStage,
    done,
    streamError,
    seed,
  };
}
