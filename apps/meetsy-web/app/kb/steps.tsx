"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type KbOnboardBody,
  type KbRange,
  type KbScopeOptions,
  type KbSpace,
  type KbStatusView,
} from "@/lib/api";
import { useKbStatusStream } from "@/lib/useKbStatusStream";
import { Button, Card, ErrorBanner, Spinner, Tag } from "@/app/ui";

/**
 * Reusable KB onboarding building blocks — the space/scope/range pickers and
 * the onboard→stream→confirm `KbBuildPanel`. Originally extracted from a
 * seven-step `/onboarding` wizard; v2 Phase 4 retired that wizard and folded
 * these pieces into the `/kb` tabs (`app/kb/rebuild-tab.tsx`,
 * `app/kb/page.tsx`) + the idle-banner build panel on the main page.
 *
 * `KbBuildPanel` is the single onboard/re-embed code path — anything that
 * starts a build MUST route through it so the SSE-stream + status-confirm
 * dance stays in one place.
 */

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Shared footer with Back / Next-style actions. */
export function StepActions({
  onBack,
  children,
}: {
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
      <div>
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
      </div>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

// ── Spaces ──────────────────────────────────────────────────────────────

/**
 * Fetch the workspace's Clicksy-synced spaces. Split out of the old `SpacesStep`
 * so the wizard (which needs `spaces.length` for its button label) and the
 * settings page can both reuse the same fetch + the `SpacesChecklist` visual.
 *
 * `spaces === null` means "still loading and no result yet" (mirrors the
 * original: errors set an empty array, not null).
 */
export function useKbSpaces(ws: string): {
  spaces: KbSpace[] | null;
  loading: boolean;
  error: string | null;
} {
  const [spaces, setSpaces] = useState<KbSpace[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    void api
      .kbSpaces(ws)
      .then((res) => {
        if (!active) return;
        setSpaces(res.spaces ?? []);
      })
      .catch((err) => {
        if (!active) return;
        setError(messageOf(err, "Could not load ClickUp spaces."));
        setSpaces([]);
      });
    return () => {
      active = false;
    };
  }, [ws]);

  return { spaces, loading: spaces === null, error };
}

/** Controlled checkbox list of spaces (the visual from the old `SpacesStep`). */
export function SpacesChecklist({
  spaces,
  selected,
  onChange,
}: {
  spaces: KbSpace[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const toggle = useCallback(
    (id: string) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange(next);
    },
    [selected, onChange],
  );

  const isEmpty = spaces.length === 0;

  if (isEmpty) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        This workspace has no ClickUp spaces synced in Clicksy yet. You can
        continue anyway — onboarding will run on whatever is in range (it may
        embed 0 tasks until a sync lands).
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {spaces.map((space) => (
        <label
          key={space.spaceId}
          className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected.has(space.spaceId)}
              onChange={() => toggle(space.spaceId)}
              className="h-4 w-4 rounded border-zinc-300"
            />
            <span className="font-medium">{space.name}</span>
            {!space.enabled && <Tag>not enabled</Tag>}
          </span>
          <span className="text-xs text-zinc-400">
            {space.taskCount > 0
              ? `${space.taskCount.toLocaleString()} tasks mirrored`
              : "0 — not synced yet"}
          </span>
        </label>
      ))}
    </div>
  );
}

// ── Sub-scope ───────────────────────────────────────────────────────────

/**
 * The `kbScopeOptions` fetch + the three `ChecklistGroup`s (folders/lists/
 * clients). Returns a spinner while loading; otherwise the narrowing controls.
 */
export function SubScopeChecklists({
  ws,
  spaceIds,
  folderNames,
  listIds,
  clients,
  onFolders,
  onLists,
  onClients,
}: {
  ws: string;
  spaceIds: string[];
  folderNames: Set<string>;
  listIds: Set<string>;
  clients: Set<string>;
  onFolders: (next: Set<string>) => void;
  onLists: (next: Set<string>) => void;
  onClients: (next: Set<string>) => void;
}) {
  const [options, setOptions] = useState<KbScopeOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    setOptions(null);
    void api
      .kbScopeOptions(ws, spaceIds.length ? spaceIds : undefined)
      .then((res) => {
        if (!active) return;
        setOptions({
          folders: res.folders ?? [],
          lists: res.lists ?? [],
          clients: res.clients ?? [],
        });
      })
      .catch((err) => {
        if (!active) return;
        setError(messageOf(err, "Could not load scope options."));
        setOptions({ folders: [], lists: [], clients: [] });
      });
    return () => {
      active = false;
    };
    // spaceIds is derived from a Set; join to a stable dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, spaceIds.join(",")]);

  const toggle = useCallback(
    (set: Set<string>, apply: (next: Set<string>) => void, id: string) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      apply(next);
    },
    [],
  );

  if (options === null && !error)
    return <Spinner label="Loading scope options…" />;

  const opts = options ?? { folders: [], lists: [], clients: [] };
  const nothingToNarrow =
    opts.folders.length === 0 &&
    opts.lists.length === 0 &&
    opts.clients.length === 0;

  return (
    <>
      {error && <ErrorBanner message={error} />}

      {nothingToNarrow ? (
        <p className="text-sm text-zinc-500">
          No folders, lists, or clients found to narrow by. The whole selection
          will be included.
        </p>
      ) : (
        <div className="space-y-5">
          {opts.folders.length > 0 && (
            <ChecklistGroup
              title="Folders"
              items={opts.folders.map((f) => ({ id: f, label: f }))}
              selected={folderNames}
              onToggle={(id) => toggle(folderNames, onFolders, id)}
            />
          )}
          {opts.lists.length > 0 && (
            <ChecklistGroup
              title="Lists"
              items={opts.lists.map((l) => ({
                id: l.listId,
                label: l.listName,
              }))}
              selected={listIds}
              onToggle={(id) => toggle(listIds, onLists, id)}
            />
          )}
          {opts.clients.length > 0 && (
            <ChecklistGroup
              title="Clients"
              items={opts.clients.map((c) => ({ id: c, label: c }))}
              selected={clients}
              onToggle={(id) => toggle(clients, onClients, id)}
            />
          )}
        </div>
      )}
    </>
  );
}

