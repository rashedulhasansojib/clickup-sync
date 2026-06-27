"use client";

import { useEffect, useRef, useState } from "react";
import type { ProgressEvent as PipelineProgressEvent } from "@ma/shared";
import { api } from "./api";

/**
 * Wraps an EventSource to the `/runs/:id/stream` SSE endpoint.
 *
 * Returns the running list of ProgressEvents, the latest event, and a `done`
 * flag. "Done" is inferred from the contract (there is no run-level done event):
 * the `assemble` stage completing, progress reaching 1, or the stream closing.
 *
 * The run page should treat `done` as a trigger to `GET /runs/:id` for the
 * authoritative status + result — the SSE stream never carries the result.
 */
export interface UseRunStream {
  events: PipelineProgressEvent[];
  latest: PipelineProgressEvent | null;
  done: boolean;
  /** True if the EventSource errored before any completion signal. */
  streamError: boolean;
}

export function useRunStream(runId: string | null): UseRunStream {
  const [events, setEvents] = useState<PipelineProgressEvent[]>([]);
  const [done, setDone] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!runId) return;

    // reset for a fresh run id
    setEvents([]);
    setDone(false);
    setStreamError(false);
    doneRef.current = false;

    // The SSE route is now authenticated (no longer @Public). `withCredentials`
    // makes the browser send the shared `clickup_sync_sid` cookie with the
    // EventSource handshake.
    //
    // TODO(phase0): EventSource.onerror exposes no status code, so a dead-session
    // stream surfaces only as a generic `streamError` here — it cannot trigger
    // the central 401→Clicksy-login redirect. The run page's parallel
    // `api.getRun()` call goes through `request()` and WILL catch the 401 and
    // redirect, so an expired session is still handled; this stream just falls
    // back to polling in the meantime.
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
      try {
        const event = JSON.parse(e.data) as PipelineProgressEvent;
        setEvents((prev) => [...prev, event]);

        const reachedEnd =
          (event.stage === "assemble" && event.status === "completed") ||
          event.progress >= 1 ||
          event.status === "failed";

        if (reachedEnd) finish();
      } catch {
        // ignore malformed frames (e.g. SSE keep-alive comments)
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects on a server-closed stream. If we've already
      // seen a completion signal, just close. Otherwise surface a stream error
      // but still mark done so the page falls back to GET /runs/:id polling.
      if (!doneRef.current) {
        setStreamError(true);
        finish();
      } else {
        es.close();
      }
    };

    return () => {
      doneRef.current = true;
      es.close();
    };
  }, [runId]);

  return {
    events,
    latest: events.length ? events[events.length - 1] : null,
    done,
    streamError,
  };
}
