"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Users, Trash2, PencilLine, Upload, Ban, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import {
  api,
  ApiError,
  type AssignableMember,
  type ParticipantAliasRow,
  type ParticipantAliasSource,
  type UpdateParticipantAliasBody,
} from "@/lib/api";
import { Button, Card, ErrorBanner, Spinner } from "@/app/ui";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * v2 Phase 7 PR-D — /kb Participants tab.
 *
 * Read: paginated list of learned aliases (all authed users).
 * Write: seed / edit / delete / blocklist / bulk-import (Owner/Admin only —
 * the "Add" and row actions render only when `canWrite`).
 */
export function ParticipantsTab({
  ws,
  canWrite,
}: {
  ws: string;
  canWrite: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [rows, setRows] = useState<ParticipantAliasRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  const [members, setMembers] = useState<AssignableMember[]>([]);
  const [editing, setEditing] = useState<ParticipantAliasRow | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [importing, setImporting] = useState<boolean>(false);

  const fetchPage = useCallback(
    async (opts: { filter: string; cursor: string | null; append: boolean }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (opts.append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const page = await api.listParticipantAliases(ws, {
          filter: opts.filter.trim() || undefined,
          cursor: opts.cursor ?? undefined,
        });
        if (controller.signal.aborted) return;
        setRows((prev) => (opts.append ? [...prev, ...page.rows] : page.rows));
        setNextCursor(page.nextCursor);
        setTotal(page.total);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(messageOf(err, "Could not load participant aliases."));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [ws],
  );

  useEffect(() => {
    if (debounceRef.current !== undefined) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      void fetchPage({ filter, cursor: null, append: false });
    }, 300);
    return () => {
      if (debounceRef.current !== undefined) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [filter, fetchPage]);

  // Owner/Admin: fetch ClickUp members once for the picker. Members-role tab
  // has no picker so no fetch — the joined `clickupName` on rows is enough.
  useEffect(() => {
    if (!canWrite) return;
    (async () => {
      try {
        const { members: m } = await api.getClickUpMembers(ws);
        setMembers(m);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) return;
        toast.error(messageOf(err, "Could not load ClickUp members."));
      }
    })();
  }, [ws, canWrite]);

  const reloadFirstPage = useCallback(() => {
    void fetchPage({ filter, cursor: null, append: false });
  }, [fetchPage, filter]);

  const onDelete = useCallback(
    async (row: ParticipantAliasRow) => {
      if (
        !window.confirm(
          `Delete the "${row.aliasRaw}" mapping? Meetsy will forget it and re-learn next time it sees this name.`,
        )
      )
        return;
      try {
        await api.deleteParticipantAlias(ws, row.id);
        toast.success(`Deleted "${row.aliasRaw}"`);
        reloadFirstPage();
      } catch (err) {
        toast.error(messageOf(err, "Delete failed."));
      }
    },
    [ws, reloadFirstPage],
  );

  const onBlocklist = useCallback(
    async (row: ParticipantAliasRow) => {
      const body: UpdateParticipantAliasBody = { clickupUserId: null };
      try {
        await api.updateParticipantAlias(ws, row.id, body);
        toast.success(`Blocklisted "${row.aliasRaw}"`);
        reloadFirstPage();
      } catch (err) {
        toast.error(messageOf(err, "Could not blocklist."));
      }
    },
    [ws, reloadFirstPage],
  );

  return (
    <Card className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Participant aliases
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {total !== null
              ? `${total.toLocaleString()} learned mapping${total === 1 ? "" : "s"} — Meetsy uses these to auto-suggest ClickUp members from transcript names.`
              : "Meetsy learns a mapping every time you confirm a roster. Edit or seed them here."}
          </p>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setImporting(true)}>
              <Upload className="mr-1.5 h-4 w-4" aria-hidden />
              Bulk import
            </Button>
            <Button onClick={() => setCreating(true)}>Add mapping</Button>
          </div>
        )}
      </div>

      <Input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by transcript name or ClickUp member…"
      />

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <div className="space-y-2" aria-hidden>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title={
            filter.trim()
              ? `No mappings match "${filter.trim()}"`
              : "No mappings yet"
          }
          description={
            filter.trim()
              ? "Clear the filter to browse everything."
              : "Upload a meeting and confirm the roster — Meetsy will remember every mapping you approve."
          }
        />
      ) : (
        <>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {rows.map((row) => (
              <li key={row.id} className="px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-medium text-foreground">
                        {row.aliasRaw}
                      </p>
                      <span className="text-muted-foreground/60">→</span>
                      {row.clickupUserId === null ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400">
                          <Ban className="h-3 w-3" aria-hidden />
                          Blocklisted
                        </span>
                      ) : row.clickupName ? (
                        <span className="text-sm text-foreground">
                          {row.clickupName}
                        </span>
                      ) : (
                        <span className="text-sm italic text-muted-foreground/70">
                          Departed member ({row.clickupUserId})
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/70">
                      <SourceTag source={row.source} confirmations={row.confirmations} />
                      <span>Last confirmed {formatRelative(row.lastSeenAt)}</span>
                    </div>
                  </div>
                  {canWrite && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        className="px-2 py-1"
                        onClick={() => setEditing(row)}
                        aria-label={`Edit ${row.aliasRaw}`}
                      >
                        <PencilLine className="h-4 w-4" aria-hidden />
                      </Button>
                      {row.clickupUserId !== null && (
                        <Button
                          variant="ghost"
                          className="px-2 py-1"
                          onClick={() => onBlocklist(row)}
                          aria-label={`Blocklist ${row.aliasRaw}`}
                          title="Convert to blocklist — Meetsy will never suggest anyone for this name"
                        >
                          <Ban className="h-4 w-4" aria-hidden />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        className="px-2 py-1"
                        onClick={() => onDelete(row)}
                        aria-label={`Delete ${row.aliasRaw}`}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {nextCursor && (
            <div className="pt-2">
              <Button
                variant="secondary"
                onClick={() =>
                  void fetchPage({ filter, cursor: nextCursor, append: true })
                }
                disabled={loadingMore}
              >
                {loadingMore ? <Spinner label="Loading…" /> : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}

      {canWrite && (creating || editing) && (
        <MappingDialog
          ws={ws}
          members={members}
          existing={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            reloadFirstPage();
          }}
        />
      )}

      {canWrite && importing && (
        <BulkImportDialog
          ws={ws}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            reloadFirstPage();
          }}
        />
      )}
    </Card>
  );
}

function SourceTag({
  source,
  confirmations,
}: {
  source: ParticipantAliasSource;
  confirmations: number;
}) {
  const cfg = SOURCE_CFG[source];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${cfg.className}`}
      title={cfg.title}
    >
      <span aria-hidden>{cfg.icon}</span>
      <span>
        {cfg.label}
        {source === "user_confirmed" && confirmations > 1
          ? ` · ${confirmations}×`
          : ""}
      </span>
    </span>
  );
}

const SOURCE_CFG: Record<
  ParticipantAliasSource,
  { className: string; label: string; icon: string; title: string }
> = {
  user_confirmed: {
    className:
      "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    label: "Confirmed",
    icon: "⭐",
    title: "The user re-confirmed this mapping at roster time.",
  },
  user_corrected: {
    className:
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    label: "Corrected",
    icon: "✏️",
    title: "The user overrode Meetsy's guess with this mapping.",
  },
  user_blocklisted: {
    className:
      "bg-red-500/10 text-red-600 dark:text-red-400",
    label: "Blocklisted",
    icon: "⛔",
    title: "Meetsy will never suggest anyone for this alias.",
  },
  admin_seeded: {
    className:
      "bg-purple-500/10 text-purple-700 dark:text-purple-300",
    label: "Manual",
    icon: "👤",
    title: "Seeded from the KB browser (Owner/Admin).",
  },
};

/** Add-or-edit modal. Existing row → PATCH; blank → POST create. */
function MappingDialog({
  ws,
  members,
  existing,
  onClose,
  onSaved,
}: {
  ws: string;
  members: AssignableMember[];
  existing: ParticipantAliasRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [aliasRaw, setAliasRaw] = useState(existing?.aliasRaw ?? "");
  const [clickupUserId, setClickupUserId] = useState<string>(
    existing?.clickupUserId ?? "",
  );
  const [blocklist, setBlocklist] = useState<boolean>(
    existing?.clickupUserId === null && existing?.source === "user_blocklisted",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedMembers = useMemo(
    () => [...members].sort((a, b) => a.name.localeCompare(b.name)),
    [members],
  );

  const onSave = async () => {
    setError(null);
    const trimmed = aliasRaw.trim();
    if (!trimmed) {
      setError("Transcript name is required.");
      return;
    }
    const resolvedClickupUserId = blocklist ? null : clickupUserId || null;
    if (!blocklist && !resolvedClickupUserId) {
      setError("Pick a ClickUp member, or check Blocklist.");
      return;
    }
    setSaving(true);
    try {
      if (existing) {
        await api.updateParticipantAlias(ws, existing.id, {
          aliasRaw: trimmed,
          clickupUserId: resolvedClickupUserId,
        });
        toast.success(`Updated "${trimmed}"`);
      } else {
        await api.createParticipantAlias(ws, {
          aliasRaw: trimmed,
          clickupUserId: resolvedClickupUserId,
        });
        toast.success(`Saved "${trimmed}"`);
      }
      onSaved();
    } catch (err) {
      setError(messageOf(err, "Save failed."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing ? "Edit mapping" : "Add mapping"}
          </DialogTitle>
          <DialogDescription>
            Teach Meetsy that a transcript name maps to a specific ClickUp
            member — or blocklist a name so Meetsy stops suggesting anyone for
            it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Transcript name
            <Input
              value={aliasRaw}
              onChange={(e) => setAliasRaw(e.target.value)}
              placeholder='e.g. "Sarah Khan" or "Dan L."'
              autoFocus
            />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={blocklist}
              onChange={(e) => setBlocklist(e.target.checked)}
              className="h-4 w-4"
            />
            <span>Blocklist — never suggest a member for this name</span>
          </label>

          {!blocklist && (
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              ClickUp member
              <select
                value={clickupUserId}
                onChange={(e) => setClickupUserId(e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              >
                <option value="">— pick a member —</option>
                {sortedMembers.map((m) => (
                  <option key={m.clickupUserId} value={m.clickupUserId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {error && <ErrorBanner message={error} />}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? <Spinner label="Saving…" /> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Bulk-import modal. Accepts CSV with `alias,clickupUserId` per line — an empty
 * `clickupUserId` cell becomes a blocklist row. Parses client-side, previews the
 * first 5 rows for confirmation, then POSTs the batch.
 */
function BulkImportDialog({
  ws,
  onClose,
  onDone,
}: {
  ws: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [csv, setCsv] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseCsv(csv), [csv]);

  const onUpload = async () => {
    setError(null);
    if (parsed.rows.length === 0) {
      setError("No valid rows found. Paste CSV as: alias,clickupUserId");
      return;
    }
    setUploading(true);
    try {
      const result = await api.bulkImportParticipantAliases(ws, {
        rows: parsed.rows,
      });
      toast.success(
        `Imported ${result.imported}, updated ${result.updated}, skipped ${result.skipped}.`,
      );
      onDone();
    } catch (err) {
      setError(messageOf(err, "Import failed."));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bulk import mappings</DialogTitle>
          <DialogDescription>
            Paste CSV with one mapping per line: <code>alias,clickupUserId</code>.
            Leave the ID column blank to blocklist an alias. Up to 1000 rows.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <textarea
            className="min-h-[160px] w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={`Sarah Khan,cu_sarah\nDan L.,cu_dan\nNifty IT,`}
          />
          {parsed.rows.length > 0 && (
            <div className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
              <p className="mb-1 font-medium text-foreground">
                Preview ({parsed.rows.length} row{parsed.rows.length === 1 ? "" : "s"}
                {parsed.skipped > 0
                  ? `, ${parsed.skipped} malformed line${parsed.skipped === 1 ? "" : "s"} skipped`
                  : ""}
                ):
              </p>
              <ul className="space-y-0.5">
                {parsed.rows.slice(0, 5).map((r, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="truncate">{r.aliasRaw}</span>
                    <span aria-hidden>→</span>
                    <span className="truncate">
                      {r.clickupUserId ?? (
                        <em className="text-red-500">blocklist</em>
                      )}
                    </span>
                  </li>
                ))}
                {parsed.rows.length > 5 && (
                  <li className="italic">…and {parsed.rows.length - 5} more</li>
                )}
              </ul>
            </div>
          )}
          {error && <ErrorBanner message={error} />}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={uploading}>
            Cancel
          </Button>
          <Button onClick={onUpload} disabled={uploading || parsed.rows.length === 0}>
            {uploading ? (
              <Spinner label="Importing…" />
            ) : (
              <>
                <CheckCircle2 className="mr-1.5 h-4 w-4" aria-hidden />
                Import {parsed.rows.length}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Parse a naive CSV: one mapping per line, `alias,clickupUserId` (trim both).
 * Empty second field = blocklist. Blank/short lines are counted as skipped so
 * the user can see how much of their paste was noise. */
function parseCsv(raw: string): {
  rows: Array<{ aliasRaw: string; clickupUserId: string | null }>;
  skipped: number;
} {
  const out: Array<{ aliasRaw: string; clickupUserId: string | null }> = [];
  let skipped = 0;
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {
    // Split on the first comma only — aliases may contain further commas in
    // exotic edge cases (we allow "aliasRaw,cu_id" where cu_id has no commas).
    const commaIdx = line.indexOf(",");
    if (commaIdx === -1) {
      // No comma at all → treat as a blocklist row for the whole line.
      const aliasRaw = line.trim();
      if (aliasRaw) out.push({ aliasRaw, clickupUserId: null });
      else skipped++;
      continue;
    }
    const aliasRaw = line.slice(0, commaIdx).trim();
    const cu = line.slice(commaIdx + 1).trim();
    if (!aliasRaw) {
      skipped++;
      continue;
    }
    out.push({ aliasRaw, clickupUserId: cu || null });
  }
  return { rows: out, skipped };
}

/** "just now / 5m / 2h / 3d / Jan 5" — matches the pattern used elsewhere. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

