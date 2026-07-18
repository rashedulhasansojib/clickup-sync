"use client";

import type { CategoryBucket, KbFacts } from "@/lib/api";
import { Tag } from "@/app/ui";

/**
 * "What we learned" typed sections (Coverage · Throughput · Components · Roster
 * · Workload · Categories · Blockers). Extracted from `app/onboarding/page.tsx`
 * for the v2 Phase 4 `/kb` Overview tab; the wizard used to be this component's
 * only caller and is retired in PR-R.
 */
export function FactsSummary({ facts }: { facts: KbFacts }) {
  const {
    roster,
    components,
    throughput,
    categories,
    workload,
    blockers,
    coverage,
  } = facts;

  const categoryGroups: Array<{ label: string; buckets: CategoryBucket[] }> = [
    { label: "Statuses", buckets: categories.statusDistribution },
    { label: "Top tags", buckets: categories.topTags },
    { label: "Clients", buckets: categories.clients },
    { label: "Departments", buckets: categories.departments },
    { label: "Sprints", buckets: categories.sprints },
  ];
  const nonEmptyCategoryGroups = categoryGroups.filter(
    (g) => g.buckets.length > 0,
  );

  const hasThroughput =
    throughput.openTotal > 0 ||
    throughput.closedTotal > 0 ||
    throughput.medianCycleTimeDays != null;
  const hasBlockers =
    blockers.overdueOpen.count > 0 ||
    blockers.stale.count > 0 ||
    blockers.reopened.count > 0;

  const hasAnything =
    coverage.totalTasks > 0 ||
    roster.length > 0 ||
    components.length > 0 ||
    workload.length > 0 ||
    nonEmptyCategoryGroups.length > 0 ||
    hasThroughput ||
    hasBlockers;

  if (!hasAnything) {
    return (
      <p className="text-sm text-muted-foreground">
        No structured facts yet — the knowledge base is built but didn&apos;t
        surface a summary breakdown.
      </p>
    );
  }

  const COMPONENT_LIMIT = 12;
  const shownComponents = components.slice(0, COMPONENT_LIMIT);
  const extraComponents = components.length - shownComponents.length;

  return (
    <div className="space-y-3">
      {coverage.totalTasks > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/50 p-3 text-sm text-foreground">
          <span>
            <span className="font-semibold text-foreground">
              {coverage.embeddedCount}
            </span>{" "}
            of{" "}
            <span className="font-semibold text-foreground">
              {coverage.totalTasks}
            </span>{" "}
            tasks embedded
          </span>
          <span className="text-muted-foreground/70">·</span>
          <span>
            {coverage.dateRange.earliest ?? "—"} →{" "}
            {coverage.dateRange.latest ?? "—"}
          </span>
          <span className="text-muted-foreground/70">·</span>
          <span>{coverage.commentCoveragePct}% comment coverage</span>
        </div>
      )}

      {hasThroughput && (
        <SectionCard title="Throughput">
          <div className="grid grid-cols-3 gap-2">
            <StatTile label="Open" value={String(throughput.openTotal)} />
            <StatTile label="Closed" value={String(throughput.closedTotal)} />
            <StatTile
              label="Median cycle"
              value={
                throughput.medianCycleTimeDays == null
                  ? "— days"
                  : `${throughput.medianCycleTimeDays.toFixed(1)} days`
              }
            />
          </div>
        </SectionCard>
      )}

      {components.length > 0 && (
        <SectionCard title="Components">
          <ul className="space-y-1 text-sm text-foreground">
            {shownComponents.map((c, i) => (
              <li key={`${c.component}-${i}`}>
                {c.component} ·{" "}
                <span className="text-muted-foreground">{c.taskCount} tasks</span>
              </li>
            ))}
          </ul>
          {extraComponents > 0 && (
            <p className="mt-1 text-xs text-muted-foreground/70">+{extraComponents} more</p>
          )}
        </SectionCard>
      )}

      {roster.length > 0 && (
        <SectionCard title="Roster">
          <ul className="space-y-2.5 text-sm">
            {roster.map((r, i) => (
              <li key={`${r.name}-${i}`} className="space-y-1">
                <div>
                  <span className="font-medium text-foreground">{r.name}</span>
                  {r.email && (
                    <span className="ml-2 text-xs text-muted-foreground/70">{r.email}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {r.taskCount} tasks ({r.openCount} open / {r.closedCount}{" "}
                  closed)
                </p>
                {r.topComponents.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {r.topComponents.map((c, j) => (
                      <Tag key={`${r.name}-c-${j}`}>{c.component}</Tag>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {workload.length > 0 && (
        <SectionCard title="Workload">
          <ul className="space-y-1 text-sm text-foreground">
            {workload.map((w, i) => (
              <li key={`${w.user}-${i}`}>
                {w.user} ·{" "}
                <span className="text-muted-foreground">{w.hours.toFixed(1)} hrs</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {nonEmptyCategoryGroups.length > 0 && (
        <SectionCard title="Categories">
          <div className="space-y-2.5">
            {nonEmptyCategoryGroups.map((g) => (
              <BucketRow key={g.label} label={g.label} buckets={g.buckets} />
            ))}
          </div>
        </SectionCard>
      )}

      {hasBlockers && (
        <SectionCard title="Blockers">
          <div className="grid grid-cols-3 gap-2">
            <StatTile
              label="Overdue open"
              value={String(blockers.overdueOpen.count)}
            />
            <StatTile label="Stale" value={String(blockers.stale.count)} />
            <StatTile label="Reopened" value={String(blockers.reopened.count)} />
          </div>
          {blockers.overdueOpen.samples.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              {blockers.overdueOpen.samples.slice(0, 3).map((s) => (
                <li key={s.taskId} className="truncate">
                  {s.taskName}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
    </div>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
        {title}
      </p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <p className="text-lg font-semibold text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function BucketRow({
  label,
  buckets,
}: {
  label: string;
  buckets: CategoryBucket[];
}) {
  if (buckets.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {buckets.map((b, i) => (
          <Tag key={`${b.label}-${i}`}>
            {b.label} · {b.count}
          </Tag>
        ))}
      </div>
    </div>
  );
}

/** Locale-formatted timestamp; falls back to the raw string if unparseable. */
export function formatWhen(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
