"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError, type LearningMeView } from "@/lib/api";
import { Card, ErrorBanner, Spinner } from "@/app/ui";
import { Sparkline, type SparkPoint } from "@/components/charts/sparkline";

/**
 * "Is the model getting better at predicting me?" A 6-week rollup of overrides,
 * agreements, and nudge acceptance. Loads once on mount from
 * GET /workspaces/:id/learning/me. Zero-padded from the backend so the
 * sparklines have a consistent x-axis whether or not the user was active.
 */
export function LearningDigestCard({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<LearningMeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api
      .getLearningMe(workspaceId)
      .then((view) => {
        if (!active) return;
        setData(view);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) return;
        setError(err instanceof ApiError ? err.message : "Could not load digest.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  if (loading) {
    return (
      <Card className="flex items-center justify-center p-6">
        <Spinner label="Loading digest…" />
      </Card>
    );
  }

  if (error) {
    return <ErrorBanner message={error} />;
  }

  if (!data || data.totalOverrides === 0) {
    return (
      <Card className="p-6">
        <h3 className="text-base font-medium text-zinc-900">
          Learning digest
        </h3>
        <p className="mt-2 text-sm text-zinc-500">
          As you review runs and push tasks, we&apos;ll show a weekly trend of
          how often the model got your assignments right.
        </p>
      </Card>
    );
  }

  // Sparkline series: accuracy per week (agreements / overrides), overrides,
  // nudges shown vs. accepted. `null` when the week had no data so the bar
  // renders as a placeholder rather than a misleading zero.
  const accuracyPoints: SparkPoint[] = data.weeks.map((w) => ({
    label: w.weekStart,
    value: w.overrides === 0 ? null : w.agreements / w.overrides,
  }));
  const overridePoints: SparkPoint[] = data.weeks.map((w) => ({
    label: w.weekStart,
    value: w.overrides,
  }));
  const nudgePoints: SparkPoint[] = data.weeks.map((w) => ({
    label: w.weekStart,
    value: w.nudgesShown === 0 ? null : w.nudgesAccepted / w.nudgesShown,
  }));

  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-baseline justify-between">
        <h3 className="text-base font-medium text-zinc-900">
          Learning digest
        </h3>
        <span className="text-xs text-zinc-400">last 6 weeks</span>
      </div>

      <MetricRow
        label="Accuracy"
        hint="predicted matched what you pushed"
        points={accuracyPoints}
        formatValue={(v) => `${Math.round(v * 100)}%`}
      />
      <MetricRow
        label="Corrections"
        hint="pushes you logged (agrees + overrides)"
        points={overridePoints}
        formatValue={(v) => `${v}`}
      />
      <MetricRow
        label="Nudge acceptance"
        hint="you took the learning-loop suggestion"
        points={nudgePoints}
        formatValue={(v) => `${Math.round(v * 100)}%`}
      />

      <div className="flex items-center justify-between border-t border-zinc-100 pt-3 text-sm">
        <span className="text-zinc-500">
          {data.totalOverrides.toLocaleString()} correction
          {data.totalOverrides === 1 ? "" : "s"} total
        </span>
        <Link
          href="/settings/kb"
          className="font-medium text-zinc-700 hover:text-zinc-900"
        >
          See patterns →
        </Link>
      </div>
    </Card>
  );
}

function MetricRow({
  label,
  hint,
  points,
  formatValue,
}: {
  label: string;
  hint: string;
  points: SparkPoint[];
  formatValue: (v: number) => string;
}) {
  // Latest week's value (the last point) — a single-number-plus-trend read.
  const latest = points[points.length - 1];
  const latestLabel =
    latest && latest.value != null ? formatValue(latest.value) : "—";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-zinc-800">{label}</span>
          <span className="text-xs text-zinc-400">{hint}</span>
        </div>
        <span className="tabular-nums text-zinc-700">{latestLabel}</span>
      </div>
      <Sparkline data={points} />
    </div>
  );
}
