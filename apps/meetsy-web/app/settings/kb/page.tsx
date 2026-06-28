"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  ApiError,
  type KbOnboardBody,
  type KbRange,
  type KbScope,
  type KbStatusView,
} from "@/lib/api";
import {
  KbBuildPanel,
  RANGE_OPTIONS,
  RangeRadios,
  SpacesChecklist,
  SubScopeChecklists,
  useKbSpaces,
} from "@/app/onboarding/steps";
import { useCurrentUser } from "@/lib/user-context";
import { useWorkspace } from "@/lib/workspace-context";
import { Card, ErrorBanner, Spinner, Tag } from "@/app/ui";

/**
 * KB settings / re-onboard page. Shows the active workspace's current knowledge
 * base scope/range/status and lets an Owner/Admin re-embed with a (possibly
 * narrowed) scope — composing the SAME extracted step bodies the first-run
 * wizard uses (`app/onboarding/steps.tsx`).
 *
 * Gating mirrors the push-settings + onboarding pages:
 *  - Owner/Admin only — a Member sees a read-only note BEFORE any KB fetch
 *    (the /kb/onboard + scope fetches are Owner/Admin on the backend).
 *  - `activeWorkspaceId` null (before listWorkspaces validates) → Spinner, no fetch.
 *
 * NB: KbGate (in AppShell) only renders this page once the workspace's KB is
 * `ready`, so this is always the re-onboard surface of an already-built KB.
 */
export default function KbSettingsPage() {
  const user = useCurrentUser();
  const { activeWorkspaceId } = useWorkspace();
  const isAdmin = user.role === "OWNER" || user.role === "ADMIN";

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <PageHeader />
        <Card className="p-6">
          <p className="text-sm text-zinc-600">
            You don&apos;t have access to knowledge base settings. Ask an Owner
            or Admin to update the knowledge base scope.
          </p>
        </Card>
      </div>
    );
  }

  if (!activeWorkspaceId) {
    return (
      <div className="flex justify-center py-20">
        <Spinner label="Loading workspace…" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader />
      <KbSettings key={activeWorkspaceId} ws={activeWorkspaceId} />
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        Knowledge base settings
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Review what the knowledge base covers and re-embed with a different
        scope. Applied per workspace.
      </p>
    </div>
  );
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function KbSettings({ ws }: { ws: string }) {
  const [status, setStatus] = useState<KbStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on each successful (re)load so the form remounts and re-prefills
  // from the freshest status. Safe because `reload` only fires AFTER a build is
  // confirmed done — never mid-stream.
  const [version, setVersion] = useState(0);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const s = await api.kbStatus(ws);
      setStatus(s);
      setVersion((v) => v + 1);
    } catch (err) {
      setError(messageOf(err, "Could not load knowledge base status."));
    }
  }, [ws]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error && !status) return <ErrorBanner message={error} />;
  if (!status) return <Spinner label="Loading knowledge base…" />;

  return (
    <div className="space-y-6">
      {error && <ErrorBanner message={error} />}
      <StatusCard status={status} />
      {/* Remount + re-prefill the form whenever status reloads. */}
      <UpdateForm key={version} ws={ws} status={status} onDone={reload} />
    </div>
  );
}

const STATUS_STYLES: Record<KbStatusView["status"], string> = {
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

function formatWhen(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function StatusCard({ status }: { status: KbStatusView }) {
  return (
    <Card className="space-y-3 p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-zinc-700">
          Current knowledge base
        </h2>
        <Tag>{STATUS_STYLES[status.status]}</Tag>
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

function UpdateForm({
  ws,
  status,
  onDone,
}: {
  ws: string;
  status: KbStatusView;
  onDone: () => void;
}) {
  const { spaces, error: spacesError } = useKbSpaces(ws);

  // Pre-fill every selection from the CURRENT status so the form opens on the
  // existing scope. `scope: null` → empty Sets; `range` narrowed defensively.
  const [selectedSpaceIds, setSelectedSpaceIds] = useState<Set<string>>(
    () => new Set(status.scope?.spaceIds ?? []),
  );
  const [folderNames, setFolderNames] = useState<Set<string>>(
    () => new Set(status.scope?.folderNames ?? []),
  );
  const [listIds, setListIds] = useState<Set<string>>(
    () => new Set(status.scope?.listIds ?? []),
  );
  const [clients, setClients] = useState<Set<string>>(
    () => new Set(status.scope?.clients ?? []),
  );
  const [range, setRange] = useState<KbRange>(() =>
    RANGE_OPTIONS.some((o) => o.value === status.range)
      ? (status.range as KbRange)
      : "3m",
  );

  // Identical assembly to the wizard's `onboardBody`: omit empty arrays, and
  // omit `scope` entirely when nothing is selected (range-only re-embed).
  const body = useMemo<KbOnboardBody>(() => {
    const scope: KbScope = {};
    if (selectedSpaceIds.size) scope.spaceIds = [...selectedSpaceIds];
    if (folderNames.size) scope.folderNames = [...folderNames];
    if (listIds.size) scope.listIds = [...listIds];
    if (clients.size) scope.clients = [...clients];
    return Object.keys(scope).length ? { range, scope } : { range };
  }, [selectedSpaceIds, folderNames, listIds, clients, range]);

  return (
    <Card className="space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold text-zinc-700">
          Update knowledge base
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Adjust the spaces, sub-scope, and date range, then re-embed.
        </p>
      </div>

      {/* Spaces */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Spaces
        </h3>
        {spacesError && spaces === null ? (
          <ErrorBanner message={spacesError} />
        ) : spaces === null ? (
          <Spinner label="Loading spaces…" />
        ) : (
          <SpacesChecklist
            spaces={spaces}
            selected={selectedSpaceIds}
            onChange={setSelectedSpaceIds}
          />
        )}
      </section>

      {/* Sub-scope */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Sub-scope (optional)
        </h3>
        <SubScopeChecklists
          ws={ws}
          spaceIds={[...selectedSpaceIds]}
          folderNames={folderNames}
          listIds={listIds}
          clients={clients}
          onFolders={setFolderNames}
          onLists={setListIds}
          onClients={setClients}
        />
      </section>

      {/* Range */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Date range
        </h3>
        <RangeRadios range={range} onChange={setRange} />
      </section>

      {/* Re-embed */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Re-embed replaces the current knowledge base. The build runs in the
        background — you can leave this page.
      </div>

      <KbBuildPanel ws={ws} body={body} onDone={onDone} />
    </Card>
  );
}
