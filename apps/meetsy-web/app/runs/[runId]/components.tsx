"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import type {
  ChatMessage,
  FeedbackItem,
  PersonTasks,
  Task,
  TaskPriority,
  TaskVote,
  PipelineStage,
  ProgressEvent as PipelineProgressEvent,
} from "@ma/shared";
import {
  api,
  ApiError,
  type AssignableMember,
  type PushAuditRow,
  type PushResult,
  type PushTaskInput,
  type RunPushStatus,
} from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-context";
import { Button, Card, ErrorBanner, PriorityBadge, Spinner, Tag } from "@/app/ui";
import {
  type ReviewResult,
  type TaskSignalData,
  signalsForTask,
  TaskSignals,
  KbContextBanner,
} from "./signals";

// ── Live pipeline stepper ─────────────────────────────────────────────
// Canonical ordered list of the full Phase-2 pipeline. Stages that never
// emit a ProgressEvent (e.g. `assign` may be folded into extract) simply
// stay pending/neutral — see stepStateFor.
const STEPPER_STAGES: { stage: PipelineStage; label: string }[] = [
  { stage: "normalize", label: "Normalize" },
  { stage: "comprehend", label: "Comprehend" },
  { stage: "extract", label: "Extract" },
  { stage: "assign", label: "Assign" },
  { stage: "enrich", label: "Enrich" },
  { stage: "critic", label: "Critic" },
  { stage: "assemble", label: "Assemble" },
];

type StepState = "pending" | "active" | "done" | "failed";

function stepStateFor(
  stage: PipelineStage,
  events: PipelineProgressEvent[],
): StepState {
  const forStage = events.filter((e) => e.stage === stage);
  if (forStage.length === 0) {
    // No events for this stage yet (or it was skipped) — stay neutral.
    return "pending";
  }
  if (forStage.some((e) => e.status === "failed")) return "failed";
  if (forStage.some((e) => e.status === "completed")) return "done";
  return "active";
}

