"use client";

import { useState } from "react";
import type {
  AssignmentCandidate,
  DuplicateHit,
  DuePrediction,
  FieldAdjustment,
  FieldPrediction,
  KbContextHit,
  NeighbourHit,
  PriorCandidate,
  ReviewResult,
  TaskAdjustments,
  TaskAssignment,
  TaskPrediction,
} from "@ma/shared";
import { TaskChip } from "@/components/tasks/task-chip";

/**
 * v2 Phase 2 (PR-J) — evidence-first review signals. Every prediction on a
 * task card now renders WITH its reasons: duplicates, suggested fields plus
 * their kNN candidates, owner ranking with evidence task chips, learning
 * nudges, and the top-3 similar historical tasks. All shapes come from
 * `@ma/shared` (`ReviewResultSchema`) — the API validates writes with the
 * same schemas so signals round-trip through feedback + chat mutations.
 */
export type {
  AssignmentCandidate,
  DuplicateHit,
  DuePrediction,
  FieldAdjustment,
  FieldPrediction,
  KbContextHit,
  NeighbourHit,
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
  neighbours?: NeighbourHit[];
}

export function signalsForTask(result: ReviewResult, taskId: string): TaskSignalData {
  return {
    prediction: result.fieldPredictions?.[taskId],
    duplicates: result.duplicates?.[taskId],
    assignment: result.assignment?.[taskId],
    adjustment: result.adjustments?.[taskId],
    neighbours: result.neighboursByTask?.[taskId],
  };
}

