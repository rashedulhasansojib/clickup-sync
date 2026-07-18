"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { RunListView } from "@ma/shared";
import { api, ApiError } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-context";
import { Button, Card, ErrorBanner, Spinner } from "@/app/ui";
import { RunRow } from "@/components/runs/run-list";
import { LearningDigestCard } from "@/components/learning/digest-card";

const HOME_LIMIT = 5;

export default function HomePage() {
  const { activeWorkspaceId } = useWorkspace();
  const [runs, setRuns] = useState<RunListView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    let active = true;
    setLoading(true);
    setError(null);
    void api
      .listRuns(activeWorkspaceId, { limit: HOME_LIMIT, offset: 0 })
      .then((view) => {
        if (!active) return;
        setRuns(view);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) return;
        setError(
          err instanceof ApiError ? err.message : "Could not load recent runs.",
        );
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeWorkspaceId]);

  const hasRuns = (runs?.items?.length ?? 0) > 0;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            Home
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Your recent meeting analyses in this workspace.
          </p>
        </div>
        <Link href="/new">
          <Button>Analyze a meeting</Button>
        </Link>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <section className="space-y-3 md:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
              Recent runs
            </h2>
            {hasRuns && (
              <Link
                href="/meetings"
                className="text-sm font-medium text-zinc-600 hover:text-zinc-900"
              >
                View all →
              </Link>
            )}
          </div>

          {loading && !runs && (
            <Card className="flex items-center justify-center p-8">
              <Spinner label="Loading runs…" />
            </Card>
          )}

          {error && <ErrorBanner message={error} />}

          {!loading && !hasRuns && !error && (
            <Card className="p-8 text-center">
              <h3 className="text-base font-medium text-zinc-900">
                No runs yet
              </h3>
              <p className="mt-1 text-sm text-zinc-500">
                Upload a transcript to see it turn into evidence-grounded tasks.
              </p>
              <div className="mt-4">
                <Link href="/new">
                  <Button>Analyze your first meeting</Button>
                </Link>
              </div>
            </Card>
          )}

          {hasRuns && (
            <div className="space-y-2">
              {runs!.items.map((item) => (
                <RunRow key={item.id} item={item} />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Your learning
          </h2>
          {activeWorkspaceId && (
            <LearningDigestCard workspaceId={activeWorkspaceId} />
          )}
        </section>
      </div>
    </div>
  );
}
