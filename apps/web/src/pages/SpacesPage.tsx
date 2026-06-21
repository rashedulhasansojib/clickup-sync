import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CircleCheck, CircleDashed, Loader2, RefreshCw, Settings } from 'lucide-react';
import { useSpaces, useSyncHealth } from '../hooks/useReports';
import { useActiveBackfills, useBackfill } from '../hooks/useAdmin';
import { useAuth } from '../hooks/useAuth';
import { useActiveWorkspace } from '../hooks/useActiveWorkspace';
import type { ActiveBackfill } from '../api/admin';
import type { WorkspaceSpace } from '../api/workspaces';
import { PageHeader } from '../components/ui/PageHeader';
import { QueryError } from '../components/ui/QueryError';
import { Card } from '../components/ui/Card';
import { Tabs } from '../components/ui/Tabs';
import { Button } from '../components/ui/Button';
import { Pill } from '../components/ui/Pill';
import { Input } from '../components/ui/Input';
import { Skeleton } from '../components/ui/Skeleton';
import { fmt } from '../lib/formatters';

const DEFAULT_LOOKBACK = 30;
const MIN_LOOKBACK = 1;
// Fallback when the settings query hasn't loaded yet. The real cap is the
// configurable Settings → Sync value (preferences.sync.maxBackfillLookbackDays),
// read at runtime so backend and frontend share one source of truth.
const MAX_LOOKBACK_FALLBACK = 1095;

function defaultLookbackFor(configuredSpaces: WorkspaceSpace[], spaceId: string): number {
  return configuredSpaces.find((s) => s.spaceId === spaceId)?.backfillLookbackDays ?? DEFAULT_LOOKBACK;
}

const PALETTE = ['#7B68EE', '#FF02F0', '#49CCF9', '#10b981', '#f59e0b', '#ef4444'];

type SpaceRow = {
  spaceId: string | null;
  spaceName: string | null;
  taskCount: number;
  openCount: number;
  /** Distinct users with logged time against tasks in this space. */
  memberCount: number;
  hoursLogged: number;
  costAud: number;
  /** false = configured space that has never produced any synced data yet */
  synced: boolean;
  /** ISO timestamp of the last successful sync (from the sync checkpoint), or null. */
  lastSyncedAt: string | null;
  /** Longest backfill lookback (days) ever run for this space, or null if none recorded. */
  maxLookbackTried: number | null;
};

/**
 * Always show every configured space (even if it has never synced), merged
 * with whatever the backend reports from synced data. Any synced space that
 * isn't in the configured list is appended so nothing is hidden.
 */
type SpaceHealth = { lastSyncedAt: string | null; maxLookbackDays: number | null };

function buildMergedSpaces(configuredSpaces: WorkspaceSpace[], apiRows: Omit<SpaceRow, 'synced' | 'lastSyncedAt' | 'maxLookbackTried'>[], healthById: Map<string, SpaceHealth>): SpaceRow[] {
  const byId = new Map<string, Omit<SpaceRow, 'synced' | 'lastSyncedAt' | 'maxLookbackTried'>>();
  for (const r of apiRows) {
    const id = r.spaceId?.trim();
    if (id) byId.set(id, r);
  }
  const merged: SpaceRow[] = configuredSpaces.map((cfg) => {
    const hit = byId.get(cfg.spaceId);
    byId.delete(cfg.spaceId);
    const h = healthById.get(cfg.spaceId);
    const extra = { lastSyncedAt: h?.lastSyncedAt ?? null, maxLookbackTried: h?.maxLookbackDays ?? null };
    if (hit) return { ...hit, spaceName: hit.spaceName ?? cfg.name, synced: true, ...extra };
    return {
      spaceId: cfg.spaceId,
      spaceName: cfg.name,
      taskCount: 0,
      openCount: 0,
      memberCount: 0,
      hoursLogged: 0,
      costAud: 0,
      // A space can sync successfully yet hold 0 tasks (empty space, or nothing
      // updated within the lookback window). Trust the sync checkpoint, not just
      // task presence, so a freshly-synced-but-empty space isn't mislabeled
      // "Never synced".
      synced: healthById.has(cfg.spaceId),
      ...extra,
    };
  });
  // Any remaining synced spaces not in the configured list.
  for (const [id, r] of byId) {
    const h = healthById.get(id);
    merged.push({ ...r, synced: true, lastSyncedAt: h?.lastSyncedAt ?? null, maxLookbackTried: h?.maxLookbackDays ?? null });
  }
  return merged;
}

