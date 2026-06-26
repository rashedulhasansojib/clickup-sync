import { useState, useMemo, useEffect, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import {
  Search, Download, RefreshCw, X, CheckSquare, Copy, ExternalLink,
  CircleCheck, Inbox,
} from 'lucide-react';
import { useTasks, useTasksAssignees, useTasksSummary, useClients, useLists, useFolders } from '../hooks/useReports';
import { useTaskHistory } from '../hooks/useTaskHistory';
import { useGlobalFilters } from '../hooks/useGlobalFilters';
import { useAuth } from '../hooks/useAuth';
import { PageHeader } from '../components/ui/PageHeader';
import { Pill } from '../components/ui/Pill';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { DataTable } from '../components/ui/DataTable';
import type { Column } from '../components/ui/DataTable';
import { QueryError } from '../components/ui/QueryError';
import { StatusBadge } from '../components/ui/StatusBadge';
import { ClickupAvatar, ClickupAvatarStack } from '../components/ui/ClickupAvatar';
import { Drawer } from '../components/ui/Drawer';
import { Tabs } from '../components/ui/Tabs';
import { TaskTimeline, type TaskTimelineEvent } from '../components/tasks/TaskTimeline';
import { fmt } from '../lib/formatters';
import { adminApi } from '../api/admin';
import { reportsApi } from '../api/reports';
import { exportXlsx, type XlsxColumn } from '../lib/xlsx';

type Task = Record<string, unknown>;

const PRIORITY_OPTIONS = [
  { value: '', label: 'Any priority' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
];

const TYPE_OPTIONS = [
  { value: '', label: 'Parent + subtasks' },
  { value: 'parent', label: 'Parent only' },
  { value: 'subtask', label: 'Subtasks only' },
];

const ARCHIVED_OPTIONS = [
  { value: 'exclude', label: 'Hide archived' },
  { value: 'include', label: 'Include archived' },
  { value: 'only', label: 'Archived only' },
];

function parseAssignees(r: Task): { name: string; email?: string }[] {
  const names = String(r.assigneesNames ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const emails = String(r.assigneesEmails ?? '').split(',').map((s) => s.trim());
  return names.map((name, i) => ({ name, email: emails[i] || undefined }));
}

function statusColor(r: Task): string {
  const c = r.statusColor ?? r.status_color;
  if (c && String(c)) return String(c);
  return '#94a3b8';
}

function isOverdue(task: Task): boolean {
  const due = task.dueDate ?? task.due_date;
  if (!due) return false;
  const statusType = String(task.statusType ?? task.status_type ?? '').toLowerCase();
  if (statusType === 'closed') return false;
  const status = String(task.status ?? '').toLowerCase();
  if (status === 'closed' || status === 'complete' || status === 'completed') return false;
  return new Date(String(due)).getTime() < Date.now();
}

function isJustSynced(task: Task): boolean {
  const synced = task.syncedAt ?? task.synced_at;
  if (!synced) return false;
  return Date.now() - new Date(String(synced)).getTime() < 30 * 60 * 1000;
}

function MetaGrid({ items }: { items: [string, ReactNode | unknown][] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px 20px' }}>
      {items.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{k}</span>
          <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {cell(v)}
          </span>
        </div>
      ))}
    </div>
  );
}

function cell(v: unknown): ReactNode {
  if (v == null || v === '') return '—';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return v as ReactNode;
}

function TaskDetailDrawer({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const [tab, setTab] = useState('overview');

  useEffect(() => {
    setTab('overview');
  }, [String(task?.taskId ?? task?.task_id ?? '')]);

  const taskIdForHistory = task ? String(task.taskId ?? task.task_id ?? '') : null;
  const history = useTaskHistory(taskIdForHistory || null);

  const historyItems = history.data ?? [];
  const timelineEvents = historyItems.filter((it): it is TaskTimelineEvent => it.kind === 'event');
  const syncJobs = historyItems.filter((it) => it.kind === 'job');

  if (!task) return <Drawer open={false} onClose={onClose} />;

  const assignees = parseAssignees(task);
  const status = String(task.status ?? '');
  const priority = String(task.priority ?? '');
  const priorityTone = priority === 'urgent' ? 'red' : priority === 'high' ? 'amber' : 'gray';
  const archived = !!task.archived;

  return (
    <Drawer open width={620} onClose={onClose}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)',
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          }}
          >
            <CheckSquare size={12} strokeWidth={1.75} />
            <span>{String(task.taskId ?? task.task_id ?? '')}</span>
            <button type="button" title="Copy task ID" style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', padding: 2 }}>
              <Copy size={11} strokeWidth={1.75} />
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" variant="default" icon={<ExternalLink size={13} strokeWidth={1.75} />}>Open in ClickUp</Button>
            <button
              type="button"
              onClick={onClose}
              className="btn-3d"
              style={{
                width: 28, height: 28, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', borderRadius: 6,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                ['--b-edge' as string]: 'var(--border-strong)',
                ['--b-glow' as string]: 'var(--btn-neutral-glow)',
                ['--b-glow-strong' as string]: 'var(--btn-neutral-glow-strong)',
              }}
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', margin: '4px 0 10px', lineHeight: 1.3, letterSpacing: '-0.01em' }}>
          {String(task.taskName ?? task.task_name ?? '')}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <StatusBadge status={status} color={task.statusColor as string | undefined} />
          {priority && <Pill tone={priorityTone}>{priority}</Pill>}
          {archived && <Pill tone="gray" size="xs">archived</Pill>}
          <span style={{ flex: 1 }} />
          {task.syncedAt || task.synced_at
            ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Synced {fmt.relative(String(task.syncedAt ?? task.synced_at))}</span>
            : null}
        </div>
      </div>

      <div style={{ padding: '0 20px', flexShrink: 0 }}>
        <Tabs value={tab} onChange={setTab} items={[
          { value: 'overview', label: 'Overview' },
          { value: 'timeline', label: 'Timeline' },
          { value: 'sync', label: 'Sync history' },
          { value: 'raw', label: 'Raw fields' },
        ]}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {tab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 10px' }}>Hierarchy & ownership</h3>
              <MetaGrid items={[
                ['Space', task.spaceName ?? task.space_name],
                ['List', task.listName ?? task.list_name],
                ['Parent task', task.parentTaskId ?? task.parent_task_id ?? '—'],
                ['Creator', task.creatorName ?? task.creator_name],
                ['Assignees', assignees.length > 0 ? <ClickupAvatarStack users={assignees} max={5} /> : '—'],
              ] as [string, ReactNode][]} />
            </div>
            <div>
              <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 10px' }}>Business</h3>
              <MetaGrid items={[
                ['Client', task.client],
                ['Department', task.department],
                ['Sprint', task.sprintName ?? task.sprint_name],
                ['Sprint points', task.sprintPoints ?? task.sprint_points],
              ] as [string, ReactNode][]} />
            </div>
            <div>
              <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 10px' }}>Dates</h3>
              <MetaGrid items={[
                ['Created', task.createdDate || task.created_date ? fmt.date(String(task.createdDate ?? task.created_date)) : '—'],
                ['Updated', task.updatedDate || task.updated_date ? fmt.date(String(task.updatedDate ?? task.updated_date)) : '—'],
                ['Due', task.dueDate || task.due_date ? fmt.date(String(task.dueDate ?? task.due_date)) : '—'],
                ['Synced', task.syncedAt || task.synced_at ? fmt.dateTime(String(task.syncedAt ?? task.synced_at)) : '—'],
              ] as [string, ReactNode][]} />
            </div>
          </div>
        )}
        {tab === 'timeline' && (
          <TaskTimeline events={timelineEvents} loading={history.isLoading} />
        )}
        {tab === 'raw' && (
          <pre style={{
            fontSize: 11, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            background: 'var(--code-bg)', color: 'var(--text)',
            padding: 14, borderRadius: 8, overflow: 'auto', margin: 0,
            border: '1px solid var(--border)', lineHeight: 1.6,
          }}
          >
            {JSON.stringify(task, null, 2)}
          </pre>
        )}
        {tab === 'sync' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, background: 'var(--muted-bg)', borderRadius: 8 }}>
              <span style={{ width: 24, height: 24, borderRadius: 999, background: 'var(--pill-green-bg)', color: 'var(--pill-green-text)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <CircleCheck size={13} strokeWidth={1.75} />
              </span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>Sync count: <strong>{String(task.syncCount ?? task.sync_count ?? '—')}</strong></div>
                {(task.syncedAt ?? task.synced_at) != null && String(task.syncedAt ?? task.synced_at) !== '' && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Latest at {fmt.dateTime(String(task.syncedAt ?? task.synced_at))}</div>
                )}
              </div>
            </div>
            {history.isLoading ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading activity…</div>
            ) : syncJobs.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No recorded sync jobs yet. Field changes appear under the Timeline tab.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {syncJobs.map((it) => (
                  <div key={it.kind + it.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 8, background: 'var(--muted-bg)' }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: it.kind === 'job' && it.error ? 'var(--red)' : 'var(--text-muted)', minWidth: 52 }}>
                      SYNC
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: 'var(--text)' }}>
                        {it.kind === 'job' ? `${it.jobName} (${it.queueName}) · ${it.status}` : ''}
                      </div>
                      {it.kind === 'job' && it.error && (
                        <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 2, wordBreak: 'break-word' }}>{it.error}</div>
                      )}
                      {it.at && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{fmt.relative(it.at)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}

export function TasksPage() {
  const { space, fromDate, toDate } = useGlobalFilters();
  const queryClient = useQueryClient();
  const { data: assigneesData } = useTasksAssignees();
  const { data: summary } = useTasksSummary();
  const { data: clientsData } = useClients();
  const { data: listsData } = useLists(space !== 'all' ? space : undefined);
  const { data: foldersData } = useFolders(space !== 'all' ? space : undefined);

  // Debounced search: typing fires `searchRaw` immediately, but the request
  // (and `page=1` reset) only fire after 300ms of quiet, matching TimeEntriesPage.
  const [searchRaw, setSearchRaw] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [listFilter, setListFilter] = useState('');
  const [folderFilter, setFolderFilter] = useState('');
  const [archivedFilter, setArchivedFilter] = useState('exclude');
  const [taskIdsFilter, setTaskIdsFilter] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  // Detail drawer selection is local state (like TimeEntriesPage), NOT a URL
  // route. Driving it through `/tasks/:taskId` remounted the page on row click
  // — wiping page/pageSize/filters and leaving the drawer unable to find the
  // clicked row when it lived past page 1 / row 50.
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  // Mirror the DataTable's column show/hide state here so CSV export can drop
  // the same hidden columns (keys match the `columns` defs below).
  const [hiddenCols, setHiddenCols] = useState<string[]>([]);

  // Apply ?taskIds= from deep-links (e.g. Missing Rates "Show more" button).
  // Snapshot once on mount and strip the query so back-navigation doesn't
  // re-apply, and so the in-page filter state is the source of truth. We also
  // flip `archivedFilter` to 'include' so an archived affected-task isn't
  // silently hidden by the default 'exclude'.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const raw = searchParams.get('taskIds');
    if (!raw) return;
    const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTaskIdsFilter(ids);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArchivedFilter('include');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchRaw);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchRaw]);

  // A ClickUp list belongs to a single space, so a selection made under one
  // space is meaningless after the topbar space changes — clear it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setListFilter('');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFolderFilter('');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [space]);

  // Source the dropdown from /reports/tasks/assignees, not from
  // time-entries-by-user — otherwise assignees with zero logged hours (e.g.
  // expense-only tasks like Hello Ahmad's) silently disappear from the filter
  // even though their tasks are in the DB.
  const assigneeOptions = useMemo(() => {
    const rows = (Array.isArray(assigneesData) ? assigneesData : []) as { name: string; taskCount?: number }[];
    const seen = new Set<string>();
    // These rows carry only a name (no ClickUp id/email), so the avatar resolves
    // by username — falling back to initials when there's no directory match.
    const opts: { value: string; label: string; icon?: ReactNode }[] = [{ value: '', label: 'Any assignee' }];
    for (const r of rows) {
      if (!r.name || seen.has(r.name)) continue;
      seen.add(r.name);
      const count = typeof r.taskCount === 'number' ? ` (${r.taskCount})` : '';
      opts.push({ value: r.name, label: `${r.name}${count}`, icon: <ClickupAvatar name={r.name} size={18} /> });
    }
    return opts;
  }, [assigneesData]);

  const clientOptions = useMemo(() => {
    const rows = (Array.isArray(clientsData) ? clientsData : []) as { client: string; taskCount?: number }[];
    const opts = [{ value: '', label: 'Any client' }];
    for (const r of rows) {
      if (!r.client) continue;
      const count = typeof r.taskCount === 'number' ? ` (${r.taskCount})` : '';
      opts.push({ value: r.client, label: `${r.client}${count}` });
    }
    return opts;
  }, [clientsData]);

  const listOptions = useMemo(() => {
    const rows = (Array.isArray(listsData) ? listsData : []) as { listId: string; listName: string; spaceName?: string | null; taskCount?: number }[];
    const showSpace = space === 'all';
    const opts = [{ value: '', label: 'Any list' }];
    for (const r of rows) {
      if (!r.listId) continue;
      const count = typeof r.taskCount === 'number' ? ` (${r.taskCount})` : '';
      const label = showSpace && r.spaceName ? `${r.spaceName} · ${r.listName}${count}` : `${r.listName}${count}`;
      opts.push({ value: r.listId, label });
    }
    return opts;
  }, [listsData, space]);

  const folderOptions = useMemo(() => {
    const rows = (Array.isArray(foldersData) ? foldersData : []) as { folderId: string; folderName: string; spaceName?: string | null; taskCount?: number }[];
    const showSpace = space === 'all';
    const opts = [{ value: '', label: 'Any folder' }];
    for (const r of rows) {
      if (!r.folderId) continue;
      const count = typeof r.taskCount === 'number' ? ` (${r.taskCount})` : '';
      const label = showSpace && r.spaceName ? `${r.spaceName} · ${r.folderName}${count}` : `${r.folderName}${count}`;
      opts.push({ value: r.folderId, label });
    }
    return opts;
  }, [foldersData, space]);

  // Drive status dropdown from actual stored statuses so picking one always matches.
  // ClickUp statuses are list-configured strings — a hardcoded list misses real values
  // (e.g. "to do", "complete") and includes ones that never appear (e.g. "open").
  const statusOptions = useMemo(() => {
    const rows = (summary?.byStatus ?? []) as { status: string | null; count: number }[];
    const opts: { value: string; label: string }[] = [{ value: '', label: 'Any status' }];
    const seen = new Set<string>();
    for (const r of rows) {
      const s = (r.status ?? '').trim();
      if (!s || seen.has(s.toLowerCase())) continue;
      seen.add(s.toLowerCase());
      opts.push({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) });
    }
    return opts;
  }, [summary]);

  const isDeepLink = taskIdsFilter.length > 0;
  const taskParams = useMemo(() => ({
    limit: pageSize,
    offset: (page - 1) * pageSize,
    // Topbar space and date range are intentionally bypassed when a taskIds
    // deep link is active. The user clicked through with an explicit task set
    // (e.g. from Missing Rates); layering an unrelated `updated_date` window
    // on top would silently drop tasks they expected to see.
    spaceId: isDeepLink ? undefined : (space !== 'all' ? space : undefined),
    status: statusFilter || undefined,
    priority: priorityFilter || undefined,
    type: typeFilter || undefined,
    search: search || undefined,
    assigneeId: assigneeFilter || undefined,
    client: clientFilter || undefined,
    listId: listFilter || undefined,
    folderId: folderFilter || undefined,
    archived: archivedFilter,
    taskIds: isDeepLink ? taskIdsFilter.join(',') : undefined,
    // Global topbar date range filters by task `updated_date`.
    from: isDeepLink ? undefined : (fromDate || undefined),
    to: isDeepLink ? undefined : (toDate || undefined),
  }), [page, pageSize, isDeepLink, space, statusFilter, priorityFilter, typeFilter, search, assigneeFilter, clientFilter, listFilter, folderFilter, archivedFilter, taskIdsFilter, fromDate, toDate]);

  const tasksQuery = useTasks(taskParams as Record<string, string | number | undefined>);
  const { data, isLoading, refetch } = tasksQuery;

  const items: Task[] = (data?.items ?? []) as Task[];
  const total: number = data?.total ?? 0;

  const hasFilters = !!(
    searchRaw || search || statusFilter || priorityFilter || typeFilter || assigneeFilter || clientFilter || listFilter || folderFilter || archivedFilter !== 'exclude' || taskIdsFilter.length > 0
  );

  function reset() {
    setSearchRaw('');
    setSearch('');
    setStatusFilter('');
    setPriorityFilter('');
    setTypeFilter('');
    setAssigneeFilter('');
    setClientFilter('');
    setListFilter('');
    setFolderFilter('');
    setArchivedFilter('exclude');
    setTaskIdsFilter([]);
    setPage(1);
  }

  const { hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN');

  const backfill = useMutation({
    mutationFn: () => (space !== 'all' ? adminApi.backfill(space, 7) : Promise.resolve(null)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  // CSV export pulls the full filtered set in one request (not just the current
  // page of 50). Backend `safeLimit` caps at 5000 — enough for the present
  // data volume; if any single space ever exceeds that, the export silently
  // truncates and we'd need to paginate here.
  const exportExcel = useMutation({
    mutationFn: async () => {
      const { items } = await reportsApi.tasks({ ...taskParams, limit: 5000, offset: 0 });
      // `key` ties a column to its DataTable column so columns hidden via the
      // table's "Columns" menu are dropped here too. Columns with no `key` are
      // export-only (not hideable in the table) and always export.
      const cols: XlsxColumn<Task>[] = [
        { header: 'Task ID',       value: (r) => r.taskId ?? r.task_id },
        { header: 'Task name',     value: (r) => r.taskName ?? r.task_name, key: 'task_name', width: 42 },
        { header: 'Parent task',   value: (r) => r.parentTaskId ?? r.parent_task_id },
        { header: 'Space',         value: (r) => r.spaceName ?? r.space_name, key: 'space_name' },
        { header: 'List',          value: (r) => r.listName ?? r.list_name, key: 'list_name' },
        { header: 'Status',        value: 'status', key: 'status' },
        { header: 'Status type',   value: (r) => r.statusType ?? r.status_type },
        { header: 'Priority',      value: 'priority' },
        { header: 'Assignees',     value: 'assigneesNames', key: 'assignees', width: 30 },
        { header: 'Assignee emails', value: 'assigneesEmails', key: 'assignees', width: 30 },
        { header: 'Client',        value: 'client', key: 'client' },
        { header: 'Department',    value: 'department', key: 'department' },
        { header: 'Sprint',        value: (r) => r.sprintName ?? r.sprint_name, key: 'sprint_name' },
        { header: 'Sprint points', value: (r) => r.sprintPoints ?? r.sprint_points, key: 'sprint_points', type: 'number' },
        { header: 'Est. hours',    value: (r) => r.timeEstimateHours ?? r.time_estimate_hours, key: 'time_estimate', type: 'number' },
        { header: 'Spent hours',   value: (r) => r.timeSpentHours ?? r.time_spent_hours, key: 'time_spent', type: 'number' },
        { header: 'Created',       value: (r) => r.createdDate ?? r.created_date, type: 'date' },
        { header: 'Updated',       value: (r) => r.updatedDate ?? r.updated_date, key: 'updated_date', type: 'date' },
        { header: 'Due',           value: (r) => r.dueDate ?? r.due_date, type: 'date' },
        { header: 'Closed',        value: (r) => r.closedDate ?? r.closed_date, type: 'date' },
        { header: 'Archived',      value: 'archived' },
        { header: 'Synced',        value: (r) => r.syncedAt ?? r.synced_at, key: 'synced_at', type: 'date' },
      ];
      const visibleCols = cols.filter((c) => !c.key || !hiddenCols.includes(c.key));
      await exportXlsx({ filename: 'tasks', sheetName: 'Tasks', rows: items as Task[], columns: visibleCols });
      return { rows: items.length };
    },
  });

  const columns: Column<Task>[] = useMemo(() => [
    {
      key: 'task_name',
      header: 'Task',
      width: 360,
      render: (r) => {
        const bar = statusColor(r);
        const overdue = isOverdue(r);
        const justSynced = isJustSynced(r);
        const isSubtask = !!(r.parentTaskId || r.parent_task_id);
        const arch = !!r.archived;
        // maxWidth bounds the flex row so a long name truncates instead of
        // widening the column. 336 = column width 360 − cell padding (12+12).
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: 336, overflow: 'hidden', paddingLeft: isSubtask ? 14 : 0 }}>
            {isSubtask && (
              <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--text-faint)', flexShrink: 0 }} />
            )}
            <span style={{ width: 4, height: 16, borderRadius: 2, background: bar, flexShrink: 0 }} />
            <span
              title={String(r.taskName ?? r.task_name ?? '')}
              style={{
                flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontWeight: 500, color: 'var(--text)',
              }}
            >
              {String(r.taskName ?? r.task_name ?? '')}
            </span>
            {arch && <Pill tone="gray" size="xs">archived</Pill>}
            {overdue && <Pill tone="red" size="xs">overdue</Pill>}
            {justSynced && !overdue && <Pill tone="green" size="xs">just synced</Pill>}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      width: 120,
      render: (r) => <StatusBadge status={String(r.status ?? '')} color={r.statusColor as string | undefined} />,
    },
    {
      key: 'space_name',
      header: 'Space',
      width: 130,
      render: (r) => {
        const spaceName = String(r.spaceName ?? r.space_name ?? '');
        return spaceName
          ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{spaceName}</span>
          : <span style={{ color: 'var(--text-faint)' }}>—</span>;
      },
    },
    {
      key: 'list_name',
      header: 'List',
      width: 110,
      render: (r) => {
        const listName = String(r.listName ?? r.list_name ?? '');
        return listName
          ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{listName}</span>
          : <span style={{ color: 'var(--text-faint)' }}>—</span>;
      },
    },
    {
      key: 'assignees',
      header: 'Assignees',
      width: 110,
      sortable: false,
      render: (r) => {
        const users = parseAssignees(r);
        return users.length > 0 ? <ClickupAvatarStack users={users} max={3} /> : <span style={{ color: 'var(--text-faint)' }}>—</span>;
      },
    },
    {
      key: 'client',
      header: 'Client',
      width: 130,
      render: (r) => {
        const client = String(r.client ?? '');
        return client
          ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{client}</span>
          : <span style={{ color: 'var(--text-faint)' }}>—</span>;
      },
    },
    {
      key: 'department',
      header: 'Dept',
      width: 110,
      render: (r) => {
        const dept = String(r.department ?? '');
        return dept ? <Pill tone="gray" size="xs">{dept}</Pill> : <span style={{ color: 'var(--text-faint)' }}>—</span>;
      },
    },
    {
      key: 'sprint_name',
      header: 'Sprint',
      width: 100,
      render: (r) => {
        const sn = String(r.sprintName ?? r.sprint_name ?? '');
        return sn
          ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sn}</span>
          : <span style={{ color: 'var(--text-faint)' }}>—</span>;
      },
    },
    {
      key: 'sprint_points',
      header: 'Pts',
      width: 60,
      align: 'right',
      render: (r) => {
        const pts = r.sprintPoints ?? r.sprint_points;
        return pts != null
          ? <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{String(pts)}</span>
          : <span style={{ color: 'var(--text-faint)' }}>—</span>;
      },
    },
    {
      key: 'time_estimate',
      header: 'Est',
      width: 70,
      align: 'right',
      render: (r) => {
        const h = r.timeEstimateHours ?? r.time_estimate_hours;
        if (h == null || Number.isNaN(Number(h))) return <span style={{ color: 'var(--text-faint)' }}>—</span>;
        return <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{fmt.shortHours(Number(h))}</span>;
      },
    },
    {
      key: 'time_spent',
      header: 'Spent',
      width: 70,
      align: 'right',
      render: (r) => {
        const spent = r.timeSpentHours ?? r.time_spent_hours;
        const est = r.timeEstimateHours ?? r.time_estimate_hours;
        if (spent == null || Number.isNaN(Number(spent))) {
          return <span style={{ color: 'var(--text-faint)' }}>—</span>;
        }
        const over = est != null && !Number.isNaN(Number(est)) && Number(spent) > Number(est);
        return (
          <span style={{
            fontVariantNumeric: 'tabular-nums',
            color: over ? 'var(--red)' : 'var(--text)',
            fontWeight: over ? 600 : 500,
          }}
          >
            {fmt.shortHours(Number(spent))}
          </span>
        );
      },
    },
    {
      key: 'updated_date',
      header: 'Updated',
      width: 100,
      align: 'right',
      render: (r) => {
        const d = r.updatedDate ?? r.updated_date;
        return d
          ? <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)', fontSize: 12 }}>{fmt.relative(String(d))}</span>
          : <span style={{ color: 'var(--text-faint)' }}>—</span>;
      },
    },
    {
      key: 'synced_at',
      header: 'Synced',
      width: 100,
      align: 'right',
      render: (r) => {
        const d = r.syncedAt ?? r.synced_at;
        return d
          ? <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)', fontSize: 12 }}>{fmt.relative(String(d))}</span>
          : <span style={{ color: 'var(--text-faint)' }}>—</span>;
      },
    },
  ], []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PageHeader
        title="Tasks"
        description="Audit synced ClickUp tasks and subtasks across all spaces."
        badge={<Pill tone="gray">{fmt.number(total)}</Pill>}
        actions={
          <>
            <Button
              variant="subtle"
              size="md"
              icon={<Download size={13} strokeWidth={1.75} />}
              loading={exportExcel.isPending}
              disabled={exportExcel.isPending || isLoading}
              onClick={() => exportExcel.mutate()}
            >
              Export Excel
            </Button>
            {isAdmin && (
              <Button
                variant="caution"
                size="md"
                icon={<RefreshCw size={13} strokeWidth={1.75} />}
                loading={backfill.isPending}
                onClick={() => {
                  if (space !== 'all') backfill.mutate();
                  else void refetch();
                }}
              >
                Sync now
              </Button>
            )}
          </>
        }
      />

      {taskIdsFilter.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 14px',
            background: 'var(--amber-bg, var(--muted-bg))',
            border: '1px solid var(--amber, var(--border))',
            borderRadius: 10,
            fontSize: 13,
          }}
        >
          <Pill tone="amber" size="xs">deep link</Pill>
          <span style={{ color: 'var(--text)' }}>
            Filtered to {taskIdsFilter.length} specific task{taskIdsFilter.length === 1 ? '' : 's'} from Missing Rates.
            <span style={{ color: 'var(--text-muted)' }}> Topbar space &amp; date range are bypassed. Archived tasks are included.</span>
          </span>
          <span style={{ flex: 1 }} />
          <Button
            size="sm"
            variant="ghost"
            icon={<X size={12} strokeWidth={1.75} />}
            onClick={() => { setTaskIdsFilter([]); setPage(1); }}
          >
            Clear
          </Button>
        </div>
      )}

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      }}
      >
        <div style={{ flex: 1, minWidth: 220, maxWidth: 320 }}>
          <Input
            icon={<Search size={14} strokeWidth={1.75} />}
            value={searchRaw}
            onChange={e => setSearchRaw(e.target.value)}
            placeholder="Search task name, ID, assignee, client…"
            aria-label="Search tasks"
          />
        </div>
        <Select ariaLabel="Filter by status" size="md" value={statusFilter} onChange={v => { setStatusFilter(v); setPage(1); }} options={statusOptions} />
        <Select ariaLabel="Filter by priority" size="md" value={priorityFilter} onChange={v => { setPriorityFilter(v); setPage(1); }} options={PRIORITY_OPTIONS} />
        <Select ariaLabel="Filter by assignee" size="md" value={assigneeFilter} onChange={v => { setAssigneeFilter(v); setPage(1); }} options={assigneeOptions} />
        <Select ariaLabel="Filter by client" size="md" value={clientFilter} onChange={v => { setClientFilter(v); setPage(1); }} options={clientOptions} />
        <Select ariaLabel="Filter by folder" size="md" value={folderFilter} onChange={v => { setFolderFilter(v); setPage(1); }} options={folderOptions} />
        <Select ariaLabel="Filter by list" size="md" value={listFilter} onChange={v => { setListFilter(v); setPage(1); }} options={listOptions} />
        <Select ariaLabel="Filter by type" size="md" value={typeFilter} onChange={v => { setTypeFilter(v); setPage(1); }} options={TYPE_OPTIONS} />
        <Select ariaLabel="Filter by archived state" size="md" value={archivedFilter} onChange={v => { setArchivedFilter(v); setPage(1); }} options={ARCHIVED_OPTIONS} />
        {hasFilters && (
          <Button size="md" variant="ghost" icon={<X size={13} strokeWidth={1.75} />} onClick={reset}>Reset</Button>
        )}
      </div>

      <QueryError query={tasksQuery} what="tasks" />

      <DataTable
        layout="design"
        stickyFirstColumn
        rowKey="taskId"
        columns={columns}
        data={items}
        loading={isLoading}
        emptyTitle="No tasks match your filters"
        emptyBody="Try clearing filters or expanding the date range."
        emptyIcon={<Inbox size={20} strokeWidth={1.75} />}
        emptyAction={<Button variant="default" size="md" onClick={reset}>Clear all filters</Button>}
        total={total}
        page={page}
        pageSize={pageSize}
        onPageChange={p => setPage(p)}
        onPageSizeChange={n => { setPageSize(n); setPage(1); }}
        pageSizeOptions={[10, 25, 50, 100]}
        onRowClick={(r) => setSelectedTask(r)}
        initialSort={{ key: 'updated_date', dir: 'desc' }}
        hiddenColumns={hiddenCols}
        onHiddenColumnsChange={setHiddenCols}
      />

      <TaskDetailDrawer task={selectedTask} onClose={() => setSelectedTask(null)} />
    </div>
  );
}
