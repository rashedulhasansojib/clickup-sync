"use client";

import Link from "next/link";
import type { RunListItem, RunListPushStatus, RunStatus } from "@ma/shared";
import { cn } from "@/lib/utils";

/**
 * Compact row for one AnalysisRun. Shared between /home's recent-runs card
 * and /meetings history list — one look, one keyboard target, one hover state.
 */
export function RunRow({ item }: { item: RunListItem }) {
  const dateLabel = item.meetingDate
    ? formatDate(item.meetingDate)
    : formatRelative(item.createdAt);
  return (
    <Link
      href={`/runs/${encodeURIComponent(item.id)}`}
      className="group flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-input hover:bg-muted/50"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground group-hover:text-foreground">
          {item.meetingTitle || "Untitled meeting"}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{dateLabel}</span>
          {item.taskCount != null && (
            <>
              <span aria-hidden>·</span>
              <span>
                {item.taskCount} {item.taskCount === 1 ? "task" : "tasks"}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StatusPill status={item.status} />
        {item.pushStatus && <PushPill pushStatus={item.pushStatus} />}
      </div>
    </Link>
  );
}

function StatusPill({ status }: { status: RunStatus }) {
  const styles: Record<RunStatus, string> = {
    queued: "bg-muted text-muted-foreground",
    running: "bg-blue-100 text-blue-700",
    completed: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize",
        styles[status],
      )}
    >
      {status}
    </span>
  );
}

function PushPill({ pushStatus }: { pushStatus: RunListPushStatus }) {
  const styles: Record<RunListPushStatus, string> = {
    not_configured: "bg-muted text-muted-foreground",
    not_pushed: "bg-muted text-muted-foreground",
    partial: "bg-amber-100 text-amber-700",
    pushed: "bg-emerald-100 text-emerald-700",
  };
  const label: Record<RunListPushStatus, string> = {
    not_configured: "no push",
    not_pushed: "unpushed",
    partial: "partial",
    pushed: "pushed",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        styles[pushStatus],
      )}
    >
      {label[pushStatus]}
    </span>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Relative label: "just now", "3m ago", "2h ago", "5d ago", else absolute date.
 * Used when the meeting has no `meetingDate` — falls back to the run's createdAt.
 */
function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (Number.isNaN(diffMs)) return iso;
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 14) return `${days}d ago`;
  return formatDate(iso);
}
