"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type KbStatusView, type KbSummaryView } from "@/lib/api";
import { Card, ErrorBanner, Spinner } from "@/app/ui";
import { FactsSummary, formatWhen } from "@/app/kb/facts-summary";
import { StatusCard } from "@/app/kb/status-card";

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Overview tab — the "what we learned" surface. `StatusCard` on top, then the
 * SQL-derived `FactsSummary`. Called only when the KB status is `ready`; the
 * page's idle banner covers the not-ready cases.
 */
export function OverviewTab({
  ws,
  status,
}: {
  ws: string;
  status: KbStatusView;
}) {
  const [summary, setSummary] = useState<KbSummaryView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    setSummary(null);
    void api
      .kbSummary(ws)
      .then((res) => {
        if (!active) return;
        setSummary(res);
      })
      .catch((err) => {
        if (!active) return;
        setError(messageOf(err, "Could not load the summary."));
      });
    return () => {
      active = false;
    };
  }, [ws]);

  return (
    <div className="space-y-6">
      <StatusCard status={status} />

      <Card className="space-y-5 p-6">
        <div>
          <h2 className="text-sm font-semibold text-zinc-700">What we learned</h2>
          <p className="mt-1 text-xs text-zinc-500">
            A snapshot distilled from your workspace history.
          </p>
        </div>

        {error && !summary && <ErrorBanner message={error} />}
        {!summary && !error && <Spinner label="Summarizing…" />}

        {summary && (
          <>
            {summary.narrative && (
              <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-700">
                {summary.narrative}
              </p>
            )}
            <FactsSummary facts={summary.facts} />
            <p className="text-xs text-zinc-400">
              Generated {formatWhen(summary.generatedAt)}.
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