export function ChecklistGroup({
  title,
  items,
  selected,
  onToggle,
}: {
  title: string;
  items: Array<{ id: string; label: string }>;
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
        {title}
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {items.map((item) => (
          <label
            key={item.id}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            <input
              type="checkbox"
              checked={selected.has(item.id)}
              onChange={() => onToggle(item.id)}
              className="h-4 w-4 rounded border-zinc-300"
            />
            <span className="min-w-0 truncate">{item.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Date range ──────────────────────────────────────────────────────────

export const RANGE_OPTIONS: Array<{ value: KbRange; label: string }> = [
  { value: "3m", label: "Last 3 months" },
  { value: "6m", label: "Last 6 months" },
  { value: "12m", label: "Last 12 months" },
  { value: "24m", label: "Last 24 months" },
  { value: "36m", label: "Last 36 months" },
  { value: "all", label: "All time" },
];

export function RangeRadios({
  range,
  onChange,
}: {
  range: KbRange;
  onChange: (r: KbRange) => void;
}) {
  return (
    <div className="space-y-1">
      {RANGE_OPTIONS.map((opt) => (
        <label
          key={opt.value}
          className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          <input
            type="radio"
            name="kb-range"
            checked={range === opt.value}
            onChange={() => onChange(opt.value)}
            className="h-4 w-4 border-zinc-300"
          />
          <span>{opt.label}</span>
        </label>
      ))}
    </div>
  );
}

// ── Build (start + progress) ────────────────────────────────────────────

/**
 * The KB build panel: starts onboarding (`api.kbOnboard`), follows the SSE
 * progress stream, and — because the stream is NOT authoritative — confirms with
 * `api.kbStatus` on `done`. The wizard's `onReady` maps to `onDone`; the settings
 * page maps `onDone` to a status reload. `onBack` is optional (the settings page
 * has no Back).
 *
 * THIS is the must-not-duplicate piece: every onboard/re-embed flows through it.
 */
export function KbBuildPanel({
  ws,
  body,
  onBack,
  onDone,
}: {
  ws: string;
  body: KbOnboardBody;
  onBack?: () => void;
  onDone: () => void;
}) {
  const [started, setStarted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const { latest, done } = useKbStatusStream(started ? ws : null);

  const start = useCallback(async () => {
    setStartError(null);
    setErrorState(null);
    try {
      await api.kbOnboard(ws, body);
      setStarted(true);
    } catch (err) {
      setStartError(messageOf(err, "Could not start onboarding."));
    }
  }, [ws, body]);

  // SSE is NOT authoritative — on `done`, confirm with GET /kb/status.
  useEffect(() => {
    if (!started || !done) return;
    let active = true;
    setConfirming(true);
    void api
      .kbStatus(ws)
      .then((status: KbStatusView) => {
        if (!active) return;
        if (status.status === "ready") {
          onDone();
        } else if (status.status === "error") {
          setErrorState("Onboarding failed while building the knowledge base.");
        } else {
          // Stream ended but the build is still in flight — let the user retry
          // the confirm rather than hang silently.
          setErrorState(
            "The live connection ended before the build finished. Check status again.",
          );
        }
      })
      .catch((err) => {
        if (!active) return;
        setErrorState(messageOf(err, "Could not confirm onboarding status."));
      })
      .finally(() => {
        if (active) setConfirming(false);
      });
    return () => {
      active = false;
    };
  }, [started, done, ws, onDone]);

  const total = latest?.total ?? 0;
  const embedded = latest?.embedded ?? 0;
  const pct =
    total > 0 ? Math.min(100, Math.round((embedded / total) * 100)) : 0;

  if (!started) {
    return (
      <Card className="space-y-4 p-6">
        <div>
          <h2 className="text-sm font-semibold text-zinc-700">
            Build the knowledge base
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            We&apos;ll read the selected tasks and embed them. This can take a
            few minutes for large workspaces — you can leave this page; the build
            keeps running.
          </p>
        </div>
        {startError && <ErrorBanner message={startError} />}
        <StepActions onBack={onBack}>
          <Button onClick={start}>Start onboarding</Button>
        </StepActions>
      </Card>
    );
  }

  return (
    <Card className="space-y-4 p-6">
      <div>
        <h2 className="text-sm font-semibold text-zinc-700">
          Building the knowledge base…
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          {latest?.message ?? "Starting up…"}
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100">
          <div
            className="h-full rounded-full bg-zinc-900 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-zinc-500">
          {total > 0
            ? `${embedded.toLocaleString()} / ${total.toLocaleString()} embedded (${pct}%)`
            : "Counting tasks…"}
        </p>
      </div>

      {errorState ? (
        <div className="space-y-3">
          <ErrorBanner message={errorState} />
          <StepActions onBack={onBack}>
            <Button
              variant="secondary"
              onClick={() => {
                setErrorState(null);
                setStarted(false);
              }}
            >
              Try again
            </Button>
          </StepActions>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Spinner label={confirming ? "Confirming…" : "Embedding tasks…"} />
        </div>
      )}
    </Card>
  );
}