export function PipelineStepper({
  events,
  progress,
}: {
  events: PipelineProgressEvent[];
  progress: number;
}) {
  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-700">Pipeline progress</h2>
        <span className="text-xs text-zinc-400">
          {Math.round(progress * 100)}%
        </span>
      </div>

      <div
        role="progressbar"
        aria-label="Pipeline progress"
        aria-valuenow={Math.round(progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mb-5 h-2 w-full overflow-hidden rounded-full bg-zinc-100"
      >
        <div
          className="h-full rounded-full bg-zinc-900 transition-all duration-500"
          style={{ width: `${Math.min(100, Math.round(progress * 100))}%` }}
        />
      </div>

      <ol className="space-y-3">
        {STEPPER_STAGES.map(({ stage, label }) => {
          const state = stepStateFor(stage, events);
          const latestForStage = [...events]
            .reverse()
            .find((e) => e.stage === stage);
          return (
            <li key={stage} className="flex items-start gap-3">
              <StepDot state={state} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-sm font-medium ${
                      state === "pending" ? "text-zinc-400" : "text-zinc-800"
                    }`}
                  >
                    {label}
                  </span>
                  {state === "active" && (
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600" />
                  )}
                </div>
                {latestForStage && (
                  <p className="truncate text-xs text-zinc-500">
                    {latestForStage.message}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function StepDot({ state }: { state: StepState }) {
  const styles: Record<StepState, string> = {
    pending: "border-zinc-300 bg-white text-transparent",
    active: "border-zinc-600 bg-white text-zinc-600",
    done: "border-zinc-900 bg-zinc-900 text-white",
    failed: "border-red-500 bg-red-500 text-white",
  };
  return (
    <span
      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${styles[state]}`}
      aria-hidden
    >
      {state === "done" ? "✓" : state === "failed" ? "!" : "•"}
    </span>
  );
}

// ── Per-task feedback state (lifted to ResultsSection via context) ──────
/** One task's local feedback: a vote and (for downvotes) an optional comment. */
interface TaskFeedback {
  vote: TaskVote;
  comment: string;
}

interface FeedbackContextValue {
  /** Map of taskId → local feedback for tasks the user has voted on. */
  feedback: Record<string, TaskFeedback>;
  setVote: (taskId: string, vote: TaskVote) => void;
  setComment: (taskId: string, comment: string) => void;
  /** Disabled while a submit is in flight. */
  disabled: boolean;
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

// ── Results section: owns feedback state + the single Submit button ─────
export function ResultsSection({
  runId,
  result,
  onResultReplace,
}: {
  runId: string;
  result: ReviewResult;
  onResultReplace: (result: ReviewResult) => void;
}) {
  const [feedback, setFeedback] = useState<Record<string, TaskFeedback>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const setVote = useCallback((taskId: string, vote: TaskVote) => {
    setStatus(null);
    setFeedback((prev) => {
      const existing = prev[taskId];
      // Toggle off if the same vote is clicked again.
      if (existing?.vote === vote) {
        const next = { ...prev };
        delete next[taskId];
        return next;
      }
      return { ...prev, [taskId]: { vote, comment: existing?.comment ?? "" } };
    });
  }, []);

  const setComment = useCallback((taskId: string, comment: string) => {
    setFeedback((prev) => {
      const existing = prev[taskId];
      if (!existing) return prev;
      return { ...prev, [taskId]: { ...existing, comment } };
    });
  }, []);

  const items: FeedbackItem[] = Object.entries(feedback).map(
    ([taskId, fb]) => {
      const comment = fb.comment.trim();
      return comment
        ? { taskId, vote: fb.vote, comment }
        : { taskId, vote: fb.vote };
    },
  );

  const handleSubmit = useCallback(async () => {
    if (items.length === 0) return;
    setSubmitting(true);
    setError(null);
    setStatus(null);
    try {
      const res = await api.submitFeedback(runId, items);
      onResultReplace(res.result);
      setFeedback({});
      setStatus(
        res.accepted
          ? "Accepted ✓"
          : res.changed
            ? `Updated ${items.length} task${items.length === 1 ? "" : "s"}`
            : "No changes",
      );
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not submit feedback.",
      );
    } finally {
      setSubmitting(false);
    }
    // items is derived from feedback each render; depend on the primitives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, feedback, onResultReplace]);

  return (
    <FeedbackContext.Provider
      value={{ feedback, setVote, setComment, disabled: submitting }}
    >
      <ResultView result={result} />

      <Card className="space-y-3 p-5">
        <p className="text-xs leading-relaxed text-zinc-500">
          <span className="font-medium text-zinc-700">How feedback works:</span>{" "}
          👍 = correct · 👎 with a comment = we revise it · 👎 with no comment =
          it&apos;s removed · no vote = accepted by default.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleSubmit} disabled={submitting || items.length === 0}>
            {submitting ? <Spinner label="Submitting…" /> : "Submit feedback"}
          </Button>
          {items.length > 0 && !submitting && (
            <span className="text-xs text-zinc-500">
              {items.length} task{items.length === 1 ? "" : "s"} marked
            </span>
          )}
          {status && (
            <span className="text-xs font-medium text-green-700">{status}</span>
          )}
        </div>
        {error && <ErrorBanner message={error} />}
      </Card>
    </FeedbackContext.Provider>
  );
}

// ── Result rendering ──────────────────────────────────────────────────
export function ResultView({ result }: { result: ReviewResult }) {
  const rr = result;
  const { activeWorkspaceId } = useWorkspace();
  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Overview
        </h2>
        <Card className="p-5">
          <p className="text-sm leading-relaxed text-zinc-700">
            {result.overview}
          </p>
        </Card>
        <div className="mt-3">
          <KbContextBanner hits={rr.kbContext} workspaceId={activeWorkspaceId} />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Tasks by person
        </h2>
        {result.people.length === 0 && (
          <p className="text-sm text-zinc-400">No assigned tasks.</p>
        )}
        {result.people.map((pt) => (
          <PersonSection
            key={pt.participant.id}
            personTasks={pt}
            result={rr}
            workspaceId={activeWorkspaceId}
          />
        ))}
      </section>

      {result.unassignedTasks.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-600">
            Unassigned
          </h2>
          <p className="text-xs text-zinc-500">
            Tasks the pipeline couldn&apos;t confidently assign to anyone.
          </p>
          <div className="space-y-3">
            {result.unassignedTasks.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                signals={signalsForTask(rr, t.id)}
                workspaceId={activeWorkspaceId}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function PersonSection({
  personTasks,
  result,
  workspaceId,
}: {
  personTasks: PersonTasks;
  result: ReviewResult;
  workspaceId: string | null;
}) {
  const { participant, tasks } = personTasks;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-700">
          {participant.displayName.charAt(0).toUpperCase()}
        </span>
        <span className="font-medium text-zinc-900">
          {participant.displayName}
        </span>
        <span className="text-xs text-zinc-400">
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="space-y-3 pl-9">
        {tasks.length === 0 ? (
          <p className="text-sm text-zinc-400">No tasks.</p>
        ) : (
          tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              signals={signalsForTask(result, t.id)}
              workspaceId={workspaceId}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  signals,
  workspaceId,
}: {
  task: Task;
  signals?: TaskSignalData;
  workspaceId: string | null;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-medium text-zinc-900">{task.title}</h3>
        <PriorityBadge priority={task.priority} />
      </div>

      {signals && <TaskSignals signals={signals} workspaceId={workspaceId} />}

      {task.description && (
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">
          {task.description}
        </p>
      )}

      {(task.dueDate || task.estimate || task.estimateHours !== null) && (
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-zinc-500">
          {task.dueDate && (
            <span>
              <span className="font-medium text-zinc-400">Due: </span>
              {task.dueDate}
            </span>
          )}
          {task.estimateHours !== null && (
            <span>
              <span className="font-medium text-zinc-400">Est: </span>
              {task.estimateHours}h
            </span>
          )}
          {task.estimate && (
            <span>
              <span className="font-medium text-zinc-400">Estimate: </span>
              {task.estimate}
            </span>
          )}
        </div>
      )}

      {task.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {task.tags.map((tag, i) => (
            <Tag key={i}>{tag}</Tag>
          ))}
        </div>
      )}

      {task.acceptanceCriteria.length > 0 && (
        <DetailList
          label="Acceptance criteria"
          items={task.acceptanceCriteria}
        />
      )}

      {task.subtasks.length > 0 && (
        <DetailList label="Subtasks" items={task.subtasks} />
      )}

      {task.dependencies.length > 0 && (
        <DetailList label="Dependencies" items={task.dependencies} />
      )}

      {task.evidence.length > 0 && <EvidenceDisclosure task={task} />}

      <TaskFeedbackControl task={task} />
    </Card>
  );
}

function DetailList({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="mt-3">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
        {label}
      </p>
      <ul className="list-disc space-y-0.5 pl-5 text-sm text-zinc-600">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function EvidenceDisclosure({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border-t border-zinc-100 pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-800"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>
          ▸
        </span>
        Evidence ({task.evidence.length})
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {task.evidence.map((ev, i) => (
            <li
              key={i}
              className="rounded-lg border-l-2 border-zinc-300 bg-zinc-50 px-3 py-2"
            >
              <p className="text-sm italic text-zinc-700">
                &ldquo;{ev.quote}&rdquo;
              </p>
              {(ev.speaker || ev.timestamp) && (
                <p className="mt-1 text-xs text-zinc-400">
                  {ev.speaker ?? "Unknown"}
                  {ev.timestamp ? ` · ${ev.timestamp}` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Per-task feedback control (👍 / 👎 + comment) ───────────────────────
function TaskFeedbackControl({ task }: { task: Task }) {
  const ctx = useContext(FeedbackContext);
  if (!ctx) return null;
  const { feedback, setVote, setComment, disabled } = ctx;
  const fb = feedback[task.id];
  const vote = fb?.vote;

  return (
    <div className="mt-3 border-t border-zinc-100 pt-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-400">Helpful?</span>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={vote === "up"}
          onClick={() => setVote(task.id, "up")}
          title="Correct"
          className={`rounded-md border px-2 py-0.5 text-xs transition-colors disabled:opacity-50 ${
            vote === "up"
              ? "border-green-300 bg-green-50 text-green-700"
              : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"
          }`}
        >
          👍
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={vote === "down"}
          onClick={() => setVote(task.id, "down")}
          title="Wrong"
          className={`rounded-md border px-2 py-0.5 text-xs transition-colors disabled:opacity-50 ${
            vote === "down"
              ? "border-red-300 bg-red-50 text-red-700"
              : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"
          }`}
        >
          👎
        </button>
      </div>

      {vote === "down" && (
        <textarea
          value={fb?.comment ?? ""}
          disabled={disabled}
          onChange={(e) => setComment(task.id, e.target.value)}
          placeholder="What's wrong? (optional — we'll fix it)"
          rows={2}
          className="mt-2 w-full resize-y rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none disabled:opacity-50"
        />
      )}
    </div>
  );
}

// ── Chat panel: recover missed tasks / ask about the result ─────────────
export function ChatPanel({
  runId,
  onResultReplace,
}: {
  runId: string;
  onResultReplace: (result: ReviewResult) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load history once on mount.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await api.getChat(runId);
        // Don't clobber an optimistic exchange the user started before
        // history landed — only seed when the panel is still empty.
        if (active) setMessages((prev) => (prev.length ? prev : res.messages));
      } catch {
        // History is best-effort; an empty panel is fine to start from.
      }
    })();
    return () => {
      active = false;
    };
  }, [runId]);

  // Keep the latest message in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  const handleSend = useCallback(async () => {
    const message = input.trim();
    if (!message || sending) return;

    // Optimistically append the user message (the server returns only the reply).
    const userMsg: ChatMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: message,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const res = await api.sendChat(runId, message);
      setMessages((prev) => [...prev, res.reply]);
      if (res.resultUpdated && res.result) {
        onResultReplace(res.result);
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not send the message.",
      );
    } finally {
      setSending(false);
    }
  }, [input, sending, runId, onResultReplace]);

  return (
    <Card className="flex flex-col p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-700">
          Recover missed tasks
        </h2>
      </div>
      <p className="mb-3 text-xs text-zinc-500">
        Notice a missing task? Tell me, e.g. &ldquo;You missed the task about
        the database migration.&rdquo;
      </p>

      <div
        ref={scrollRef}
        className="mb-3 max-h-80 space-y-3 overflow-y-auto"
        aria-live="polite"
      >
        {messages.length === 0 && !sending && (
          <p className="text-sm text-zinc-400">No messages yet.</p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                m.role === "user"
                  ? "bg-zinc-900 text-white"
                  : "border border-zinc-200 bg-zinc-50 text-zinc-700"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <Spinner label="thinking…" />
            </div>
          </div>
        )}
      </div>

      {error && <ErrorBanner message={error} />}

      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
      >
        <input
          type="text"
          value={input}
          disabled={sending}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. You missed the task about the database migration."
          className="flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none disabled:opacity-50"
        />
        <Button type="submit" disabled={sending || input.trim().length === 0}>
          Send
        </Button>
      </form>
    </Card>
  );
}

// ── ClickUp push editor (Phase 1) ───────────────────────────────────────
// Shown on a completed run. Loads GET /runs/:id/push (config + suggestions +
// existing pushes). If push isn't configured, links to the settings page.
// Otherwise renders an editable row per task (assignee from the allowlist,
// priority, due date, optional list override), with already-pushed tasks
// locked to their ClickUp link, and a bulk "Push to ClickUp" button.

const PRIORITY_OPTIONS: TaskPriority[] = ["urgent", "high", "normal", "low"];

/** Per-task editable push state. */
interface PushEdit {
  /** ClickUp user id, or null for unassigned. */
  clickupUserId: string | null;
  priority: TaskPriority;
  /** yyyy-mm-dd for the <input type=date>, or "" for none. */
  dueDate: string;
  /** Optional per-task target list override (list id); "" = use workspace default. */
  listOverride: string;
  /** Phase 2c.3 — confirmed client dropdown option UUID; "" = none. */
  clientOptionId: string;
  /** Phase 2c.3 — confirmed sprint points; "" = none. */
  points: string;
  /** Whether this row is included in the next bulk push. */
  include: boolean;
}

/** Flatten a result into one ordered task list (assigned people, then unassigned). */
function flattenTasks(result: ReviewResult): Task[] {
  return [...result.people.flatMap((p) => p.tasks), ...result.unassignedTasks];
}

/** ISO/date string → yyyy-mm-dd for a date input; "" when not a parseable date. */
function toDateInputValue(due: string | null): string {
  if (!due) return "";
  const ms = Date.parse(due);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

export function PushSection({
  runId,
  result,
}: {
  runId: string;
  result: ReviewResult;
}) {
  const [status, setStatus] = useState<RunPushStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [edits, setEdits] = useState<Record<string, PushEdit>>({});
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  /** Per-task result of the most recent push (taskId → outcome). */
  const [results, setResults] = useState<Record<string, PushResult>>({});

  const tasks = flattenTasks(result);
  // The result also carries the Phase-3.1 assignment recs (for assignee pre-fill).
  const rr = result;

  // Build the initial editable state from the loaded status + each task's
  // pipeline defaults. Already-`pushed` tasks are excluded from the push by
  // default (they're locked); failed/skipped stay editable.
  const initEdits = useCallback(
    (s: RunPushStatus) => {
      const suggestionBy = new Map(
        s.suggestions.map((sg) => [sg.meetsyTaskId, sg.suggestedClickupUserId]),
      );
      const allowed = new Set(
        (s.config?.assignableMembers ?? []).map((m) => m.clickupUserId),
      );
      const pushedIds = new Set(
        s.pushes.filter((p) => p.status === "pushed").map((p) => p.meetsyTaskId),
      );

      // Preserve any in-progress edits the user already made (re-fetches happen
      // when feedback/chat revise the result); only seed defaults for new tasks.
      // A task that just became `pushed` is force-excluded from the next push.
      setEdits((prev) => {
        const next: Record<string, PushEdit> = {};
        for (const t of tasks) {
          const existing = prev[t.id];
          if (existing) {
            next[t.id] = {
              ...existing,
              include: pushedIds.has(t.id) ? false : existing.include,
            };
            continue;
          }
          // Pre-fill the assignee: the Phase-3.1 ownership recommendation (when
          // in-pool) takes priority, else the Phase-1 name-resolved suggestion.
          const rec = rr.assignment?.[t.id]?.recommended;
          const recId = rec?.inPool ? rec.clickupUserId : null;
          const suggested = recId ?? suggestionBy.get(t.id) ?? null;
          // Pre-select the client from the MEETING's client (chosen at upload),
          // but only if it's still a valid option in the current push config.
          const meetingClientId = s.meetingClient?.clientOptionId ?? null;
          const clientOpt =
            meetingClientId &&
            (s.config?.clientOptions ?? []).some(
              (o) => o.optionId === meetingClientId,
            )
              ? meetingClientId
              : "";
          next[t.id] = {
            clickupUserId: suggested && allowed.has(suggested) ? suggested : null,
            priority: t.priority,
            dueDate: toDateInputValue(t.dueDate),
            listOverride: "",
            clientOptionId: clientOpt,
            points: "",
            include: !pushedIds.has(t.id),
          };
        }
        return next;
      });
    },
    // tasks is derived from `result` each render; key the init on result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const s = await api.getRunPush(runId);
      setStatus(s);
      initEdits(s);
    } catch (err) {
      setLoadError(
        err instanceof ApiError ? err.message : "Could not load push status.",
      );
    } finally {
      setLoading(false);
    }
  }, [runId, initEdits]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateEdit = useCallback(
    (taskId: string, patch: Partial<PushEdit>) => {
      setEdits((prev) => ({ ...prev, [taskId]: { ...prev[taskId], ...patch } }));
    },
    [],
  );

  if (loading) {
    return (
      <Card className="p-5">
        <Spinner label="Loading push status…" />
      </Card>
    );
  }

  if (loadError) return <ErrorBanner message={loadError} />;
  if (!status) return null;

  // Not configured → guide the user to settings (no editor).
  if (!status.config) {
    return (
      <Card className="space-y-2 p-5">
        <h2 className="text-sm font-semibold text-zinc-700">Push to ClickUp</h2>
        <p className="text-sm text-zinc-600">
          Configure ClickUp push settings (target list + assignable members) to
          enable pushing tasks.
        </p>
        <Link
          href="/settings/push"
          className="text-sm font-medium text-zinc-900 underline underline-offset-2 hover:text-zinc-700"
        >
          Open push settings →
        </Link>
      </Card>
    );
  }

  const config = status.config;
  const pushedBy = new Map<string, PushAuditRow>(
    status.pushes
      .filter((p) => p.status === "pushed")
      .map((p) => [p.meetsyTaskId, p]),
  );

  // Eligible = editable rows the user has ticked for the next push.
  const eligible = tasks.filter(
    (t) => !pushedBy.has(t.id) && edits[t.id]?.include,
  );

  // Plain handler (not a hook) — defined after the early returns above, so it
  // must not be a useCallback. It closes over the latest edits/eligible.
  const handlePush = async () => {
    if (eligible.length === 0) return;
    if (
      !window.confirm(
        `Create ${eligible.length} task${
          eligible.length === 1 ? "" : "s"
        } in ClickUp?`,
      )
    ) {
      return;
    }

    setPushing(true);
    setPushError(null);
    try {
      const payload: PushTaskInput[] = eligible.map((t) => {
        const e = edits[t.id];
        const listOverride = e.listOverride.trim();
        const pts = e.points.trim();
        return {
          meetsyTaskId: t.id,
          ...(listOverride ? { listId: listOverride } : {}),
          clickupUserId: e.clickupUserId,
          title: t.title,
          description: t.description,
          acceptanceCriteria: t.acceptanceCriteria,
          evidence: t.evidence,
          priority: e.priority,
          dueDate: e.dueDate ? e.dueDate : null,
          tags: t.tags,
          subtasks: t.subtasks,
          dependencies: t.dependencies,
          ...(e.clientOptionId ? { clientOptionId: e.clientOptionId } : {}),
          ...(pts !== "" && Number.isFinite(Number(pts)) ? { points: Number(pts) } : {}),
        };
      });

      const res = await api.pushRun(runId, payload);
      setResults((prev) => {
        const next = { ...prev };
        for (const r of res.results) next[r.meetsyTaskId] = r;
        return next;
      });
      // Re-fetch to lock newly-pushed rows authoritatively.
      await load();
    } catch (err) {
      setPushError(
        err instanceof ApiError ? err.message : "Could not push to ClickUp.",
      );
    } finally {
      setPushing(false);
    }
  };

  // Phase 2c.3 — pull the live client dropdown options + sprint lists from ClickUp.
  const handleRefreshFields = async () => {
    if (!config) return;
    setRefreshing(true);
    setPushError(null);
    try {
      await api.refreshPushFields(config.workspaceId);
      await load();
    } catch (err) {
      setPushError(err instanceof ApiError ? err.message : "Could not refresh fields.");
    } finally {
      setRefreshing(false);
    }
  };

  // v2 Phase 2 (PR-K) — bulk retry the run's failed pushes. The endpoint fans
  // out one BullMQ job per failed row (see PushRetryService); status will
  // reflect the retries after the workers process them, so we schedule a
  // gentle reload a couple of seconds later to catch the post-retry state.
  const failedCount = status.pushes.filter((p) => p.status === "failed").length;
  const handleRetryFailed = async () => {
    if (failedCount === 0) return;
    setRetrying(true);
    setPushError(null);
    setRetryStatus(null);
    try {
      const res = await api.retryFailedPushes(runId);
      setRetryStatus(
        `Retry queued for ${res.enqueued.length} push${res.enqueued.length === 1 ? "" : "es"}. Refreshing…`,
      );
      // Poll once after a short delay so post-retry outcomes surface without
      // requiring a page reload. The worker's typical wall time is < 2s per row.
      setTimeout(() => {
        void load();
      }, 3000);
    } catch (err) {
      setPushError(err instanceof ApiError ? err.message : "Could not enqueue retries.");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-700">
            Push to ClickUp
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Target list:{" "}
            <span className="font-medium text-zinc-600">
              {config.targetListName ?? config.targetListId}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={handleRefreshFields} disabled={refreshing || pushing}>
            {refreshing ? <Spinner label="Refreshing…" /> : "Refresh ClickUp fields"}
          </Button>
          {failedCount > 0 && (
            <Button
              variant="secondary"
              onClick={handleRetryFailed}
              disabled={retrying || pushing}
              title="Enqueue a retry for every failed push on this run"
            >
              {retrying ? <Spinner label="Retrying…" /> : `Retry failed (${failedCount})`}
            </Button>
          )}
          <Button onClick={handlePush} disabled={pushing || eligible.length === 0}>
            {pushing ? (
              <Spinner label="Pushing…" />
            ) : (
              `Push to ClickUp${eligible.length ? ` (${eligible.length})` : ""}`
            )}
          </Button>
        </div>
      </div>

      {pushError && <ErrorBanner message={pushError} />}
      {retryStatus && !pushError && (
        <p className="text-xs font-medium text-green-700">{retryStatus}</p>
      )}

      <div className="space-y-2">
        {tasks.map((t) => (
          <TaskPushRow
            key={t.id}
            task={t}
            edit={edits[t.id]}
            members={config.assignableMembers}
            config={config}
            pushed={pushedBy.get(t.id) ?? null}
            result={results[t.id] ?? null}
            disabled={pushing}
            onChange={(patch) => updateEdit(t.id, patch)}
          />
        ))}
      </div>

      <LearningPanel workspaceId={config.workspaceId} />
    </Card>
  );
}

/**
 * Phase 3.2 "what we've learned": the gated corrections + the two HONEST metrics,
 * kept distinct — raw-model override rate (a KB-quality proxy) vs nudge-acceptance
 * (the loop's actual lift). Collapsed by default; silent when there's no history.
 */
function LearningPanel({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<import("@/lib/api").LearningSummary | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getLearning(workspaceId)
      .then((d) => live && setData(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workspaceId]);

  if (!data || data.totalOverrides === 0) return null;
  const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);

  return (
    <details className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-zinc-700">
        What we&apos;ve learned
        <span className="ml-1 font-normal text-zinc-400">({data.totalOverrides} past push{data.totalOverrides === 1 ? "" : "es"})</span>
      </summary>
      <div className="mt-3 space-y-3">
        {data.fields.map((f) => (
          <div key={f.field}>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{f.field}</p>
            <p className="mt-0.5 text-xs text-zinc-500">
              Raw model accuracy proxy: {pct(f.rawOverrideRate)} changed (n={f.rawSample}) · Nudge acceptance: {pct(f.nudgeAcceptanceRate)} (n={f.nudgeSample})
              {f.unresolved > 0 && <span className="text-amber-600"> · {f.unresolved} unresolved</span>}
            </p>
            {f.corrections.filter((c) => c.gatePassed).length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {f.corrections
                  .filter((c) => c.gatePassed)
                  .map((c, i) => (
                    <li key={i} className="text-xs text-zinc-600">
                      <span className="text-zinc-400">{c.predicted}</span> → <span className="font-medium">{c.confirmed}</span>
                      <span className="text-zinc-400"> ({c.count}×, {Math.round(c.agreement * 100)}% agree)</span>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-zinc-400">Not enough consistent corrections to adjust yet.</p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function TaskPushRow({
  task,
  edit,
  members,
  config,
  pushed,
  result,
  disabled,
  onChange,
}: {
  task: Task;
  edit: PushEdit | undefined;
  members: AssignableMember[];
  config: import("@/lib/api").PushConfigView;
  pushed: PushAuditRow | null;
  result: PushResult | null;
  disabled: boolean;
  onChange: (patch: Partial<PushEdit>) => void;
}) {
  // Locked: already pushed (from a prior push or this session). Show the link.
  if (pushed) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
        <span className="min-w-0 truncate text-sm font-medium text-zinc-800">
          <span className="mr-1.5 text-green-600">✓</span>
          {task.title}
        </span>
        {pushed.clickupUrl ? (
          <a
            href={pushed.clickupUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-xs font-medium text-green-700 underline underline-offset-2"
          >
            View in ClickUp →
          </a>
        ) : (
          <span className="shrink-0 text-xs text-green-700">Pushed</span>
        )}
      </div>
    );
  }

  if (!edit) return null;

  return (
    <div className="rounded-lg border border-zinc-200 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={edit.include}
          disabled={disabled}
          onChange={(e) => onChange({ include: e.target.checked })}
          className="mt-1 h-4 w-4 rounded border-zinc-300"
          aria-label={`Include "${task.title}" in push`}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="truncate text-sm font-medium text-zinc-800">
            {task.title}
          </p>

          <div className="flex flex-wrap gap-2">
            {/* Assignee — from the allowlist only. */}
            <label className="flex flex-col text-[11px] text-zinc-400">
              Assignee
              <select
                value={edit.clickupUserId ?? ""}
                disabled={disabled}
                onChange={(e) =>
                  onChange({ clickupUserId: e.target.value || null })
                }
                className="mt-0.5 rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-800 focus:border-zinc-400 focus:outline-none"
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.clickupUserId} value={m.clickupUserId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>

            {/* Priority. */}
            <label className="flex flex-col text-[11px] text-zinc-400">
              Priority
              <select
                value={edit.priority}
                disabled={disabled}
                onChange={(e) =>
                  onChange({ priority: e.target.value as TaskPriority })
                }
                className="mt-0.5 rounded-md border border-zinc-300 px-2 py-1 text-sm capitalize text-zinc-800 focus:border-zinc-400 focus:outline-none"
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p} value={p} className="capitalize">
                    {p}
                  </option>
                ))}
              </select>
            </label>

            {/* Due date. */}
            <label className="flex flex-col text-[11px] text-zinc-400">
              Due date
              <input
                type="date"
                value={edit.dueDate}
                disabled={disabled}
                onChange={(e) => onChange({ dueDate: e.target.value })}
                className="mt-0.5 rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-800 focus:border-zinc-400 focus:outline-none"
              />
            </label>

            {/* Sprint = the target list. A select when refresh-fields has run; a
                free-text list-id override otherwise. (Phase 2c.3) */}
            <label className="flex flex-col text-[11px] text-zinc-400">
              Sprint / list
              {config.sprintLists && config.sprintLists.length > 0 ? (
                <select
                  value={edit.listOverride}
                  disabled={disabled}
                  onChange={(e) => onChange({ listOverride: e.target.value })}
                  className="mt-0.5 rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-800 focus:border-zinc-400 focus:outline-none"
                >
                  <option value="">Default ({config.targetListName ?? config.targetListId})</option>
                  {config.sprintLists.map((l) => (
                    <option key={l.listId} value={l.listId}>{l.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={edit.listOverride}
                  disabled={disabled}
                  placeholder="default list"
                  onChange={(e) => onChange({ listOverride: e.target.value })}
                  className="mt-0.5 w-32 rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
                />
              )}
            </label>

            {/* Client dropdown (Phase 2c.3) — only when a client field is configured. */}
            {config.clientFieldId && (config.clientOptions?.length ?? 0) > 0 && (
              <label className="flex flex-col text-[11px] text-zinc-400">
                {config.clientFieldName ?? "Client"}
                <select
                  value={edit.clientOptionId}
                  disabled={disabled}
                  onChange={(e) => onChange({ clientOptionId: e.target.value })}
                  className="mt-0.5 rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-800 focus:border-zinc-400 focus:outline-none"
                >
                  <option value="">—</option>
                  {config.clientOptions!.map((o) => (
                    <option key={o.optionId} value={o.optionId}>{o.name}</option>
                  ))}
                </select>
              </label>
            )}

            {/* Points (Phase 2c.3) — only when enabled. */}
            {config.pointsEnabled && (
              <label className="flex flex-col text-[11px] text-zinc-400">
                Points
                <input
                  type="number"
                  min={0}
                  value={edit.points}
                  disabled={disabled}
                  placeholder="—"
                  onChange={(e) => onChange({ points: e.target.value })}
                  className="mt-0.5 w-20 rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-800 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none"
                />
              </label>
            )}
          </div>

          {/* Last push outcome for this row (failed/skipped surface here). */}
          {result && result.status !== "pushed" && (
            <p
              className={`text-xs ${
                result.status === "failed" ? "text-red-600" : "text-zinc-500"
              }`}
            >
              {result.status === "failed"
                ? `✗ ${result.error ?? "Push failed"}`
                : "Skipped (already pushed)"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
