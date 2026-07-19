"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { PipelineStage, ReviewResult, RunStatus } from "@ma/shared";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useRunStream } from "@/lib/useRunStream";
import { useWorkspace } from "@/lib/workspace-context";
import { Button, Card, ErrorBanner, Spinner } from "@/app/ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TaskSheetProvider } from "@/components/tasks/task-sheet-context";
import { TaskDetailSheet } from "@/components/tasks/task-detail-sheet";
import {
  ChatPanel,
  PipelineStepper,
  PushSection,
  ResultsSection,
} from "./components";
import { useReviewKeys } from "./use-review-keys";

type TabKey = "overview" | "push" | "chat" | "insights";
const TAB_KEYS: TabKey[] = ["overview", "push", "chat", "insights"];

function tabFromHash(): TabKey {
  if (typeof window === "undefined") return "overview";
  const raw = window.location.hash.replace(/^#/, "");
  return (TAB_KEYS as string[]).includes(raw) ? (raw as TabKey) : "overview";
}

export default function RunPage() {
  const router = useRouter();
  const params = useParams<{ runId: string }>();
  const runId = params.runId;
  const { activeWorkspaceId } = useWorkspace();

  const { events, latest, done, streamError, highestProgress, seed } =
    useRunStream(runId);
  // v2 Phase 6 (PR-BB) — j/k keyboard traversal between task anchors on the
  // review page. The hook self-guards against typing in inputs/textareas.
  useReviewKeys();

  const [status, setStatus] = useState<RunStatus>("queued");
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const settledRef = useRef(false);

  // Durable pipeline state persisted by the processor on every emit — read
  // on mount so hard reload during a run shows the correct stepper state
  // immediately, without waiting for the next Redis pub/sub event.
  const [currentStage, setCurrentStage] = useState<PipelineStage | null>(null);
  const [serverProgress, setServerProgress] = useState<number>(0);
  const [stageStartedAt, setStageStartedAt] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [stageDurations, setStageDurations] = useState<Record<string, number> | null>(
    null,
  );
  const [cancelRequestedAt, setCancelRequestedAt] = useState<string | null>(null);
  const [typicalByStage, setTypicalByStage] = useState<Record<string, number>>({});
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Which tab is active — synced with #hash so a shared link opens the right view.
  const [tab, setTab] = useState<TabKey>("overview");
  useEffect(() => {
    setTab(tabFromHash());
    function onHash() {
      setTab(tabFromHash());
    }
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function selectTab(next: string) {
    const key = (TAB_KEYS as string[]).includes(next) ? (next as TabKey) : "overview";
    setTab(key);
    if (typeof window !== "undefined") {
      // history.replaceState to avoid piling up back-stack entries per tab click.
      const url = `${window.location.pathname}${window.location.search}#${key}`;
      window.history.replaceState(null, "", url);
    }
  }

  // Authoritative status + result + durable progress state come from GET
  // /runs/:id. On mount we seed the stream hook so the stepper hydrates
  // instantly on hard reload; while running we re-fetch when the SSE stream
  // reports done (and briefly poll after) to catch the DB-write delay
  // between `emit(assemble/completed, 1)` and the `result:` column landing.
  const fetchRun = useCallback(async (): Promise<RunStatus | null> => {
    setFetching(true);
    try {
      const run = await api.getRun(runId);
      setStatus(run.status);
      setCurrentStage((run.currentStage as PipelineStage | null | undefined) ?? null);
      setServerProgress(run.progress ?? 0);
      setStageStartedAt(run.stageStartedAt ?? null);
      setStartedAt(run.startedAt ?? null);
      setStageDurations(run.stageDurations ?? null);
      setCancelRequestedAt(run.cancelRequestedAt ?? null);

      // Seed the stream so the stepper renders correctly BEFORE the SSE
      // hook receives its first live event. Monotonic — the seed only
      // raises progress, never lowers it. `currentStage` is null on fresh
      // runs (never emitted yet) — nothing to seed.
      if (run.currentStage && typeof run.progress === "number") {
        seed({
          stage: run.currentStage as PipelineStage,
          progress: run.progress,
          message: `Resumed at ${run.currentStage}`,
        });
      }

      if (run.status === "completed" && run.result) {
        setResult(run.result);
        settledRef.current = true;
      }
      if (run.status === "failed") {
        setError(run.error ?? "The run failed.");
        settledRef.current = true;
      }
      if (run.status === "cancelled") {
        settledRef.current = true;
      }
      // Clear stale error banners once the row is no longer failed.
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
  }, [runId, seed]);

  // Initial load — pick up runs that completed before we connected, and
  // hydrate the stepper for runs in-flight when the page mounts.
  useEffect(() => {
    void fetchRun();
  }, [fetchRun]);

  // Fetch the median stage-timing sample ONCE on mount for the stepper's
  // "typical" duration hint. Best-effort: an error just hides the hints.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    void api
      .getRunStageTimings(activeWorkspaceId, 10)
      .then((r) => {
        if (!cancelled) setTypicalByStage(r.medianByStage);
      })
      .catch(() => {
        /* ignore — the hint is optional */
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  // Unbounded (but backing-off) poll after the SSE stream reports done —
  // replaces the old 10×1500ms hard cap that gave up at 15s and stranded
  // the UI on slow snapshot writes / dropped terminal events. Only exits
  // on a real terminal state or component unmount.
  useEffect(() => {
    if (!done || settledRef.current) return;

    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;

    const tick = async () => {
      if (!alive) return;
      const s = await fetchRun();
      attempts += 1;
      if (!alive || settledRef.current) return;
      if (s === "completed" || s === "failed" || s === "cancelled") return;
      // 1s → 2s → 4s → 8s → 15s → 15s … (capped, no hard total limit)
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempts, 4));
      timer = setTimeout(tick, delay);
    };

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [done, fetchRun]);

  // Composite "highest progress" — the max of the SSE-observed value, the
  // server-hydrated value, and the derived terminal marker. This is what
  // powers the stepper's monotonic step-state derivation.
  const progress = result
    ? 1
    : status === "completed"
      ? 1
      : Math.max(highestProgress, serverProgress, latest?.progress ?? 0);

  const isTerminal =
    status === "completed" || status === "failed" || status === "cancelled";
  const isWorking = !settledRef.current && !isTerminal;
  const isQueuedWaiting = status === "queued" && progress === 0;

  // The failing stage — for painting the stepper red at the right row on
  // failure. The processor always emits terminal `assemble/failed` on error
  // (see processor's outer catch), but a stage-specific failure earlier in
  // the pipeline would surface in `currentStage`.
  const failedStage: PipelineStage | null =
    status === "failed" ? (currentStage ?? "assemble") : null;

  async function handleCancel() {
    if (cancelling) return;
    setCancelling(true);
    try {
      await api.cancelRun(runId);
      toast("Cancelling…", {
        description:
          status === "queued"
            ? "Removed from the queue."
            : "The pipeline will stop at the next stage boundary.",
      });
      // Kick off a re-fetch so status flips promptly.
      void fetchRun();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Could not cancel the run.",
      );
    } finally {
      setCancelling(false);
    }
  }

  async function handleRetry() {
    if (retrying) return;
    setRetrying(true);
    try {
      const { runId: newRunId } = await api.retryRun(runId);
      toast.success("Retrying — opening the new run.");
      router.push(`/runs/${newRunId}`);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Could not retry the run.",
      );
      setRetrying(false);
    }
  }

  return (
    <TaskSheetProvider>
      <TaskDetailSheet workspaceId={activeWorkspaceId} />
      <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Analysis
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Run <code className="text-muted-foreground/70">{runId}</code> · status{" "}
            <StatusPill status={status} />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isWorking && (
            <Button
              variant="ghost"
              onClick={handleCancel}
              disabled={cancelling || !!cancelRequestedAt}
            >
              {cancelRequestedAt
                ? "Cancelling…"
                : cancelling
                  ? "Cancelling…"
                  : "Cancel"}
            </Button>
          )}
          {(status === "failed" || status === "cancelled") && (
            <Button variant="secondary" onClick={handleRetry} disabled={retrying}>
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          )}
          <Button variant="secondary" onClick={() => router.push("/new")}>
            New analysis
          </Button>
        </div>
      </div>

      {isQueuedWaiting && (
        <Card className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
          <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          Queued — waiting for a worker to pick this up. This usually takes a few seconds.
        </Card>
      )}

      {status === "failed" ? (
        <>
          <PipelineStepper
            events={events}
            progress={progress}
            stageStartedAt={stageStartedAt}
            startedAt={startedAt}
            stageDurations={stageDurations}
            typicalByStage={typicalByStage}
            failedStage={failedStage}
          />
          <Card className="space-y-3 p-6">
            <ErrorBanner message={error ?? "The run failed."} />
            <div className="flex gap-2">
              <Button variant="primary" onClick={handleRetry} disabled={retrying}>
                {retrying ? "Retrying…" : "Retry this run"}
              </Button>
              <Button variant="secondary" onClick={() => router.push("/new")}>
                Start over
              </Button>
            </div>
          </Card>
        </>
      ) : status === "cancelled" ? (
        <Card className="space-y-3 p-6">
          <p className="text-sm text-foreground">
            This run was cancelled. You can retry it or start a new analysis.
          </p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={handleRetry} disabled={retrying}>
              {retrying ? "Retrying…" : "Retry"}
            </Button>
            <Button variant="secondary" onClick={() => router.push("/new")}>
              Start over
            </Button>
          </div>
        </Card>
      ) : (
        <>
          {/* Live pipeline view — hidden once we have the final result. */}
          {!result && (
            <PipelineStepper
              events={events}
              progress={progress}
              stageStartedAt={stageStartedAt}
              startedAt={startedAt}
              stageDurations={stageDurations}
              typicalByStage={typicalByStage}
            />
          )}

          {/* Non-fatal transport error — the SSE will auto-reconnect. */}
          {streamError && !result && (
            <ErrorBanner message="Live connection lost — trying to reconnect…" />
          )}

          {error && !result && <ErrorBanner message={error} />}

          {isWorking && !result && !isQueuedWaiting && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
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
            <Tabs
              value={tab}
              onValueChange={selectTab}
              className="w-full space-y-4"
            >
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="push">Push</TabsTrigger>
                <TabsTrigger value="chat">Chat</TabsTrigger>
                <TabsTrigger value="insights">Insights</TabsTrigger>
              </TabsList>

              {/*
                `forceMount` keeps every tab's subtree alive across switches so
                ChatPanel's history + PushSection's in-flight fetches don't
                restart. Inactive panels hide via `data-[state=inactive]:hidden`
                — Radix still handles focus and ARIA correctly.
              */}
              <TabsContent
                value="overview"
                forceMount
                className="data-[state=inactive]:hidden"
              >
                <ResultsSection
                  runId={runId}
                  result={result}
                  onResultReplace={setResult}
                />
              </TabsContent>

              <TabsContent
                value="push"
                forceMount
                className="data-[state=inactive]:hidden"
              >
                <PushSection runId={runId} result={result} />
              </TabsContent>

              <TabsContent
                value="chat"
                forceMount
                className="data-[state=inactive]:hidden"
              >
                <ChatPanel runId={runId} onResultReplace={setResult} />
              </TabsContent>

              <TabsContent
                value="insights"
                forceMount
                className="data-[state=inactive]:hidden"
              >
                <Card className="p-6 text-sm text-muted-foreground">
                  <h3 className="text-base font-medium text-foreground">
                    Where&apos;s the evidence?
                  </h3>
                  <p className="mt-1">
                    Since v2 Phase 2, task cards on the Overview tab render
                    the full ownership ranking, kNN candidates, similar
                    tasks, and clickable ClickUp task chips inline. Open a
                    task card to see the evidence panel — no separate view
                    needed.
                  </p>
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </>
      )}
      </div>
    </TaskSheetProvider>
  );
}

function StatusPill({ status }: { status: RunStatus }) {
  const styles: Record<RunStatus, string> = {
    queued: "bg-muted text-muted-foreground",
    running: "bg-blue-100 text-blue-700",
    completed: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
    // `cancelled` is a deliberate user action — muted (not red) to
    // distinguish it from a pipeline failure at a glance.
    cancelled: "bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${styles[status]}`}
    >
      {status}
    </span>
  );
}