function spaceDisplayName(configuredSpaces: WorkspaceSpace[], s: SpaceRow): string {
  const n = s.spaceName?.trim();
  if (n) return n;
  const configured = configuredSpaces.find((c) => c.spaceId === s.spaceId);
  if (configured) return configured.name;
  const id = s.spaceId?.trim();
  // Prefix with "Space" so an unresolved ID doesn't render twice (once where
  // the name should be, once below) and look like a duplicate / typo.
  return id ? `Space ${id}` : 'Unnamed space';
}

function spaceKey(s: SpaceRow, index: number): string {
  return s.spaceId?.trim() || `space-${index}`;
}

type TabKey = 'grid' | 'workload';

const TAB_ITEMS = [
  { value: 'grid' as TabKey, label: 'Grid' },
  { value: 'workload' as TabKey, label: 'Workload' },
];

function spaceColor(spaceId: string | null | undefined): string {
  const id = spaceId ?? '';
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

type SyncControls = {
  syncingId: string | null;
  queuedIds: Set<string>;
  /** Server-reported live status per spaceId, or null when idle. */
  progressFor: (id: string) => ActiveBackfill | null;
  onSync: (id: string) => void;
  /** Current text shown in a space's lookback-days input. */
  lookbackText: (id: string) => string;
  onLookbackChange: (id: string, value: string) => void;
  /** Whether the current user may trigger syncs (OWNER/ADMIN). */
  canSync: boolean;
};

function SyncProgress({ progress }: { progress: ActiveBackfill }) {
  if (progress.phase === 'fetching') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
          <span>Fetching tasks from ClickUp…</span>
          <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
        </div>
        {/* Indeterminate: full bar at the accent colour, animated stripe-pulse. */}
        <div style={{ width: '100%', height: 6, background: 'var(--muted-bg)', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'var(--accent)', opacity: 0.35, animation: 'pulse 1.4s ease-in-out infinite' }} />
        </div>
      </div>
    );
  }
  const total = progress.total ?? 0;
  const done = progress.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
        <span>Syncing time entries · {fmt.number(done)} / {fmt.number(total)}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
      </div>
      <ProgressBar value={pct} color="var(--accent)" />
    </div>
  );
}

function LookbackInput({ sid, controls }: { sid: string; controls: SyncControls }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} title="How many days back to sync from ClickUp">
      <Input
        type="number"
        value={controls.lookbackText(sid)}
        onChange={(e) => controls.onLookbackChange(sid, e.target.value)}
        disabled={!sid}
        aria-label="Lookback days"
        style={{ width: 64 }}
      />
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>days back</span>
    </div>
  );
}

/** Completion %: closed tasks (total − open) over total, clamped to 0. */
function completionPct(taskCount: number, openCount: number): number {
  if (taskCount <= 0) return 0;
  return Math.round((Math.max(0, taskCount - openCount) / taskCount) * 100);
}

