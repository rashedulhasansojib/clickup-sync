import type {
  AssignmentCandidate,
  DuplicateHit,
  DuePrediction,
  FieldAdjustment,
  FieldPrediction,
  KbContextHit,
  ReviewResult,
  TaskAdjustments,
  TaskAssignment,
  TaskPrediction,
} from "@ma/shared";

/**
 * Phase 2c/3 review-UI signals. All shapes are now defined in @ma/shared
 * (`ReviewResultSchema`) as the single source of truth — the API validates writes
 * with the same schemas so signals round-trip through feedback + chat mutations.
 */
export type {
  AssignmentCandidate,
  DuplicateHit,
  DuePrediction,
  FieldAdjustment,
  FieldPrediction,
  KbContextHit,
  ReviewResult,
  TaskAdjustments,
  TaskAssignment,
  TaskPrediction,
};

export interface TaskSignalData {
  prediction?: TaskPrediction;
  duplicates?: DuplicateHit[];
  assignment?: TaskAssignment;
  adjustment?: TaskAdjustments;
}

export function signalsForTask(result: ReviewResult, taskId: string): TaskSignalData {
  return {
    prediction: result.fieldPredictions?.[taskId],
    duplicates: result.duplicates?.[taskId],
    assignment: result.assignment?.[taskId],
    adjustment: result.adjustments?.[taskId],
  };
}

// ── small chips ───────────────────────────────────────────────────────────────
type Tone = "zinc" | "blue" | "amber" | "red" | "green" | "violet";
const TONE: Record<Tone, string> = {
  zinc: "bg-zinc-100 text-zinc-600 border-zinc-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  red: "bg-red-50 text-red-700 border-red-200",
  green: "bg-green-50 text-green-700 border-green-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
};
function Chip({ tone = "zinc", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${TONE[tone]}`}>
      {children}
    </span>
  );
}

/** A predicted field: the value + confidence, or a muted "abstain" when thin. */
function PredChip({ label, p }: { label: string; p: FieldPrediction | undefined }) {
  if (!p || p.abstain || !p.value) {
    return <Chip tone="zinc" title="Not enough similar history to suggest a value">{label}: —</Chip>;
  }
  const tone: Tone = p.confidence === "high" ? "blue" : "zinc";
  return (
    <Chip tone={tone} title={`${p.reason ?? ""}${p.reason ? " · " : ""}support ${p.support}, share ${p.share}, ${p.confidence} confidence`}>
      {label}: <span className="font-medium">{p.value}</span>
      <span className="opacity-60">· {p.support} similar</span>
    </Chip>
  );
}

/**
 * All weak/abstain-first signals for one task: duplicate warnings, suggested
 * fields (client/sprint/due — never auto-applied), the learning-loop nudge, and
 * the ownership-based assignee recommendation.
 */
export function TaskSignals({ signals }: { signals: TaskSignalData }) {
  const { prediction, duplicates, assignment, adjustment } = signals;
  const hasDupes = duplicates && duplicates.length > 0;
  const hasPred = Boolean(prediction);
  const hasAssign = Boolean(assignment);
  const hasAdj = adjustment && adjustment.assignee;
  if (!hasDupes && !hasPred && !hasAssign && !hasAdj) return null;

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-zinc-100 bg-zinc-50/60 p-2.5">
      {/* Duplicate awareness — flag (very likely) / suggest (possibly related). */}
      {hasDupes && (
        <div className="flex flex-wrap items-center gap-1.5">
          {duplicates!.map((d) => (
            <Chip key={d.taskId} tone={d.band === "flag" ? "red" : "amber"} title={`cosine ${d.score} to ClickUp task ${d.taskId}`}>
              {d.band === "flag" ? "⚠ Likely already exists" : "Possibly related"}: {d.taskId}
            </Chip>
          ))}
        </div>
      )}

      {/* Suggested fields (weak priors — confirm on push; never auto-applied). */}
      {hasPred && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">Suggested</span>
          <PredChip label="Sprint" p={prediction!.sprint} />
          <Chip tone={prediction!.due.abstain ? "zinc" : "blue"} title={prediction!.due.abstain ? "no cycle-time precedent" : `p80 cycle ${prediction!.due.cycleDaysP80}d over ${prediction!.due.basedOnClosedTasks} closed similar`}>
            Due: <span className="font-medium">{prediction!.due.abstain ? "—" : prediction!.due.date}</span>
          </Chip>
          <PredChip label="Estimate" p={prediction!.estimate} />
        </div>
      )}

      {/* Learning-loop nudge — only shown when ≥3 consistent past corrections. */}
      {hasAdj && (
        <div className="flex flex-wrap items-center gap-1.5">
          {adjustment!.assignee && (
            <Chip tone="violet" title={`agreement ${adjustment!.assignee.agreement}`}>
              Adjusted owner: {adjustment!.assignee.from} → <span className="font-medium">{adjustment!.assignee.to}</span>
              <span className="opacity-60">· from {adjustment!.assignee.count} past corrections</span>
            </Chip>
          )}
        </div>
      )}

      {/* Ownership-based assignee recommendation (abstain-first; you confirm). */}
      {hasAssign && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">Owner</span>
          {assignment!.recommended ? (
            <Chip tone="green" title={assignment!.rationale}>
              Suggested: <span className="font-medium">{assignment!.recommended.name}</span>
              <span className="opacity-60">· {assignment!.recommended.closedSimilar} closed similar</span>
            </Chip>
          ) : (
            <Chip tone="zinc" title={assignment!.rationale}>No clear owner from history</Chip>
          )}
        </div>
      )}
    </div>
  );
}

/** Run-level: "grounded in N items of this client's history" with a peek. */
export function KbContextBanner({ hits }: { hits: KbContextHit[] | undefined }) {
  if (!hits || hits.length === 0) return null;
  const tasks = hits.filter((h) => h.sourceType !== "document").length;
  const docs = hits.length - tasks;
  return (
    <details className="rounded-xl border border-zinc-200 bg-white p-4 text-sm shadow-sm">
      <summary className="cursor-pointer font-medium text-zinc-700">
        Grounded in {hits.length} item{hits.length === 1 ? "" : "s"} of this client&apos;s history
        <span className="ml-1 font-normal text-zinc-400">({tasks} task{tasks === 1 ? "" : "s"}{docs ? `, ${docs} doc${docs === 1 ? "" : "s"}` : ""})</span>
      </summary>
      <ul className="mt-3 space-y-1.5">
        {hits.map((h, i) => (
          <li key={i} className="flex items-start gap-2 text-xs text-zinc-500">
            <Chip tone={h.sourceType === "document" ? "violet" : "blue"}>{h.sourceType === "document" ? "DOC" : "TASK"}</Chip>
            <span className="line-clamp-2">{h.snippet}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
