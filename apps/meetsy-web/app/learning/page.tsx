"use client";

import { useEffect, useMemo, useState } from "react";
import {
  api,
  ApiError,
  type LearningCorrection,
  type LearningFieldSummary,
  type LearningGateView,
  type LearningPatternHistoryView,
  type LearningSummary,
  type LearnField,
} from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-context";
import { Card, ErrorBanner, Spinner } from "@/app/ui";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * v2 Phase 3 (PR-O) — `/learning` workspace page. Three stacked sections:
 *   - Active: patterns the loop is currently applying (gatePassed).
 *   - Building up: near-gate patterns (progress bar toward MIN_CORRECTIONS).
 *   - Coverage: how many predictions the loop has seen, per field, and how
 *     many nudges landed vs were accepted (the honest loop-lift metric).
 *
 * Rows click open a side sheet with the pattern's chronological history.
 * Metric jargon is renamed to plain English at THIS layer only; the API
 * shape stays the same (`LearningPanel` in `runs/[runId]/components.tsx`
 * still uses `rawOverrideRate` — see spec §3.6).
 */
export default function LearningPage() {
  const { activeWorkspaceId } = useWorkspace();
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  const [gate, setGate] = useState<LearningGateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([
      api.getLearning(activeWorkspaceId),
      api.getLearningGate(activeWorkspaceId),
    ])
      .then(([s, g]) => {
        if (!active) return;
        setSummary(s);
        setGate(g);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) return;
        setError(err instanceof ApiError ? err.message : "Could not load learning data.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeWorkspaceId]);

  const activeByField = useMemo<Record<LearnField, LearningCorrection[]>>(() => {
    const out: Record<LearnField, LearningCorrection[]> = { assignee: [], sprint: [] };
    for (const f of summary?.fields ?? []) {
      out[f.field] = f.corrections.filter((c) => c.gatePassed);
    }
    return out;
  }, [summary]);

  const buildingByField = useMemo<Record<LearnField, LearningCorrection[]>>(() => {
    const out: Record<LearnField, LearningCorrection[]> = { assignee: [], sprint: [] };
    for (const f of summary?.fields ?? []) {
      out[f.field] = f.corrections.filter((c) => !c.gatePassed && c.count >= 1);
    }
    return out;
  }, [summary]);

  const totalActive = activeByField.assignee.length + activeByField.sprint.length;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Learning</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What patterns the loop has learned in this workspace — and what it&apos;s
          about to.
        </p>
      </header>

      {loading && (
        <Card className="flex items-center justify-center p-8">
          <Spinner label="Loading learning data…" />
        </Card>
      )}

      {error && !loading && <ErrorBanner message={error} />}

      {!loading && !error && summary && gate && (
        <>
          <SummaryHeader
            totalOverrides={summary.totalOverrides}
            totalActive={totalActive}
            gate={gate}
          />

          <ActiveSection
            active={activeByField}
            onOpen={(key) => setOpenKey(key)}
            gate={gate}
          />

          <BuildingSection
            building={buildingByField}
            gate={gate}
            onOpen={(key) => setOpenKey(key)}
          />

          <CoverageSection fields={summary.fields} />
        </>
      )}

      {activeWorkspaceId && (
        <PatternHistorySheet
          workspaceId={activeWorkspaceId}
          patternKey={openKey}
          onClose={() => setOpenKey(null)}
        />
      )}
    </div>
  );
}

function SummaryHeader({
  totalOverrides,
  totalActive,
  gate,
}: {
  totalOverrides: number;
  totalActive: number;
  gate: LearningGateView;
}) {
  return (
    <Card className="grid gap-4 p-5 sm:grid-cols-3">
      <Stat label="Corrections logged" value={totalOverrides.toLocaleString()} />
      <Stat label="Active nudges" value={String(totalActive)} />
      <Stat
        label="To learn a pattern"
        value={`${gate.minCorrections} corrections`}
        hint={`with ≥${Math.round(gate.minAgreement * 100)}% consistency`}
      />
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function ActiveSection({
  active,
  onOpen,
  gate,
}: {
  active: Record<LearnField, LearningCorrection[]>;
  onOpen: (key: string) => void;
  gate: LearningGateView;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Active
      </h2>
      <p className="text-xs text-muted-foreground">
        Patterns the loop applies to new runs. Fires when a prediction matches{" "}
        <code className="text-muted-foreground/70">predicted</code> and enough corrections
        agreed on the same fix.
      </p>
      {gate.fields.map((field) => (
        <FieldBlock
          key={field}
          field={field}
          rows={active[field]}
          renderRow={(row) => (
            <PatternRow key={row.key} row={row} onOpen={onOpen} showAgreement />
          )}
          emptyText={emptyActiveText(field)}
        />
      ))}
    </section>
  );
}

function BuildingSection({
  building,
  gate,
  onOpen,
}: {
  building: Record<LearnField, LearningCorrection[]>;
  gate: LearningGateView;
  onOpen: (key: string) => void;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Building up
      </h2>
      <p className="text-xs text-muted-foreground">
        Patterns partway to the gate. Each one is a{" "}
        <code className="text-muted-foreground/70">predicted → confirmed</code> the model
        has seen at least once organically.
      </p>
      {gate.fields.map((field) => (
        <FieldBlock
          key={field}
          field={field}
          rows={building[field]}
          renderRow={(row) => (
            <ProgressRow
              key={row.key}
              row={row}
              target={gate.minCorrections}
              onOpen={onOpen}
            />
          )}
          emptyText="No corrections seen yet."
        />
      ))}
    </section>
  );
}

function CoverageSection({ fields }: { fields: LearningFieldSummary[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Coverage
      </h2>
      <p className="text-xs text-muted-foreground">
        How much of your push history the loop has actually reasoned over.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {fields.map((f) => (
          <CoverageCard key={f.field} field={f} />
        ))}
      </div>
    </section>
  );
}

function CoverageCard({ field }: { field: LearningFieldSummary }) {
  const changed =
    field.rawOverrideRate == null
      ? "—"
      : `${Math.round(field.rawOverrideRate * 100)}%`;
  const accepted =
    field.nudgeAcceptanceRate == null
      ? "—"
      : `${Math.round(field.nudgeAcceptanceRate * 100)}%`;
  return (
    <Card className="space-y-2 p-4">
      <div className="text-sm font-medium capitalize text-foreground">{field.field}</div>
      <dl className="space-y-1 text-xs text-muted-foreground">
        <MetricRow label="Predictions seen" value={String(field.rawSample)} />
        <MetricRow label="Predictions you changed" value={`${changed} (of ${field.rawSample})`} />
        <MetricRow
          label="Suggestions shown"
          value={String(field.nudgeSample)}
          hint="how many pushes carried a loop nudge"
        />
        <MetricRow label="Suggestions accepted" value={`${accepted} (of ${field.nudgeSample})`} />
        {field.unresolved > 0 && (
          <MetricRow
            label="Unresolved"
            value={String(field.unresolved)}
            hint="confirmed values that didn't resolve to a name (config drift)"
            danger
          />
        )}
      </dl>
    </Card>
  );
}

function MetricRow({
  label,
  value,
  hint,
  danger,
}: {
  label: string;
  value: string;
  hint?: string;
  danger?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div className="flex items-baseline gap-1.5">
        <dt className="text-muted-foreground">{label}</dt>
        {hint && <span className="text-[10px] text-muted-foreground/70">{hint}</span>}
      </div>
      <dd
        className={
          danger
            ? "font-medium tabular-nums text-amber-700"
            : "font-medium tabular-nums text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function FieldBlock({
  field,
  rows,
  renderRow,
  emptyText,
}: {
  field: LearnField;
  rows: LearningCorrection[];
  renderRow: (row: LearningCorrection) => React.ReactNode;
  emptyText: string;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {fieldLabel(field)}
      </div>
      {rows.length === 0 ? (
        <Card className="p-3 text-xs text-muted-foreground">{emptyText}</Card>
      ) : (
        <div className="space-y-1.5">{rows.map(renderRow)}</div>
      )}
    </div>
  );
}

function PatternRow({
  row,
  onOpen,
  showAgreement,
}: {
  row: LearningCorrection;
  onOpen: (key: string) => void;
  showAgreement?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(row.key)}
      className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:border-border hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-blue-300"
    >
      <div className="flex-1 truncate">
        <span className="text-muted-foreground">{row.predicted}</span>
        <span className="mx-1.5 text-muted-foreground/70">→</span>
        <span className="font-medium text-foreground">{row.confirmed}</span>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{row.count}</span> corrections
        </span>
        {showAgreement && (
          <span>
            <span className="font-medium text-foreground">{Math.round(row.agreement * 100)}%</span>{" "}
            consistency
          </span>
        )}
      </div>
    </button>
  );
}

function ProgressRow({
  row,
  target,
  onOpen,
}: {
  row: LearningCorrection;
  target: number;
  onOpen: (key: string) => void;
}) {
  const pct = Math.min(100, Math.round((row.count / target) * 100));
  return (
    <button
      type="button"
      onClick={() => onOpen(row.key)}
      className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:border-border hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-blue-300"
    >
      <div className="flex-1 truncate">
        <span className="text-muted-foreground">{row.predicted}</span>
        <span className="mx-1.5 text-muted-foreground/70">→</span>
        <span className="font-medium text-foreground">{row.confirmed}</span>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground">
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-muted-foreground" style={{ width: `${pct}%` }} />
        </div>
        <span className="font-medium text-foreground">
          {row.count} of {target}
        </span>
      </div>
    </button>
  );
}

function PatternHistorySheet({
  workspaceId,
  patternKey,
  onClose,
}: {
  workspaceId: string;
  patternKey: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<LearningPatternHistoryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!patternKey) return;
    let active = true;
    setLoading(true);
    setError(null);
    setData(null);
    void api
      .getLearningPatternHistory(workspaceId, patternKey)
      .then((view) => {
        if (!active) return;
        setData(view);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) return;
        setError(err instanceof ApiError ? err.message : "Could not load history.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, patternKey]);

  return (
    <Sheet open={Boolean(patternKey)} onOpenChange={(v) => (v ? undefined : onClose())}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle>Pattern history</SheetTitle>
          {data && (
            <SheetDescription>
              {fieldLabel(data.field)} · {data.predicted} → {data.confirmed}
            </SheetDescription>
          )}
        </SheetHeader>

        {loading && (
          <Card className="flex items-center justify-center p-6">
            <Spinner label="Loading history…" />
          </Card>
        )}

        {error && !loading && <ErrorBanner message={error} />}

        {!loading && !error && data && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Corrections" value={String(data.count)} />
              <Stat
                label="Consistency"
                value={`${Math.round(data.agreement * 100)}%`}
                hint={data.gatePassed ? "gate passed — nudging" : "not yet gating"}
              />
            </div>

            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                Entries
              </div>
              {data.entries.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No matching entries in the last 500 rows.
                </p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {data.entries.map((e) => (
                    <li
                      key={`${e.runId}:${e.meetsyTaskId}`}
                      className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1"
                    >
                      <span className="truncate text-muted-foreground">
                        Run <code className="text-muted-foreground/70">{e.runId.slice(0, 8)}</code>
                        {e.nudgeShown && (
                          <span className="ml-2 rounded bg-violet-50 px-1 text-[10px] font-medium text-violet-700">
                            nudge shown
                          </span>
                        )}
                      </span>
                      <span className="tabular-nums text-muted-foreground/70">
                        {new Date(e.createdAt).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function fieldLabel(field: LearnField): string {
  switch (field) {
    case "assignee":
      return "Assignee";
    case "sprint":
      return "Sprint";
    default:
      return field;
  }
}

function emptyActiveText(field: LearnField): string {
  return `The loop hasn't gated a ${field} pattern yet — patterns need 3 corrections with ≥60% consistency.`;
}
