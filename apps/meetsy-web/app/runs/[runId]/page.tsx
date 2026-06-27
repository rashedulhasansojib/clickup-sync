"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { AnalysisResult, RunStatus } from "@ma/shared";
import { api, ApiError } from "@/lib/api";
import { useRunStream } from "@/lib/useRunStream";
import { Button, Card, ErrorBanner, Spinner } from "@/app/ui";
import {
  ChatPanel,
  PipelineStepper,
  ResultsSection,
} from "./components";

export default function RunPage() {
  const router = useRouter();
  const params = useParams<{ runId: string }>();
  const runId = params.runId;

  const { events, latest, done, streamError } = useRunStream(runId);

  const [status, setStatus] = useState<RunStatus>("queued");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const settledRef = useRef(false);

  // Authoritative status + result come from GET /runs/:id — the SSE stream
  // never carries the result. We fetch on the stream's "done" signal, then
  // poll briefly as a fallback in case the stream ends before the run settles.
  const fetchRun = useCallback(async (): Promise<RunStatus | null> => {
    setFetching(true);
    try {
      const run = await api.getRun(runId);
      setStatus(run.status);
      if (run.status === "completed" && run.result) {
        setResult(run.result);
        settledRef.current = true;
      }
      if (run.status === "failed") {
        setError(run.error ?? "The run failed.");
        settledRef.current = true;
      }
      setError((prev) => (run.status === "failed" ? prev : null));
      return run.status;
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not load the run.",
      );
      return null;
    } finally {
      setFetching(false);
    }
  }, [runId]);

  // Initial load — pick up runs that completed before we connected.
  useEffect(() => {
    void fetchRun();
  }, [fetchRun]);

  // When the stream signals completion, fetch the authoritative result and
  // poll until the run actually settles (completed/failed), max ~10 attempts.
  useEffect(() => {
    if (!done || settledRef.current) return;

    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const s = await fetchRun();
      attempts += 1;
      if (settledRef.current || attempts >= 10) return;
      if (s === "completed" || s === "failed") return;
      timer = setTimeout(tick, 1500);
    };

    void tick();
    return () => clearTimeout(timer);
  }, [done, fetchRun]);

  const progress = result
    ? 1
    : status === "completed"
      ? 1
      : (latest?.progress ?? 0);

  const isWorking = !settledRef.current && status !== "failed";

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            Analysis
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Run <code className="text-zinc-400">{runId}</code> · status{" "}
            <StatusPill status={status} />
          </p>
        </div>
        <Button variant="secondary" onClick={() => router.push("/")}>
          New analysis
        </Button>
      </div>

      {status === "failed" ? (
        <Card className="space-y-3 p-6">
          <ErrorBanner message={error ?? "The run failed."} />
          <Button variant="secondary" onClick={() => router.push("/")}>
            Start over
          </Button>
        </Card>
      ) : (
        <>
          {/* Live pipeline view — hidden once we have the final result. */}
          {!result && (
            <PipelineStepper events={events} progress={progress} />
          )}

          {/* Non-fatal stream error (we fall back to polling). */}
          {streamError && !result && (
            <ErrorBanner message="Lost the live connection — checking the run status directly…" />
          )}

          {error && !result && <ErrorBanner message={error} />}

          {isWorking && !result && (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <Spinner
                label={
                  fetching
                    ? "Fetching results…"
                    : latest?.message ?? "Analyzing the transcript…"
                }
              />
            </div>
          )}

          {result && (
            <ResultsSection
              runId={runId}
              result={result}
              onResultReplace={setResult}
            />
          )}

          {/* Chat panel — only meaningful once a result exists. Mounted once
              and left mounted (not keyed on result) so feedback/chat updates
              to the result never wipe chat history or in-flight state. */}
          {result && (
            <ChatPanel runId={runId} onResultReplace={setResult} />
          )}
        </>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: RunStatus }) {
  const styles: Record<RunStatus, string> = {
    queued: "bg-zinc-100 text-zinc-600",
    running: "bg-blue-100 text-blue-700",
    completed: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${styles[status]}`}
    >
      {status}
    </span>
  );
}
