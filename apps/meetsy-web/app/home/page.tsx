"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Home as HomeIcon } from "lucide-react";
import type { RunListView } from "@ma/shared";
import { api, ApiError } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-context";
import { Button, ErrorBanner } from "@/app/ui";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
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
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Home
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
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
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Recent runs
            </h2>
            {hasRuns && (
              <Link
                href="/meetings"
                className="text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                View all →
              </Link>
            )}
          </div>

          {loading && !runs && (
            <div className="space-y-2" aria-hidden>
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
            </div>
          )}

          {error && <ErrorBanner message={error} />}

          {!loading && !hasRuns && !error && (
            <EmptyState
              icon={HomeIcon}
              title="No meetings analyzed yet"
              description="Upload a transcript to see it turn into evidence-grounded tasks."
              action={{ label: "Analyze your first meeting", href: "/new" }}
            />
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
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
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