function ProgressBar({ value = 0, color = 'var(--accent)', height = 6 }: { value?: number; color?: string; height?: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      style={{
        width: '100%',
        height,
        background: 'var(--muted-bg)',
        borderRadius: height / 2,
        overflow: 'hidden',
      }}
    >
      <div style={{ width: `${v}%`, height: '100%', background: color, transition: 'width 200ms ease-out' }} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: 8, background: 'var(--muted-bg)', borderRadius: 6 }}>
      <div
        style={{
          fontSize: 10,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function SpaceGrid({ spaces, controls, configuredSpaces }: { spaces: SpaceRow[]; controls: SyncControls; configuredSpaces: WorkspaceSpace[] }) {
  const navigate = useNavigate();
  const { syncingId, queuedIds, progressFor, onSync, canSync } = controls;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
      {spaces.map((space, index) => {
        const displayName = spaceDisplayName(configuredSpaces, space);
        const color = spaceColor(space.spaceId);
        const totalHours = space.hoursLogged;
        const closedCount = Math.max(0, space.taskCount - space.openCount);
        const donePct = completionPct(space.taskCount, space.openCount);
        const initial = (displayName.slice(0, 1) || '?').toUpperCase();
        const sid = space.spaceId?.trim() ?? '';
        const isSyncing = syncingId === sid;
        const progress = progressFor(sid);
        const isQueued = queuedIds.has(sid) || progress !== null;

        return (
          <div
            key={spaceKey(space, index)}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              borderTop: `3px solid ${color}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: `${color}22`,
                  color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 16,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {initial}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--text)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flexWrap: 'wrap',
                  }}
                >
                  {displayName}
                </div>
                <div style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace', color: 'var(--text-muted)' }}>
                  {sid || '—'}
                </div>
              </div>
              {isQueued || isSyncing ? (
                <Pill tone="amber" size="xs" icon={<Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} />}>
                  syncing…
                </Pill>
              ) : space.synced ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <Pill tone="green" size="xs" icon={<CircleCheck size={10} />}>synced</Pill>
                  {space.lastSyncedAt && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title={new Date(space.lastSyncedAt).toLocaleString()}>
                      {fmt.relative(space.lastSyncedAt)}
                    </span>
                  )}
                  {space.maxLookbackTried != null && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title="Longest backfill window run for this space">
                      · up to {space.maxLookbackTried}d
                    </span>
                  )}
                </div>
              ) : (
                <Pill tone="amber" size="xs" icon={<CircleDashed size={10} />}>Never synced</Pill>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              <Stat label="Tasks" value={fmt.number(space.taskCount)} />
              <Stat label="Open" value={fmt.number(space.openCount)} />
              <Stat label="Members" value={space.memberCount > 0 ? fmt.number(space.memberCount) : '—'} />
              <Stat label="Hours" value={isQueued ? '…' : fmt.hours(totalHours)} />
            </div>

            {progress ? (
              <SyncProgress progress={progress} />
            ) : (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                  <span>Completed {fmt.number(closedCount)}/{fmt.number(space.taskCount)}</span>
                  <span>{donePct}%</span>
                </div>
                <ProgressBar value={donePct} color={color} />
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border-soft)', flexWrap: 'wrap' }}>
              {canSync ? <LookbackInput sid={sid} controls={controls} /> : <span />}
              <div style={{ display: 'flex', gap: 6 }}>
                <Button
                  size="sm"
                  variant="default"
                  disabled={!sid}
                  onClick={() => sid && navigate(`/tasks?spaceId=${encodeURIComponent(sid)}`)}
                >
                  View tasks
                </Button>
                {canSync && (
                  <Button
                    size="sm"
                    variant="caution"
                    icon={<RefreshCw size={12} />}
                    loading={isSyncing}
                    disabled={!sid || syncingId !== null || isQueued}
                    onClick={() => sid && onSync(sid)}
                  >
                    {isQueued ? 'Queued' : 'Sync'}
                  </Button>
                )}
                <Button size="sm" variant="ghost" icon={<Settings size={12} />} onClick={() => navigate('/settings')} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WorkloadView({ spaces, controls, configuredSpaces }: { spaces: SpaceRow[]; controls: SyncControls; configuredSpaces: WorkspaceSpace[] }) {
  const navigate = useNavigate();
  const { syncingId, queuedIds, progressFor, onSync, canSync } = controls;
  const sorted = useMemo(() => [...spaces].sort((a, b) => b.hoursLogged - a.hoursLogged), [spaces]);
  const total = sorted.reduce((s, sp) => s + sp.hoursLogged, 0);

  return (
    <Card padding={0}>
      <div
        style={{
          padding: 16,
          borderBottom: '1px solid var(--border-soft)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontWeight: 600,
            }}
          >
            Last 30 days
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
            {fmt.hours(total)}{' '}
            <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>across {sorted.length} spaces</span>
          </div>
        </div>
      </div>

      <div style={{ padding: 16, borderBottom: '1px solid var(--border-soft)' }}>
        {total > 0 ? (
          <>
            <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', background: 'var(--muted-bg)' }}>
              {sorted.map((sp, si) => (
                <div
                  key={spaceKey(sp, si)}
                  style={{
                    width: `${(sp.hoursLogged / total) * 100}%`,
                    background: spaceColor(sp.spaceId),
                    transition: 'all 200ms',
                  }}
                  title={`${spaceDisplayName(configuredSpaces, sp)}: ${fmt.hours(sp.hoursLogged)}`}
                />
              ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 10 }}>
              {sorted.map((sp, si) => (
                <div
                  key={spaceKey(sp, si)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      background: spaceColor(sp.spaceId),
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontWeight: 500, color: 'var(--text)' }}>{spaceDisplayName(configuredSpaces, sp)}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {fmt.hours(sp.hoursLogged)} ({Math.round((sp.hoursLogged / total) * 100)}%)
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No hours logged in this period.</div>
        )}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr
            style={{
              background: 'var(--muted-bg)',
              textTransform: 'uppercase',
              fontSize: 10,
              color: 'var(--text-muted)',
              letterSpacing: '0.05em',
              fontWeight: 600,
            }}
          >
            <th style={{ textAlign: 'left', padding: '8px 16px' }}>Space</th>
            <th style={{ textAlign: 'right', padding: '8px 12px' }}>Tasks</th>
            <th style={{ textAlign: 'right', padding: '8px 12px' }}>Open</th>
            <th style={{ textAlign: 'right', padding: '8px 12px' }}>Members</th>
            <th style={{ textAlign: 'right', padding: '8px 12px' }}>Hours</th>
            <th style={{ textAlign: 'right', padding: '8px 12px' }}>Done</th>
            <th style={{ textAlign: 'right', padding: '8px 12px' }}>Cost</th>
            <th style={{ width: 230, padding: '8px 16px' }} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((sp, i) => {
            const rowId = sp.spaceId?.trim() ?? '';
            const isSyncing = syncingId === rowId;
            const progress = progressFor(rowId);
            const isQueued = queuedIds.has(rowId) || progress !== null;
            return (
            <tr key={spaceKey(sp, i)} style={{ borderTop: i > 0 ? '1px solid var(--border-soft)' : undefined }}>
              <td style={{ padding: '10px 16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: spaceColor(sp.spaceId), flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, color: 'var(--text)' }}>{spaceDisplayName(configuredSpaces, sp)}</span>
                    {!sp.synced && !progress && (
                      <Pill tone="amber" size="xs" icon={<CircleDashed size={10} />}>Never synced</Pill>
                    )}
                    {sp.synced && !progress && sp.lastSyncedAt && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title={new Date(sp.lastSyncedAt).toLocaleString()}>
                        synced {fmt.relative(sp.lastSyncedAt)}{sp.maxLookbackTried != null ? ` · up to ${sp.maxLookbackTried}d` : ''}
                      </span>
                    )}
                  </div>
                  {progress && <div style={{ maxWidth: 260 }}><SyncProgress progress={progress} /></div>}
                </div>
              </td>
              <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt.number(sp.taskCount)}</td>
              <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt.number(sp.openCount)}</td>
              <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{sp.memberCount > 0 ? fmt.number(sp.memberCount) : '—'}</td>
              <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmt.hours(sp.hoursLogged)}</td>
              <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {sp.taskCount > 0 ? `${completionPct(sp.taskCount, sp.openCount)}%` : '—'}
              </td>
              <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                {fmt.money(Math.round(Number(sp.costAud ?? 0) * 100))}
              </td>
              <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                  {canSync && <LookbackInput sid={rowId} controls={controls} />}
                  {canSync && (
                    <Button
                      size="sm"
                      variant="caution"
                      icon={isQueued ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={12} />}
                      loading={isSyncing}
                      disabled={!rowId || syncingId !== null || isQueued}
                      onClick={() => rowId && onSync(rowId)}
                    >
                      {isQueued ? 'Queued' : 'Sync'}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!rowId}
                    onClick={() => rowId && navigate(`/tasks?spaceId=${encodeURIComponent(rowId)}`)}
                    icon={<ChevronRight size={12} />}
                  />
                </div>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

export function SpacesPage() {
  const [view, setView] = useState<TabKey>('grid');
  const [syncingId, setSyncingId] = useState<string | null>(null);
  // Optimistic "I just clicked Sync" set. Gives the user instant feedback in
  // the ~3s gap before the server poll reports the job as in-flight. Cleared
  // once the server reports the space as no longer active (i.e. queue is
  // empty AND no completed-within-1h drains pending).
  const [optimisticQueued, setOptimisticQueued] = useState<Set<string>>(new Set());
  const [lookbackInput, setLookbackInput] = useState<Record<string, string>>({});
  const { hasRole } = useAuth();
  const canSync = hasRole('ADMIN');
  const { active } = useActiveWorkspace();
  const configuredSpaces = useMemo<WorkspaceSpace[]>(() => active?.spaces ?? [], [active]);
  const spacesQuery = useSpaces();
  const syncHealthQuery = useSyncHealth();
  const backfill = useBackfill();
  const queryClient = useQueryClient();
  const activeBackfills = useActiveBackfills(canSync);
  const maxLookback = active?.maxBackfillLookbackDays ?? MAX_LOOKBACK_FALLBACK;

  const apiRows: Omit<SpaceRow, 'synced' | 'lastSyncedAt' | 'maxLookbackTried'>[] = Array.isArray(spacesQuery.data) ? spacesQuery.data : [];
  // spaceId → sync metadata (from /reports/ops/sync-health): last successful sync
  // time + longest backfill lookback run. A space with a checkpoint counts as
  // synced even with 0 tasks, and each card can show "synced Xm ago · up to Nd".
  const healthById = useMemo(() => {
    type HealthRow = { scopeId?: string; lastSuccessfulSyncAt?: string | null; maxLookbackDays?: number | null };
    const rows: HealthRow[] = Array.isArray(syncHealthQuery.data) ? syncHealthQuery.data : [];
    const m = new Map<string, SpaceHealth>();
    for (const h of rows) {
      if (h.scopeId && h.lastSuccessfulSyncAt) m.set(h.scopeId, { lastSyncedAt: h.lastSuccessfulSyncAt, maxLookbackDays: h.maxLookbackDays ?? null });
    }
    return m;
  }, [syncHealthQuery.data]);
  const mergedSpaces = useMemo(() => buildMergedSpaces(configuredSpaces, apiRows, healthById), [configuredSpaces, apiRows, healthById]);

  const progressBySpace = useMemo(() => {
    const map = new Map<string, ActiveBackfill>();
    for (const a of activeBackfills.data ?? []) map.set(a.spaceId, a);
    return map;
  }, [activeBackfills.data]);

  // Server-reported truth + optimistic local set. The progress bar drives the
  // displayed indicator; this union also controls "Queued" button labels.
  const queuedIds = useMemo(() => {
    const ids = new Set<string>(optimisticQueued);
    for (const id of progressBySpace.keys()) ids.add(id);
    return ids;
  }, [optimisticQueued, progressBySpace]);

  // Drop a space from optimisticQueued once the server confirms it's active
  // (poll caught up) OR once the server confirms it's *not* active anymore
  // (job finished before the poll). Without this, a transient hiccup in the
  // active endpoint would leave a stale optimistic indicator forever.
  useEffect(() => {
    if (optimisticQueued.size === 0) return;
    if (activeBackfills.data === undefined) return; // wait for first poll
    setOptimisticQueued((cur) => {
      const next = new Set(cur);
      for (const id of cur) if (progressBySpace.has(id)) next.delete(id);
      return next.size === cur.size ? cur : next;
    });
  }, [progressBySpace, activeBackfills.data, optimisticQueued.size]);

  // When a space drops out of the active set (its backfill + time-entry drain
  // finished), refresh the data that just changed — WITHOUT a manual reload:
  //   • `spaces`      → hours/task counts
  //   • `sync-health` → synced status, last-synced time, longest-lookback badge
  const prevActiveIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentActive = new Set(progressBySpace.keys());
    const prev = prevActiveIdsRef.current;
    let resolved = false;
    for (const id of prev) if (!currentActive.has(id)) { resolved = true; break; }
    if (resolved) {
      void queryClient.invalidateQueries({ queryKey: ['spaces'] });
      void queryClient.invalidateQueries({ queryKey: ['sync-health'] });
    }
    prevActiveIdsRef.current = currentActive;
  }, [progressBySpace, queryClient]);

  function progressFor(spaceId: string): ActiveBackfill | null {
    return progressBySpace.get(spaceId) ?? null;
  }

  function lookbackText(spaceId: string): string {
    return lookbackInput[spaceId] ?? String(defaultLookbackFor(configuredSpaces, spaceId));
  }

  function onLookbackChange(spaceId: string, value: string) {
    // Keep only digits while typing (up to 4 → 3650 backstop); clamping to the
    // configured cap happens at sync time in effectiveLookback().
    const digits = value.replace(/[^0-9]/g, '').slice(0, 4);
    setLookbackInput((cur) => ({ ...cur, [spaceId]: digits }));
  }

  function effectiveLookback(spaceId: string): number {
    const raw = lookbackInput[spaceId];
    if (raw === undefined || raw.trim() === '') return defaultLookbackFor(configuredSpaces, spaceId);
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return defaultLookbackFor(configuredSpaces, spaceId);
    return Math.max(MIN_LOOKBACK, Math.min(maxLookback, Math.round(n)));
  }

  function markQueued(spaceId: string) {
    setOptimisticQueued((cur) => new Set(cur).add(spaceId));
    // Force an immediate poll instead of waiting up to 30s for the next tick.
    void queryClient.invalidateQueries({ queryKey: ['backfill-active'] });
  }

  function handleSync(spaceId: string) {
    setSyncingId(spaceId);
    backfill.mutate(
      { spaceId, lookbackDays: effectiveLookback(spaceId) },
      {
        onSuccess: () => markQueued(spaceId),
        onSettled: () => setSyncingId(null),
      },
    );
  }

  function handleSyncAll() {
    if (syncingId !== null) return;
    let chain = Promise.resolve();
    for (const s of mergedSpaces) {
      const sid = s.spaceId?.trim();
      if (!sid) continue;
      chain = chain.then(
        () =>
          new Promise<void>((resolve) => {
            setSyncingId(sid);
            backfill.mutate(
              { spaceId: sid, lookbackDays: effectiveLookback(sid) },
              {
                onSuccess: () => markQueued(sid),
                onSettled: () => { setSyncingId(null); resolve(); },
              },
            );
          }),
      );
    }
  }

  const controls: SyncControls = { syncingId, queuedIds, progressFor, onSync: handleSync, lookbackText, onLookbackChange, canSync };
  const isBusy = syncingId !== null || queuedIds.size > 0;
  const anySynced = mergedSpaces.some((s) => s.synced);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PageHeader
        title="Spaces"
        description="ClickUp space allocation — tasks, time, and cost by space. Set how many days back each space syncs."
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {canSync && (
              <Button
                variant="caution"
                size="md"
                icon={<RefreshCw size={13} />}
                loading={syncingId !== null}
                disabled={isBusy}
                onClick={handleSyncAll}
              >
                Sync all
              </Button>
            )}
            <Tabs value={view} onChange={(k) => setView(k as TabKey)} variant="segmented" items={TAB_ITEMS} />
          </div>
        }
      />

      <QueryError query={spacesQuery} what="spaces" />

      {/* Background processing banner */}
      {queuedIds.size > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 14px',
            background: 'var(--pill-amber-bg)',
            color: 'var(--pill-amber-text)',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
          <span>
            Fetching time entries for {queuedIds.size === 1 ? [...queuedIds][0] : `${queuedIds.size} spaces`} — workers processing in background. Hours will update automatically.
          </span>
        </div>
      )}

      {!spacesQuery.isLoading && !anySynced && (
        <div style={{ padding: '10px 14px', background: 'var(--muted-bg)', borderRadius: 8, fontSize: 13, color: 'var(--text-muted)' }}>
          No spaces have synced yet. Set a "days back" value and hit Sync (or Sync all) to pull tasks and time entries from ClickUp.
        </div>
      )}

      {spacesQuery.isLoading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {[1, 2, 3].map((n) => <Skeleton key={n} height={260} />)}
        </div>
      ) : view === 'grid' ? (
        <SpaceGrid spaces={mergedSpaces} controls={controls} configuredSpaces={configuredSpaces} />
      ) : (
        <WorkloadView spaces={mergedSpaces} controls={controls} configuredSpaces={configuredSpaces} />
      )}
    </div>
  );
}
