"use client";

import type { KbScope, KbStatusView } from "@/lib/api";
import { RANGE_OPTIONS } from "@/app/kb/steps";
import { Card, Tag } from "@/app/ui";
import { formatWhen } from "@/app/kb/facts-summary";

const STATUS_LABELS: Record<KbStatusView["status"], string> = {
  idle: "Idle",
  onboarding: "Building…",
  ready: "Ready",
  error: "Error",
};

function describeScope(scope: KbScope | null): string {
  if (!scope) return "All tasks in range";
  const parts: string[] = [];
  if (scope.spaceIds?.length) {
    parts.push(
      `${scope.spaceIds.length} space${scope.spaceIds.length === 1 ? "" : "s"}`,
    );
  }
  if (scope.folderNames?.length) {
    parts.push(`folders: ${scope.folderNames.join(", ")}`);
  }
  if (scope.listIds?.length) {
    parts.push(
      `${scope.listIds.length} list${scope.listIds.length === 1 ? "" : "s"}`,
    );
  }
  if (scope.clients?.length) {
    parts.push(`clients: ${scope.clients.join(", ")}`);
  }
  return parts.length ? parts.join(" · ") : "All tasks in range";
}

function rangeLabel(range: string | null): string {
  return RANGE_OPTIONS.find((o) => o.value === range)?.label ?? (range ?? "—");
}

/**
 * The workspace's current KB embed status. Extracted from `app/settings/kb/
 * page.tsx` so the v2 Phase 4 `/kb` Overview and Rebuild tabs share one card.
 */
export function StatusCard({ status }: { status: KbStatusView }) {
  return (
    <Card className="space-y-3 p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-zinc-700">
          Current knowledge base
        </h2>
        <Tag>{STATUS_LABELS[status.status]}</Tag>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label="Embedded">
          {status.embeddedCount.toLocaleString()} /{" "}
          {status.total.toLocaleString()} tasks
        </Field>
        <Field label="Last built">{formatWhen(status.lastRunAt)}</Field>
        <Field label="Scope">{describeScope(status.scope)}</Field>
        <Field label="Range">{rangeLabel(status.range)}</Field>
      </dl>
    </Card>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-zinc-700">{children}</dd>
    </div>
  );
}
