"use client";

import { useEffect, useState } from "react";
import type { ClickUpTaskLookupView } from "@ma/shared";
import { api, ApiError } from "@/lib/api";
import { Card, ErrorBanner, Spinner } from "@/app/ui";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useTaskSheet } from "./task-sheet-context";

/**
 * v2 Phase 2 (PR-K) — the side sheet slot for a single ClickUp task lookup.
 * Fetches `GET /workspaces/:id/clickup/tasks/:taskId` when the sheet opens
 * with a new taskId; a null response is legitimate (task predates the KB
 * onboarding — chips are ids, not proofs of existence).
 */
export function TaskDetailSheet({ workspaceId }: { workspaceId: string | null }) {
  const { open, taskId, close } = useTaskSheet();
  const [data, setData] = useState<ClickUpTaskLookupView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Re-fetch whenever the sheet opens with a new taskId. Reset state when the
  // sheet closes so a re-open shows fresh loading rather than stale content.
  useEffect(() => {
    if (!open || !taskId || !workspaceId) return;
    let active = true;
    setLoading(true);
    setError(null);
    setData(undefined);
    void api
      .getClickupTask(workspaceId, taskId)
      .then((view) => {
        if (!active) return;
        setData(view);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) return;
        setError(err instanceof ApiError ? err.message : "Could not load the task.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, taskId, workspaceId]);

  return (
    <Sheet open={open} onOpenChange={(v) => (v ? undefined : close())}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle>ClickUp task</SheetTitle>
          <SheetDescription>
            <code className="text-xs text-zinc-500">{taskId ?? "—"}</code>
          </SheetDescription>
        </SheetHeader>

        {loading && (
          <Card className="flex items-center justify-center p-6">
            <Spinner label="Loading task…" />
          </Card>
        )}

        {error && !loading && <ErrorBanner message={error} />}

        {!loading && !error && data === null && (
          <Card className="p-6 text-sm text-zinc-500">
            <p className="font-medium text-zinc-700">Not in this workspace&apos;s KB.</p>
            <p className="mt-1">
              This ClickUp task predates the KB sync, was archived, or belongs to
              a workspace this account doesn&apos;t see. The prediction chip is
              still trustworthy — the pipeline&apos;s cosine reasoning ran over
              the KB-embedded shape, not a live ClickUp fetch.
            </p>
          </Card>
        )}

        {!loading && !error && data && (
          <div className="space-y-4">
            <div>
              <div className="text-sm font-semibold text-zinc-900">{data.title}</div>
              {data.url && (
                <a
                  href={data.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-xs font-medium text-blue-700 hover:underline"
                >
                  Open in ClickUp ↗
                </a>
              )}
            </div>
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <MetaRow label="Status" value={data.status} />
              <MetaRow label="Assignee" value={data.assigneeName} />
              <MetaRow
                label="Updated"
                value={data.updatedAt ? new Date(data.updatedAt).toLocaleString() : null}
              />
            </dl>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function MetaRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
        {label}
      </dt>
      <dd className="truncate text-zinc-700">{value ?? "—"}</dd>
    </div>
  );
}
