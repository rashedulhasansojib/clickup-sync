import { useMemo, useState } from 'react';
import { Search, Moon, Sun, Calendar, Layers, Menu, Building2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Kbd } from '../ui/Kbd';
import { Select } from '../ui/Select';
import { UserMenu } from './UserMenu';
import { NotificationCenter } from './NotificationCenter';
import { useGlobalFilters, type DateRange } from '../../hooks/useGlobalFilters';
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace';
import { useSpaces, useSyncHealth } from '../../hooks/useReports';
import { fmt } from '../../lib/formatters';
import { currentTheme, toggleTheme as flipTheme } from '../../lib/theme';

const DATE_RANGES = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom range…' },
];

// The top-bar date/space filters use the SAME shared <Select> as every other
// dropdown in the app (custom 3D menu, row-3d options, check marks, lucide
// chevron) — not a native <select>. This keeps them visually identical to
// dropdowns elsewhere; only difference is the leading icon.
function IconSelect({ icon: Icon, options, value, onChange, ariaLabel }: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; style?: React.CSSProperties }>;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
}) {
  return (
    <Select
      size="sm"
      icon={<Icon size={13} strokeWidth={1.75} />}
      options={options}
      value={value}
      onChange={onChange}
      ariaLabel={ariaLabel}
    />
  );
}

function DateInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="date"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="btn-3d"
      style={{
        height: 28,
        fontSize: 12,
        fontWeight: 500,
        padding: '0 8px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 9,
        color: 'var(--text)',
        fontFamily: 'inherit',
        cursor: 'pointer',
        width: 140,
        ['--b-edge' as string]: 'var(--border-strong)',
        ['--b-glow' as string]: 'var(--btn-neutral-glow)',
        ['--b-glow-strong' as string]: 'var(--btn-neutral-glow-strong)',
      }}
    />
  );
}

