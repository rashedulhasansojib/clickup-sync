"use client";

import { useMemo, useState } from "react";
import {
  api,
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
} from "@/app/kb/steps";
import { Card, ErrorBanner, Spinner } from "@/app/ui";
import { StatusCard } from "@/app/kb/status-card";

/**
 * Rebuild tab — Owner/Admin only. Wraps the existing `KbBuildPanel` (the same
 * one the wizard uses) so re-embed and first-embed flow through one code path.
 * Pre-fills the form from the CURRENT status. `onDone` is the parent-supplied
 * reload trigger (so Overview / Tasks / Documents refresh once the build
 * settles).
 */
export function RebuildTab({
  ws,
  status,
  onDone,
}: {
  ws: string;
  status: KbStatusView;
  onDone: () => void;
}) {
  // Bumped on each successful (re)load so the form remounts and re-prefills
  // from the freshest status.
  const [version, setVersion] = useState(0);
  const handleDone = () => {
    setVersion((v) => v + 1);
    onDone();
  };
  return (
    <div className="space-y-6">
      <StatusCard status={status} />
      <UpdateForm key={version} ws={ws} status={status} onDone={handleDone} />
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

  const body = useMemo<KbOnboardBody>(() => {
    const scope: KbScope = {};
    if (selectedSpaceIds.size) scope.spaceIds = [...selectedSpaceIds];
    if (folderNames.size) scope.folderNames = [...folderNames];
    if (listIds.size) scope.listIds = [...listIds];
    if (clients.size) scope.clients = [...clients];
    return Object.keys(scope).length ? { range, scope } : { range };
  }, [selectedSpaceIds, folderNames, listIds, clients, range]);

  // Retain the `api` module reference to keep the import intentional
  // (rebuild's control flow calls api.kbStatus through KbBuildPanel).
  void api;

  return (
    <Card className="space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          Rebuild the knowledge base
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Adjust the spaces, sub-scope, and date range, then re-embed. The build
          runs in the background — you can leave this tab.
        </p>
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
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

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
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

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
          Date range
        </h3>
        <RangeRadios range={range} onChange={setRange} />
      </section>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Re-embed replaces the current knowledge base. Existing embeddings are
        overwritten with the new scope + range.
      </div>

      <KbBuildPanel ws={ws} body={body} onDone={onDone} />
    </Card>
  );
}
