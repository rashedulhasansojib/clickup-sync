"use client";

import { useEffect, useRef, useState } from "react";
import { api, type KbProgressEvent } from "./api";

/**
 * Wraps an EventSource to the `/workspaces/:id/kb/status/stream` SSE endpoint.
 *
 * Mirrors `useRunStream`: accumulates the running list of KbProgressEvents,
 * exposes the latest event and a `done` flag. The stream is terminal when an
 * event arrives with `status === "ready" || "error"`.
 *
 * The SSE stream is NOT authoritative — on `done`, the consumer (the wizard)
 * should call `api.kbStatus(ws)` for the authoritative status. A dead/expired
 * stream also flips `done` (via onerror), so the consumer's `kbStatus` confirm
 * still fires instead of hanging on the progress bar forever.
 */
export interface UseKbStatusStream {
  events: KbProgressEvent[];
  latest: KbProgressEvent | null;
  done: boolean;
}

export function useKbStatusStream(ws: string | null): UseKbStatusStream {
  const [events, setEvents] = useState<KbProgressEvent[]>([]);
  const [done, setDone] = useState(false);
  const doneRef = useRef(false);

  useEffect(() => {
    // Reset BEFORE the ws guard so toggling ws → null (e.g. a "try again" that
    // tears down the stream) clears a stale `done`. Otherwise a consumer effect
    // keyed on `done` could fire once against the previous run's terminal state
    // before a fresh stream resets it.
    setEvents([]);
    setDone(false);
    doneRef.current = false;

    if (!ws) return;

    // `withCredentials` sends the shared `clickup_sync_sid` cookie with the
    // EventSource handshake (the stream route is authenticated).
    const es = new EventSource(api.kbStatusStreamUrl(ws), {
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
        const event = JSON.parse(e.data) as KbProgressEvent;
        setEvents((prev) => [...prev, event]);
        if (event.status === "ready" || event.status === "error") finish();
      } catch {
        // ignore malformed frames (e.g. SSE keep-alive comments)
      }
    };

    es.onerror = () => {
      // Keep useRunStream's behavior: a dead stream still flips `done` so the
      // wizard falls back to the authoritative `api.kbStatus(ws)` confirm.
      if (!doneRef.current) {
        finish();
      } else {
        es.close();
      }
    };

    return () => {
      doneRef.current = true;
      es.close();
    };
  }, [ws]);

  return {
    events,
    latest: events.length ? events[events.length - 1] : null,
    done,
  };
}