export function TopBar({ onSearchClick, isMobile = false, onMenuClick }: {
  onSearchClick?: () => void;
  isMobile?: boolean;
  onMenuClick?: () => void;
}) {
  const navigate = useNavigate();
  const { dateRange, space, setDateRange, setSpace, customFrom, customTo, setCustomFrom, setCustomTo } = useGlobalFilters();
  const { workspaces, activeId, setActive } = useActiveWorkspace();
  const { data: health } = useSyncHealth();
  const { data: spacesData } = useSpaces();
  const [isDark, setIsDark] = useState(() => currentTheme() === 'dark');

  const activeWorkspace = workspaces.find((w) => w.id === activeId);

  // Workspace switcher options. Hidden entirely when only one workspace exists
  // (nothing to switch), so single-workspace deployments look unchanged.
  const workspaceOptions = useMemo(
    () => workspaces.map((w) => ({ value: w.id, label: w.name })),
    [workspaces],
  );

  function onWorkspaceChange(id: string) {
    if (id === activeId) return;
    // A space id is workspace-specific, so reset the space filter when the
    // workspace changes (the provider refetches all scoped data).
    setSpace('all');
    setActive(id);
  }

  // Build the space dropdown from the ACTIVE workspace's configured spaces,
  // merged with live aggregates (for friendly labels + any space synced via
  // webhook that isn't configured yet). If ClickUp returned no space.name we
  // render "Space {id}" rather than a bare ID so it doesn't look like a typo.
  const spaceOptions = useMemo(() => {
    type Row = { spaceId: string | null; spaceName: string | null };
    const rows: Row[] = Array.isArray(spacesData) ? (spacesData as Row[]) : [];
    const opts: { value: string; label: string }[] = [{ value: 'all', label: 'All spaces' }];
    const seen = new Set<string>(['all']);
    for (const cfg of activeWorkspace?.spaces ?? []) {
      const hit = rows.find((r) => r.spaceId === cfg.spaceId);
      const label = hit?.spaceName?.trim() || cfg.name;
      opts.push({ value: cfg.spaceId, label });
      seen.add(cfg.spaceId);
    }
    for (const r of rows) {
      const id = r.spaceId?.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const label = (r.spaceName ?? '').trim() || `Space ${id}`;
      opts.push({ value: id, label });
    }
    return opts;
  }, [spacesData, activeWorkspace]);

  function toggleTheme() {
    setIsDark(flipTheme() === 'dark');
  }

  // Defensively coerce: if the API returned an error envelope / HTML / unexpected
  // shape, `health` may be a non-array truthy value (e.g. a string) and `.every`
  // would crash this whole component.
  const healthItems: { status: string; lastSuccessfulSyncAt?: string | null }[] =
    Array.isArray(health) ? health : [];
  const lastSyncAt = healthItems[0]?.lastSuccessfulSyncAt ?? null;
  const allFresh = healthItems.length > 0 && healthItems.every((h) => h.status === 'Fresh');

  return (
    <header style={{
      height: 56,
      padding: '0 18px',
      flexShrink: 0,
      borderBottom: '1px solid var(--border)',
      background: 'var(--surface)',
      display: 'flex', alignItems: 'center', gap: 10,
      position: 'sticky', top: 0, zIndex: 30,
      backdropFilter: 'blur(8px)',
      flexWrap: dateRange === 'custom' || isMobile ? 'wrap' : 'nowrap',
      rowGap: 8,
    }}>
      {/* Hamburger — opens the off-canvas nav drawer (mobile only) */}
      {isMobile && (
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open navigation"
          className="btn-3d"
          style={{
            width: 32, height: 32, border: '1px solid var(--border)',
            background: 'var(--surface)', color: 'var(--text)',
            borderRadius: 9, cursor: 'pointer', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            ['--b-edge' as string]: 'var(--border-strong)',
            ['--b-glow' as string]: 'var(--btn-neutral-glow)',
            ['--b-glow-strong' as string]: 'var(--btn-neutral-glow-strong)',
          }}
        >
          <Menu size={16} strokeWidth={1.75} />
        </button>
      )}

      {/* Search trigger */}
      <button
        type="button"
        onClick={onSearchClick}
        className="btn-3d"
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          height: 32, padding: '0 10px',
          minWidth: isMobile ? 0 : 280,
          flex: isMobile ? '1 1 140px' : '0 0 auto',
          background: 'var(--muted-bg)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', borderRadius: 9,
          cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
          ['--b-edge' as string]: 'var(--border-strong)',
          ['--b-glow' as string]: 'var(--btn-neutral-glow)',
          ['--b-glow-strong' as string]: 'var(--btn-neutral-glow-strong)',
        }}
      >
        <Search size={14} strokeWidth={1.75} />
        <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isMobile ? 'Search…' : 'Search tasks, assignees, events…'}
        </span>
        {!isMobile && <Kbd>⌘K</Kbd>}
      </button>

      {/* On mobile this becomes a full-width line break so the filters/actions
          wrap onto their own row below the search field. */}
      <div style={{ flex: isMobile ? '1 1 100%' : 1 }} />

      {/* Workspace switcher — only when more than one workspace is connected. */}
      {workspaceOptions.length > 1 && (
        <IconSelect icon={Building2} options={workspaceOptions} value={activeId ?? ''} onChange={onWorkspaceChange} ariaLabel="Workspace" />
      )}

      <IconSelect icon={Calendar} options={DATE_RANGES} value={dateRange} onChange={v => setDateRange(v as DateRange)} ariaLabel="Date range" />

      {/* Custom date range inputs */}
      {dateRange === 'custom' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <DateInput value={customFrom} onChange={setCustomFrom} placeholder="From" />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>→</span>
          <DateInput value={customTo} onChange={setCustomTo} placeholder="To" />
        </div>
      )}

      <IconSelect icon={Layers} options={spaceOptions} value={space} onChange={setSpace} ariaLabel="Space" />

      {/* Divider */}
      <div style={{ height: 20, width: 1, background: 'var(--border)', flexShrink: 0 }} />

      {/* Sync status */}
      <button
        type="button"
        onClick={() => navigate('/sync-logs')}
        className="btn-3d"
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 10px', borderRadius: 9,
          background: 'var(--pill-green-bg)', color: 'var(--pill-green-text)',
          border: 0, cursor: 'pointer', fontSize: 12, fontWeight: 600,
          fontFamily: 'inherit', flexShrink: 0,
          ['--b-edge' as string]: 'var(--border-strong)',
          ['--b-glow' as string]: 'var(--btn-neutral-glow)',
          ['--b-glow-strong' as string]: 'var(--btn-neutral-glow-strong)',
        }}
      >
        <span style={{
          width: 6, height: 6, borderRadius: 999, background: '#10b981',
          boxShadow: '0 0 0 3px rgba(16, 185, 129, 0.18)',
          animation: 'pulse 2s infinite',
          flexShrink: 0,
        }} />
        {lastSyncAt ? `Synced ${fmt.relative(lastSyncAt)}` : allFresh ? 'All synced' : 'Syncing…'}
      </button>

      {/* Theme toggle */}
      <button
        type="button"
        onClick={toggleTheme}
        className="btn-3d"
        style={{
          width: 32, height: 32, border: '1px solid var(--border)',
          background: 'var(--surface)', color: 'var(--text)',
          borderRadius: 9, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          ['--b-edge' as string]: 'var(--border-strong)',
          ['--b-glow' as string]: 'var(--btn-neutral-glow)',
          ['--b-glow-strong' as string]: 'var(--btn-neutral-glow-strong)',
        }}
        title={isDark ? 'Light mode' : 'Dark mode'}
      >
        {isDark ? <Sun size={14} strokeWidth={1.75} /> : <Moon size={14} strokeWidth={1.75} />}
      </button>

      {/* Notification center — real feed of failed jobs, budget overruns, cost
          anomalies, and un-notified hour spikes, with a persisted unread badge. */}
      <NotificationCenter />

      {/* Divider */}
      <div style={{ height: 20, width: 1, background: 'var(--border)', flexShrink: 0 }} />

      {/* Account menu (avatar → dropdown with identity + sign out) */}
      <UserMenu />
    </header>
  );
}
