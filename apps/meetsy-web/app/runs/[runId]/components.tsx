"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  AnalysisResult,
  ChatMessage,
  FeedbackItem,
  PersonTasks,
  Task,
  TaskVote,
  PipelineStage,
  ProgressEvent as PipelineProgressEvent,
} from "@ma/shared";
import { api, ApiError } from "@/lib/api";
import { Button, Card, ErrorBanner, PriorityBadge, Spinner, Tag } from "@/app/ui";

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
  result: AnalysisResult;
  onResultReplace: (result: AnalysisResult) => void;
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
export function ResultView({ result }: { result: AnalysisResult }) {
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
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Tasks by person
        </h2>
        {result.people.length === 0 && (
          <p className="text-sm text-zinc-400">No assigned tasks.</p>
        )}
        {result.people.map((pt) => (
          <PersonSection key={pt.participant.id} personTasks={pt} />
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
              <TaskCard key={t.id} task={t} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function PersonSection({ personTasks }: { personTasks: PersonTasks }) {
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
          tasks.map((t) => <TaskCard key={t.id} task={t} />)
        )}
      </div>
    </div>
  );
}

function TaskCard({ task }: { task: Task }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-medium text-zinc-900">{task.title}</h3>
        <PriorityBadge priority={task.priority} />
      </div>

      {task.description && (
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">
          {task.description}
        </p>
      )}

      {(task.dueDate || task.estimate) && (
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-zinc-500">
          {task.dueDate && (
            <span>
              <span className="font-medium text-zinc-400">Due: </span>
              {task.dueDate}
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
  onResultReplace: (result: AnalysisResult) => void;
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