// ── small chips ───────────────────────────────────────────────────────────────
type Tone = "zinc" | "blue" | "amber" | "red" | "green" | "violet";
const TONE: Record<Tone, string> = {
  zinc: "bg-muted text-muted-foreground border-border",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  red: "bg-red-50 text-red-700 border-red-200",
  green: "bg-green-50 text-green-700 border-green-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
};
function Chip({
  tone = "zinc",
  children,
  title,
}: {
  tone?: Tone;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

// ── prediction chips ─────────────────────────────────────────────────────────

/** A predicted field: the value + confidence, or a muted "abstain" when thin. */
function PredChip({ label, p }: { label: string; p: FieldPrediction | undefined }) {
  if (!p || p.abstain || !p.value) {
    return (
      <Chip tone="zinc" title="Not enough similar history to suggest a value">
        {label}: —
      </Chip>
    );
  }
  const tone: Tone = p.confidence === "high" ? "blue" : "zinc";
  return (
    <Chip
      tone={tone}
      title={`${p.reason ?? ""}${p.reason ? " · " : ""}support ${p.support}, share ${p.share}, ${p.confidence} confidence`}
    >
      {label}: <span className="font-medium">{p.value}</span>
      <span className="opacity-60">· {p.support} similar</span>
      {p.isModal === false && (
        <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-700">
          clamp
        </span>
      )}
    </Chip>
  );
}

/** The kNN candidates that produced a field prediction (`value (n · share%)`). */
function CandidateStrip({
  candidates,
  picked,
}: {
  candidates: PriorCandidate[];
  picked: string | null;
}) {
  if (!candidates || candidates.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">from</span>
      {candidates.slice(0, 4).map((c) => (
        <span
          key={c.value}
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
            c.value === picked
              ? "border-blue-200 bg-blue-50 text-blue-700"
              : "border-border bg-card text-muted-foreground"
          }`}
          title={`support ${c.support}, share ${Math.round(c.share * 100)}%`}
        >
          <span className={c.value === picked ? "font-medium" : ""}>{c.value}</span>
          <span className="opacity-70">· {Math.round(c.share * 100)}%</span>
        </span>
      ))}
    </div>
  );
}

// ── evidence sections ────────────────────────────────────────────────────────

function DuplicatesSection({
  duplicates,
  workspaceId,
}: {
  duplicates: DuplicateHit[];
  workspaceId: string | null;
}) {
  if (duplicates.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Duplicates
      </span>
      {duplicates.map((d) => {
        const label = d.band === "flag" ? "⚠ Likely" : "Possibly";
        const tone: Tone = d.band === "flag" ? "red" : "amber";
        return workspaceId ? (
          <TaskChip
            key={d.taskId}
            taskId={d.taskId}
            tone={tone}
            title={`cosine ${d.score} to ClickUp task ${d.taskId}`}
          >
            {label}: {d.taskId}
          </TaskChip>
        ) : (
          <Chip key={d.taskId} tone={tone} title={`cosine ${d.score}`}>
            {label}: {d.taskId}
          </Chip>
        );
      })}
    </div>
  );
}

function SuggestedSection({ prediction }: { prediction: TaskPrediction }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Suggested
        </span>
        <PredChip label="Sprint" p={prediction.sprint} />
        <Chip
          tone={prediction.due.abstain ? "zinc" : "blue"}
          title={
            prediction.due.abstain
              ? "no cycle-time precedent"
              : `p80 cycle ${prediction.due.cycleDaysP80}d over ${prediction.due.basedOnClosedTasks} closed similar`
          }
        >
          Due:{" "}
          <span className="font-medium">
            {prediction.due.abstain ? "—" : prediction.due.date}
          </span>
        </Chip>
        <PredChip label="Estimate" p={prediction.estimate} />
      </div>

      {/* Candidates behind each field prediction — the sim-weighted distribution. */}
      {prediction.sprint.candidates.length > 0 && (
        <div className="ml-1 border-l border-border pl-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
            sprint candidates
          </div>
          <CandidateStrip
            candidates={prediction.sprint.candidates}
            picked={prediction.sprint.value}
          />
        </div>
      )}
      {prediction.estimate.candidates.length > 0 && (
        <div className="ml-1 border-l border-border pl-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
            estimate candidates
          </div>
          <CandidateStrip
            candidates={prediction.estimate.candidates}
            picked={prediction.estimate.value}
          />
        </div>
      )}
    </div>
  );
}

function OwnerRankingSection({
  assignment,
  workspaceId,
}: {
  assignment: TaskAssignment;
  workspaceId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? assignment.ranked : assignment.ranked.slice(0, 3);
  const extra = assignment.ranked.length - shown.length;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Owner
        </span>
        {assignment.recommended ? (
          <Chip tone="green" title={assignment.rationale}>
            Suggested: <span className="font-medium">{assignment.recommended.name}</span>
            <span className="opacity-60">· {assignment.recommended.closedSimilar} closed similar</span>
          </Chip>
        ) : (
          <Chip tone="zinc" title={assignment.rationale}>
            No clear owner from history
          </Chip>
        )}
      </div>

      {assignment.ranked.length > 0 && (
        <div className="ml-1 space-y-1.5 border-l border-border pl-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">ranking</div>
          {shown.map((cand, i) => (
            <RankedRow
              key={`${cand.clickupUserId ?? "null"}:${i}`}
              cand={cand}
              rank={i + 1}
              recommended={cand.clickupUserId === assignment.recommended?.clickupUserId}
              workspaceId={workspaceId}
            />
          ))}
          {extra > 0 && !expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              Show {extra} more
            </button>
          )}
          {expanded && extra === 0 && assignment.ranked.length > 3 && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RankedRow({
  cand,
  rank,
  recommended,
  workspaceId,
}: {
  cand: AssignmentCandidate;
  rank: number;
  recommended: boolean;
  workspaceId: string | null;
}) {
  const scorePct = Math.round(Math.min(1, Math.max(0, cand.ownershipScore)) * 100);
  return (
    <div className="space-y-0.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="w-4 text-right tabular-nums text-muted-foreground/70">{rank}.</span>
        <span className={recommended ? "font-medium text-foreground" : "text-foreground"}>
          {cand.name}
        </span>
        {!cand.inPool && (
          <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
            not in pool
          </span>
        )}
        <span className="ml-auto tabular-nums text-muted-foreground">
          {cand.closedSimilar} closed · {cand.openTasks} open · {cand.trackedHours30d.toFixed(1)}h/30d
        </span>
      </div>
      <div className="ml-6 flex items-center gap-2">
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full ${recommended ? "bg-green-500" : "bg-muted-foreground/70"}`}
            style={{ width: `${scorePct}%` }}
          />
        </div>
        <span className="tabular-nums text-[11px] text-muted-foreground/70">{scorePct}%</span>
      </div>
      {cand.evidenceTaskIds.length > 0 && (
        <div className="ml-6 flex flex-wrap items-center gap-1 pt-1">
          <span className="text-[10px] text-muted-foreground/70">evidence</span>
          {cand.evidenceTaskIds.slice(0, 5).map((tid) =>
            workspaceId ? (
              <TaskChip key={tid} taskId={tid} tone="blue">
                {tid}
              </TaskChip>
            ) : (
              <Chip key={tid} tone="blue">
                {tid}
              </Chip>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function NudgeSection({ adjustment }: { adjustment: TaskAdjustments }) {
  const rows: Array<{ field: string; a: FieldAdjustment }> = [];
  if (adjustment.assignee) rows.push({ field: "owner", a: adjustment.assignee });
  if (adjustment.sprint) rows.push({ field: "sprint", a: adjustment.sprint });
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Learned
      </span>
      {rows.map(({ field, a }) => (
        <Chip
          key={field}
          tone="violet"
          title={`agreement ${a.agreement} across ${a.count} past corrections`}
        >
          Adjusted {field}: {a.from} → <span className="font-medium">{a.to}</span>
          <span className="opacity-60">· from {a.count} corrections</span>
        </Chip>
      ))}
    </div>
  );
}

function NeighboursSection({
  neighbours,
  workspaceId,
}: {
  neighbours: NeighbourHit[];
  workspaceId: string | null;
}) {
  if (neighbours.length === 0) return null;
  const top = neighbours.slice(0, 3);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Similar
      </span>
      {top.map((n) => {
        const pct = Math.round(Math.min(1, Math.max(0, n.sim)) * 100);
        const title = [
          n.assignee ? `assignee ${n.assignee}` : null,
          n.sprint ? `sprint ${n.sprint}` : null,
          n.client ? `client ${n.client}` : null,
          `cosine ${n.sim.toFixed(3)}`,
        ]
          .filter(Boolean)
          .join(" · ");
        return workspaceId ? (
          <TaskChip key={n.taskId} taskId={n.taskId} tone="blue" title={title}>
            {n.taskId} <span className="opacity-70">· {pct}%</span>
          </TaskChip>
        ) : (
          <Chip key={n.taskId} tone="blue" title={title}>
            {n.taskId} · {pct}%
          </Chip>
        );
      })}
    </div>
  );
}

/**
 * v2 Phase 2 (PR-J) — the composite evidence panel for one task card.
 * Everything is expanded by default (audience decision: IC engineers checking
 * their own assignments). Panels short-circuit when their signal is absent so
 * a run that abstained on everything renders nothing.
 */
export function TaskSignals({
  signals,
  workspaceId,
}: {
  signals: TaskSignalData;
  workspaceId: string | null;
}) {
  const { prediction, duplicates, assignment, adjustment, neighbours } = signals;
  const hasDupes = duplicates && duplicates.length > 0;
  const hasPred = Boolean(prediction);
  const hasAssign = Boolean(assignment);
  const hasAdj = adjustment && (adjustment.assignee || adjustment.sprint);
  const hasNeighbours = neighbours && neighbours.length > 0;
  if (!hasDupes && !hasPred && !hasAssign && !hasAdj && !hasNeighbours) return null;

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border bg-muted/50/60 p-3">
      {hasDupes && (
        <DuplicatesSection duplicates={duplicates!} workspaceId={workspaceId} />
      )}
      {hasPred && <SuggestedSection prediction={prediction!} />}
      {hasAssign && (
        <OwnerRankingSection assignment={assignment!} workspaceId={workspaceId} />
      )}
      {hasAdj && <NudgeSection adjustment={adjustment!} />}
      {hasNeighbours && (
        <NeighboursSection neighbours={neighbours!} workspaceId={workspaceId} />
      )}
    </div>
  );
}

/** Run-level: "grounded in N items of this client's history" with a peek. */
export function KbContextBanner({
  hits,
  workspaceId,
}: {
  hits: KbContextHit[] | undefined;
  workspaceId: string | null;
}) {
  if (!hits || hits.length === 0) return null;
  const tasks = hits.filter((h) => h.sourceType !== "document").length;
  const docs = hits.length - tasks;
  return (
    <details className="rounded-xl border border-border bg-card p-4 text-sm shadow-sm">
      <summary className="cursor-pointer font-medium text-foreground">
        Grounded in {hits.length} item{hits.length === 1 ? "" : "s"} of this
        client&apos;s history
        <span className="ml-1 font-normal text-muted-foreground/70">
          ({tasks} task{tasks === 1 ? "" : "s"}
          {docs ? `, ${docs} doc${docs === 1 ? "" : "s"}` : ""})
        </span>
      </summary>
      <ul className="mt-3 space-y-1.5">
        {hits.map((h, i) => (
          <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
            {h.sourceType === "clickup_task" && workspaceId ? (
              <TaskChip taskId={h.sourceId} tone="blue">
                TASK · {h.sourceId}
              </TaskChip>
            ) : (
              <Chip tone={h.sourceType === "document" ? "violet" : "blue"}>
                {h.sourceType === "document" ? "DOC" : "TASK"}
                {h.sourceType !== "document" ? ` · ${h.sourceId}` : ""}
              </Chip>
            )}
            <span className="line-clamp-2">{h.snippet}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
