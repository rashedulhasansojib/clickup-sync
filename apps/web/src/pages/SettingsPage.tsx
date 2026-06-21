import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Info,
  Lock,
  Plus,
  Star,
  Trash2,
  Webhook,
} from 'lucide-react';
import { useTagAssignee, useCreateTagAssignee, useUpdateTagAssignee, useDeleteTagAssignee } from '../hooks/useTagAssignee';
import { useSettings, useUpdateSettings } from '../hooks/useSettings';
import { useReconcileTasks, useReconcileActive } from '../hooks/useAdmin';
import { useActiveWorkspace } from '../hooks/useActiveWorkspace';
import { useAuth } from '../hooks/useAuth';
import { RequireRole } from '../components/RequireRole';
import type { SettingsPatch } from '../api/settings';
import {
  workspacesApi,
  type MaskedWorkspace,
  type WorkspaceSpace,
} from '../api/workspaces';
import type { TagAssignee } from '../api/tag-assignee';
import { PageHeader } from '../components/ui/PageHeader';
import { Tabs } from '../components/ui/Tabs';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Switch } from '../components/ui/Switch';
import { Pill } from '../components/ui/Pill';
import { Callout } from '../components/ui/Callout';
import { useToast, type ToastApi } from '../components/ui/Toast';
import { EmptyState } from '../components/ui/EmptyState';
import { Field } from '../components/ui/Field';
import { Select } from '../components/ui/Select';

const ALL_TAB_ITEMS = [
  { value: 'workspaces', label: 'Workspaces', ownerOnly: false },
  { value: 'sync', label: 'Sync rules', ownerOnly: false },
  { value: 'notifications', label: 'Notifications', ownerOnly: false },
];

// ClickUp task-scoped webhook event types. Stored as a comma-separated string;
// the UI below is a grouped checkbox list. "handled" events are processed by the
// backend (clickup-event.processor.ts) — some with dedicated logic, the rest
// captured as task-event history and/or a task re-sync. "unimplemented" events
// have no handler yet, so they're shown disabled (greyed out) and can't be
// selected. Non-task events (list/space/folder/goal) are omitted — they carry
// no taskId and the worker discards them.
type WebhookEventGroup = 'handled' | 'unimplemented';
const WEBHOOK_EVENT_OPTIONS: { value: string; label: string; desc: string; group: WebhookEventGroup }[] = [
  { value: 'taskCreated', label: 'Task created', desc: 'New tasks appear in reporting.', group: 'handled' },
  { value: 'taskUpdated', label: 'Task updated', desc: 'Field changes re-sync the task.', group: 'handled' },
  { value: 'taskDeleted', label: 'Task deleted', desc: 'Soft-deletes the task in reporting.', group: 'handled' },
  { value: 'taskTimeTrackedUpdated', label: 'Time tracked', desc: 'Tracked-time entries and costs.', group: 'handled' },
  { value: 'taskStatusUpdated', label: 'Status changed', desc: 'Powers cycle-time & status history.', group: 'handled' },
  { value: 'taskMoved', label: 'Task moved', desc: 'Records move history + re-syncs the task.', group: 'handled' },
  { value: 'taskAssigneeUpdated', label: 'Assignee changed', desc: 'Records assignee history + re-syncs the task.', group: 'handled' },
  { value: 'taskPriorityUpdated', label: 'Priority changed', desc: 'Records priority history + re-syncs the task.', group: 'handled' },
  { value: 'taskCommentPosted', label: 'Comment posted', desc: 'No handler yet.', group: 'unimplemented' },
  { value: 'taskCommentUpdated', label: 'Comment updated', desc: 'No handler yet.', group: 'unimplemented' },
  { value: 'taskTagUpdated', label: 'Tags changed', desc: 'No handler yet.', group: 'unimplemented' },
  { value: 'taskDueDateUpdated', label: 'Due date changed', desc: 'No handler yet.', group: 'unimplemented' },
  { value: 'taskTimeEstimateUpdated', label: 'Estimate changed', desc: 'No handler yet.', group: 'unimplemented' },
];

const WEBHOOK_EVENT_GROUPS: { group: WebhookEventGroup; label: string; disabled?: boolean }[] = [
  { group: 'handled', label: 'Available' },
  { group: 'unimplemented', label: 'Not yet implemented', disabled: true },
];

const KNOWN_EVENT_VALUES = WEBHOOK_EVENT_OPTIONS.map((o) => o.value);

/** Checkbox list for the webhook event subscription. Keeps the value a
 * comma-separated string (known events in canonical order, then any custom
 * ones already stored so they aren't silently dropped). */
function WebhookEventsField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const selected = new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
  const extras = [...selected].filter((v) => !KNOWN_EVENT_VALUES.includes(v));

  function emit(next: Set<string>) {
    const known = KNOWN_EVENT_VALUES.filter((v) => next.has(v));
    const stillExtra = [...next].filter((v) => !KNOWN_EVENT_VALUES.includes(v));
    onChange([...known, ...stillExtra].join(','));
  }

  function toggle(ev: string) {
    const next = new Set(selected);
    if (next.has(ev)) next.delete(ev);
    else next.add(ev);
    emit(next);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {WEBHOOK_EVENT_GROUPS.map(({ group, label, disabled }) => (
        <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-muted)',
            }}
          >
            {label}
          </span>
          {WEBHOOK_EVENT_OPTIONS.filter((o) => o.group === group).map((o) => {
            const checked = selected.has(o.value);
            return (
              <label
                key={o.value}
                title={disabled ? 'Not implemented yet — no backend handler.' : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '8px 10px',
                  border: `1px solid ${checked && !disabled ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 8,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  background: checked && !disabled ? 'var(--accent-soft)' : 'var(--surface)',
                  opacity: disabled ? 0.5 : 1,
                  transition: 'border-color 100ms, background 100ms',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => !disabled && toggle(o.value)}
                  style={{
                    marginTop: 1,
                    width: 15,
                    height: 15,
                    accentColor: 'var(--accent)',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    flexShrink: 0,
                  }}
                />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                    {o.label}{' '}
                    <code style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-muted)' }}>{o.value}</code>
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{o.desc}</span>
                </span>
              </label>
            );
          })}
        </div>
      ))}
      {extras.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)' }}>
          <span>Also subscribed:</span>
          {extras.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => toggle(e)}
              title="Remove this custom event"
              className="btn-3d"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 7px',
                fontSize: 11,
                fontFamily: 'inherit',
                color: 'var(--text)',
                background: 'var(--muted-bg)',
                border: '1px solid var(--border)',
                borderRadius: 999,
                cursor: 'pointer',
                ['--b-edge' as string]: 'var(--border-strong)',
                ['--b-glow' as string]: 'var(--btn-neutral-glow)',
                ['--b-glow-strong' as string]: 'var(--btn-neutral-glow-strong)',
              }}
            >
              {e} ×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em' }}>{title}</div>
      {subtitle != null && subtitle !== '' && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.5 }}>{subtitle}</div>
      )}
    </div>
  );
}

/** Card header with a hairline divider so the title reads as a real section
 *  head instead of floating text. `action` sits flush-right (status pill, etc). */
function CardHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        paddingBottom: 14,
        marginBottom: 16,
        borderBottom: '1px solid var(--border-soft)',
      }}
    >
      <SectionTitle title={title} subtitle={subtitle} />
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  );
}

function SettingRow({ label, desc, control }: { label: string; desc?: string; control: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '10px 0',
        borderBottom: '1px solid var(--border-soft)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{desc}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{control}</div>
    </div>
  );
}

interface TagFormState {
  tagName: string;
  clickupUserId: string;
  clickupUserName: string;
  clickupEmail: string;
  active: boolean;
}

const emptyForm: TagFormState = {
  tagName: '',
  clickupUserId: '',
  clickupUserName: '',
  clickupEmail: '',
  active: true,
};

// ---------------------------------------------------------------------------
// Workspaces management
// ---------------------------------------------------------------------------

/** Token status label for a workspace, covering the shared-token branch. */
function tokenLabel(ws: MaskedWorkspace): { text: string; tone: 'green' | 'blue' | 'gray' } {
  if (ws.apiTokenSet) return { text: `Token ••${ws.apiTokenLast4 ?? ''}`, tone: 'green' };
  if (ws.usesSharedToken) return { text: 'Shared token', tone: 'blue' };
  return { text: 'No token', tone: 'gray' };
}

interface CreateWsForm {
  name: string;
  teamId: string;
  apiToken: string;
  webhookEndpoint: string;
  webhookEvents: string;
}

const emptyCreateWs: CreateWsForm = {
  name: '',
  teamId: '',
  apiToken: '',
  webhookEndpoint: '',
  webhookEvents: 'taskCreated,taskUpdated,taskDeleted,taskTimeTrackedUpdated',
};

interface EditWsForm {
  name: string;
  teamId: string;
  apiToken: string;
  webhookEndpoint: string;
  webhookEvents: string;
  spikeHoursCap: string;
  status: 'ACTIVE' | 'DISABLED';
  reconcileLookbackDays: string;
  realtimeWebhooks: boolean;
  backfillOnConnect: boolean;
  maxBackfillLookbackDays: string;
}

function editFormFromWs(ws: MaskedWorkspace): EditWsForm {
  return {
    name: ws.name,
    teamId: ws.teamId,
    apiToken: '',
    webhookEndpoint: ws.webhookEndpoint ?? '',
    webhookEvents: ws.webhookEvents,
    spikeHoursCap: String(ws.spikeHoursCap),
    status: ws.status,
    reconcileLookbackDays: String(ws.sync.reconcileLookbackDays),
    realtimeWebhooks: ws.sync.realtimeWebhooks,
    backfillOnConnect: ws.sync.backfillOnConnect,
    maxBackfillLookbackDays: String(ws.sync.maxBackfillLookbackDays),
  };
}

interface SpaceForm {
  spaceId: string;
  name: string;
  backfillLookbackDays: string;
  enabled: boolean;
}

const emptySpaceForm: SpaceForm = { spaceId: '', name: '', backfillLookbackDays: '30', enabled: true };

function WorkspacesSection({ toast, isOwner }: { toast: ToastApi; isOwner: boolean }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['admin-workspaces'],
    queryFn: workspacesApi.listAdmin,
  });
  const encryptionEnabled = query.data?.encryptionEnabled ?? false;
  const workspaces = query.data?.workspaces ?? [];

  // Both the management list and the top-bar switcher depend on workspace data.
  function invalidateWorkspaceViews() {
    void qc.invalidateQueries({ queryKey: ['admin-workspaces'] });
    void qc.invalidateQueries({ queryKey: ['workspaces'] });
  }

  const createMutation = useMutation({
    mutationFn: workspacesApi.create,
    onSuccess: () => invalidateWorkspaceViews(),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof workspacesApi.update>[1] }) =>
      workspacesApi.update(id, input),
    onSuccess: () => invalidateWorkspaceViews(),
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => workspacesApi.remove(id),
    onSuccess: () => invalidateWorkspaceViews(),
  });
  const registerMutation = useMutation({
    mutationFn: (id: string) => workspacesApi.registerWebhook(id),
    onSuccess: () => invalidateWorkspaceViews(),
  });
  const upsertSpaceMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof workspacesApi.upsertSpace>[1] }) =>
      workspacesApi.upsertSpace(id, input),
    onSuccess: () => invalidateWorkspaceViews(),
  });
  const deleteSpaceMutation = useMutation({
    mutationFn: ({ id, spaceId }: { id: string; spaceId: string }) => workspacesApi.deleteSpace(id, spaceId),
    onSuccess: () => invalidateWorkspaceViews(),
  });

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<CreateWsForm>(emptyCreateWs);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditWsForm | null>(null);

  function err(e: unknown): string {
    return (e as Error)?.message ?? 'Unknown error';
  }

  function submitAdd() {
    if (!addForm.name.trim() || !addForm.teamId.trim()) {
      toast.error('Name and team ID are required.');
      return;
    }
    createMutation.mutate(
      {
        name: addForm.name.trim(),
        teamId: addForm.teamId.trim(),
        apiToken: addForm.apiToken.trim() || undefined,
        webhookEndpoint: addForm.webhookEndpoint.trim() || undefined,
        webhookEvents: addForm.webhookEvents.trim() || undefined,
      },
      {
        onSuccess: (ws) => {
          toast.success(`Workspace “${ws.name}” created.`);
          setShowAdd(false);
          setAddForm(emptyCreateWs);
        },
        onError: (e) => toast.error(`Create failed: ${err(e)}`),
      },
    );
  }

  function startEdit(ws: MaskedWorkspace) {
    setEditingId(ws.id);
    setEditForm(editFormFromWs(ws));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
  }

  function submitEdit(id: string) {
    if (!editForm) return;
    if (!editForm.name.trim() || !editForm.teamId.trim()) {
      toast.error('Name and team ID are required.');
      return;
    }
    const cap = Math.round(Number(editForm.spikeHoursCap));
    if (!Number.isFinite(cap) || cap < 1 || cap > 24) {
      toast.error('Spike cap must be a whole number between 1 and 24.');
      return;
    }
    const reconcile = Math.round(Number(editForm.reconcileLookbackDays));
    const maxBackfill = Math.round(Number(editForm.maxBackfillLookbackDays));
    if (!Number.isFinite(reconcile) || reconcile < 1) {
      toast.error('Reconcile lookback must be at least 1 day.');
      return;
    }
    if (!Number.isFinite(maxBackfill) || maxBackfill < 1 || maxBackfill > 3650) {
      toast.error('Backfill maximum lookback must be between 1 and 3650 days.');
      return;
    }
    updateMutation.mutate(
      {
        id,
        input: {
          name: editForm.name.trim(),
          teamId: editForm.teamId.trim(),
          apiToken: editForm.apiToken.trim() || undefined,
          webhookEndpoint: editForm.webhookEndpoint.trim() || undefined,
          webhookEvents: editForm.webhookEvents,
          spikeHoursCap: cap,
          status: editForm.status,
          sync: {
            reconcileLookbackDays: reconcile,
            realtimeWebhooks: editForm.realtimeWebhooks,
            backfillOnConnect: editForm.backfillOnConnect,
            maxBackfillLookbackDays: maxBackfill,
          },
        },
      },
      {
        onSuccess: () => {
          toast.success('Workspace updated.');
          cancelEdit();
        },
        onError: (e) => toast.error(`Update failed: ${err(e)}`),
      },
    );
  }

  function doRemove(ws: MaskedWorkspace) {
    if (ws.isDefault) {
      toast.error('The default workspace cannot be deleted.');
      return;
    }
    if (!window.confirm(`Delete workspace “${ws.name}”? This is rejected if it still has synced data.`)) return;
    removeMutation.mutate(ws.id, {
      onSuccess: () => toast.success(`Workspace “${ws.name}” deleted.`),
      onError: (e) => toast.error(`Delete failed: ${err(e)}`),
    });
  }

  function doRegister(ws: MaskedWorkspace) {
    registerMutation.mutate(ws.id, {
      onSuccess: (res) => {
        const data = res as { webhookId?: string; action?: string; secretStored?: boolean };
        const id = data.webhookId ?? '—';
        if (data.action === 'existing') {
          toast.info(`Webhook already active for “${ws.name}” (id ${id}).`);
        } else if (data.secretStored === false) {
          toast.error(`Webhook registered (id ${id}) but the signing secret could NOT be stored — set APP_ENCRYPTION_KEY.`);
        } else {
          toast.success(`Webhook registered for “${ws.name}” (id ${id}). Signing secret stored.`);
        }
      },
      onError: (e) => toast.error(`Webhook registration failed: ${err(e)}`),
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {!encryptionEnabled && (
        <Callout tone="amber" icon={<AlertTriangle size={13} />}>
          Secret storage is disabled — <code style={{ fontFamily: 'ui-monospace, monospace' }}>APP_ENCRYPTION_KEY</code> isn't set on
          the server. You can edit workspace names, team IDs and webhook URLs, but per-workspace API tokens and signing secrets can't be
          saved until that key is configured (64 hex chars) and the backend restarts.
        </Callout>
      )}

      <Card>
        <CardHeader
          title="Connected workspaces"
          subtitle="Each workspace is an isolated ClickUp connection — its own token, team, webhook and synced spaces."
          action={
            isOwner ? (
              <Button variant="accent" size="sm" icon={<Plus size={13} />} onClick={() => setShowAdd((s) => !s)}>
                Add workspace
              </Button>
            ) : undefined
          }
        />

        {showAdd && (
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 14,
              marginBottom: 14,
              background: 'var(--muted-bg)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              maxWidth: 620,
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Name">
                <Input
                  value={addForm.name}
                  onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Acme Workspace"
                />
              </Field>
              <Field label="Team / Workspace ID">
                <Input
                  value={addForm.teamId}
                  onChange={(e) => setAddForm((f) => ({ ...f, teamId: e.target.value }))}
                  placeholder="3450636"
                />
              </Field>
            </div>
            <Field
              label="API token"
              hint={
                encryptionEnabled
                  ? 'Leave blank to use the shared token (CLICKUP_API_TOKEN).'
                  : 'Token storage disabled — leave blank; the shared token will be used.'
              }
            >
              <Input
                value={addForm.apiToken}
                type="password"
                icon={<Lock size={14} />}
                disabled={!encryptionEnabled}
                placeholder={encryptionEnabled ? 'pk_… (optional)' : 'APP_ENCRYPTION_KEY not set'}
                onChange={(e) => setAddForm((f) => ({ ...f, apiToken: e.target.value }))}
              />
            </Field>
            <Field label="Webhook endpoint" hint="Optional. Public HTTPS URL ClickUp posts events to.">
              <Input
                value={addForm.webhookEndpoint}
                onChange={(e) => setAddForm((f) => ({ ...f, webhookEndpoint: e.target.value }))}
                placeholder="https://your-domain.com/api/webhooks/clickup"
              />
            </Field>
            <Field label="Subscribed events">
              <WebhookEventsField
                value={addForm.webhookEvents}
                onChange={(v) => setAddForm((f) => ({ ...f, webhookEvents: v }))}
              />
            </Field>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="accent" size="sm" loading={createMutation.isPending} onClick={submitAdd}>
                Create workspace
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setShowAdd(false); setAddForm(emptyCreateWs); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {query.isLoading ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</p>
        ) : workspaces.length === 0 ? (
          <EmptyState title="No workspaces" body="Add a workspace to connect a ClickUp team." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {workspaces.map((ws) => {
              const tok = tokenLabel(ws);
              const isEditing = editingId === ws.id;
              return (
                <div
                  key={ws.id}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: 14,
                    background: 'var(--surface)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  {/* Header row: name + badges + actions */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{ws.name}</span>
                        {ws.isDefault && (
                          <Pill tone="purple" icon={<Star size={10} />}>Default</Pill>
                        )}
                        <Pill tone={ws.status === 'ACTIVE' ? 'green' : 'gray'}>{ws.status}</Pill>
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--text-muted)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          marginTop: 4,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontFamily: 'ui-monospace, monospace' }}>team_id: {ws.teamId}</span>
                        <span>·</span>
                        <Pill tone={tok.tone}>{tok.text}</Pill>
                        <span>·</span>
                        <Pill tone={ws.webhookSecretSet ? 'green' : 'gray'} icon={<Webhook size={10} />}>
                          {ws.webhookId ? `webhook ${ws.webhookId}` : ws.webhookSecretSet ? 'secret set' : 'no webhook'}
                        </Pill>
                      </div>
                    </div>
                    {isOwner && (
                      <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
                        <Button
                          size="sm"
                          variant="default"
                          icon={<Webhook size={13} />}
                          loading={registerMutation.isPending && registerMutation.variables === ws.id}
                          onClick={() => doRegister(ws)}
                        >
                          Register webhook
                        </Button>
                        {isEditing ? (
                          <Button size="sm" variant="ghost" onClick={cancelEdit}>Close</Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => startEdit(ws)}>Edit</Button>
                        )}
                        <Button
                          size="sm"
                          variant="danger"
                          icon={<Trash2 size={13} />}
                          disabled={ws.isDefault}
                          loading={removeMutation.isPending && removeMutation.variables === ws.id}
                          onClick={() => doRemove(ws)}
                        >
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Edit form */}
                  {isEditing && editForm && (
                    <div
                      style={{
                        borderTop: '1px solid var(--border-soft)',
                        paddingTop: 12,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                    >
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <Field label="Name">
                          <Input value={editForm.name} onChange={(e) => setEditForm((f) => f && { ...f, name: e.target.value })} />
                        </Field>
                        <Field label="Team / Workspace ID">
                          <Input value={editForm.teamId} onChange={(e) => setEditForm((f) => f && { ...f, teamId: e.target.value })} />
                        </Field>
                      </div>
                      <Field
                        label="API token"
                        hint={
                          encryptionEnabled
                            ? ws.apiTokenSet
                              ? `A token is set (ending ••${ws.apiTokenLast4 ?? ''}). Enter a new value to replace it; blank keeps it.`
                              : 'No token set — blank uses the shared token. Enter a pk_… token to override.'
                            : 'Token storage disabled — set APP_ENCRYPTION_KEY to edit.'
                        }
                      >
                        <Input
                          value={editForm.apiToken}
                          type="password"
                          icon={<Lock size={14} />}
                          disabled={!encryptionEnabled}
                          placeholder={ws.apiTokenSet ? '•••• leave blank to keep current' : 'pk_… (optional)'}
                          onChange={(e) => setEditForm((f) => f && { ...f, apiToken: e.target.value })}
                        />
                      </Field>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <Field label="Status">
                          <Select
                            fullWidth
                            value={editForm.status}
                            onChange={(v) => setEditForm((f) => f && { ...f, status: v as 'ACTIVE' | 'DISABLED' })}
                            options={[
                              { value: 'ACTIVE', label: 'Active' },
                              { value: 'DISABLED', label: 'Disabled' },
                            ]}
                          />
                        </Field>
                        <Field label="Daily-hour spike cap" hint="1–24 hours.">
                          <Input
                            type="number"
                            min={1}
                            max={24}
                            value={editForm.spikeHoursCap}
                            onChange={(e) => setEditForm((f) => f && { ...f, spikeHoursCap: e.target.value })}
                          />
                        </Field>
                      </div>
                      <Field label="Webhook endpoint">
                        <Input
                          value={editForm.webhookEndpoint}
                          onChange={(e) => setEditForm((f) => f && { ...f, webhookEndpoint: e.target.value })}
                          placeholder="https://your-domain.com/api/webhooks/clickup"
                        />
                      </Field>
                      <Field label="Subscribed events" hint="Re-register the webhook after changing.">
                        <WebhookEventsField
                          value={editForm.webhookEvents}
                          onChange={(v) => setEditForm((f) => f && { ...f, webhookEvents: v })}
                        />
                      </Field>

                      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginTop: 4 }}>
                        Sync rules
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <Field label="Reconcile lookback (days)">
                          <Input
                            type="number"
                            min={1}
                            value={editForm.reconcileLookbackDays}
                            onChange={(e) => setEditForm((f) => f && { ...f, reconcileLookbackDays: e.target.value })}
                          />
                        </Field>
                        <Field label="Backfill maximum lookback (days)" hint="1–3650.">
                          <Input
                            type="number"
                            min={1}
                            max={3650}
                            value={editForm.maxBackfillLookbackDays}
                            onChange={(e) => setEditForm((f) => f && { ...f, maxBackfillLookbackDays: e.target.value })}
                          />
                        </Field>
                      </div>
                      <SettingRow
                        label="Real-time webhooks"
                        desc="When off, incoming ClickUp webhooks are acknowledged but not processed — the hourly reconcile catches up."
                        control={
                          <Switch
                            checked={editForm.realtimeWebhooks}
                            onChange={(v) => setEditForm((f) => f && { ...f, realtimeWebhooks: v })}
                          />
                        }
                      />
                      <SettingRow
                        label="Backfill on connect"
                        desc="When on, registering the webhook also backfills enabled spaces."
                        control={
                          <Switch
                            checked={editForm.backfillOnConnect}
                            onChange={(v) => setEditForm((f) => f && { ...f, backfillOnConnect: v })}
                          />
                        }
                      />

                      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                        <Button variant="accent" size="sm" loading={updateMutation.isPending} onClick={() => submitEdit(ws.id)}>
                          Save changes
                        </Button>
                        <Button variant="ghost" size="sm" onClick={cancelEdit}>Cancel</Button>
                      </div>
                    </div>
                  )}

                  {/* Spaces sub-section */}
                  <WorkspaceSpaces
                    ws={ws}
                    isOwner={isOwner}
                    toast={toast}
                    onUpsert={(input) =>
                      upsertSpaceMutation.mutateAsync({ id: ws.id, input })}
                    onDelete={(spaceId) =>
                      deleteSpaceMutation.mutateAsync({ id: ws.id, spaceId })}
                  />
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function WorkspaceSpaces({
  ws,
  isOwner,
  toast,
  onUpsert,
  onDelete,
}: {
  ws: MaskedWorkspace;
  isOwner: boolean;
  toast: ToastApi;
  onUpsert: (input: { spaceId: string; name: string; backfillLookbackDays?: number; enabled?: boolean }) => Promise<unknown>;
  onDelete: (spaceId: string) => Promise<unknown>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingSpaceId, setEditingSpaceId] = useState<string | null>(null);
  const [form, setForm] = useState<SpaceForm>(emptySpaceForm);
  const [busy, setBusy] = useState(false);
  // "Discover from ClickUp" picker state.
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<{ id: string; name: string; configured: boolean }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  function err(e: unknown): string {
    return (e as Error)?.message ?? 'Unknown error';
  }

  async function discover() {
    setDiscovering(true);
    try {
      const spaces = await workspacesApi.listClickupSpaces(ws.id);
      setDiscovered(spaces);
      // Pre-select everything not already configured.
      setPicked(new Set(spaces.filter((s) => !s.configured).map((s) => s.id)));
      if (spaces.length === 0) toast.error('ClickUp returned no spaces for this workspace (check the token has access).');
    } catch (e) {
      toast.error(`Could not fetch spaces: ${err(e)}`);
    } finally {
      setDiscovering(false);
    }
  }

  async function addPicked() {
    const toAdd = (discovered ?? []).filter((s) => picked.has(s.id) && !s.configured);
    if (toAdd.length === 0) { setDiscovered(null); return; }
    setBusy(true);
    try {
      // Sequential so a mid-batch failure leaves a clear partial state.
      for (const s of toAdd) {
        await onUpsert({ spaceId: s.id, name: s.name, backfillLookbackDays: 30, enabled: true });
      }
      toast.success(`Added ${toAdd.length} space${toAdd.length === 1 ? '' : 's'}.`);
      setDiscovered(null);
    } catch (e) {
      toast.error(`Add failed: ${err(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function startAdd() {
    setEditingSpaceId(null);
    setForm(emptySpaceForm);
    setShowForm(true);
  }

  function startEdit(s: WorkspaceSpace) {
    setEditingSpaceId(s.spaceId);
    setForm({
      spaceId: s.spaceId,
      name: s.name,
      backfillLookbackDays: String(s.backfillLookbackDays),
      enabled: s.enabled,
    });
    setShowForm(true);
  }

  function cancel() {
    setShowForm(false);
    setEditingSpaceId(null);
    setForm(emptySpaceForm);
  }

  async function save() {
    if (!form.spaceId.trim() || !form.name.trim()) {
      toast.error('Space ID and name are required.');
      return;
    }
    const days = Math.round(Number(form.backfillLookbackDays));
    if (!Number.isFinite(days) || days < 1) {
      toast.error('Backfill lookback must be at least 1 day.');
      return;
    }
    setBusy(true);
    try {
      await onUpsert({
        spaceId: form.spaceId.trim(),
        name: form.name.trim(),
        backfillLookbackDays: days,
        enabled: form.enabled,
      });
      toast.success(editingSpaceId ? 'Space updated.' : 'Space added.');
      cancel();
    } catch (e) {
      toast.error(`Save failed: ${err(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: WorkspaceSpace) {
    if (!window.confirm(`Remove space “${s.name}” from this workspace?`)) return;
    setBusy(true);
    try {
      await onDelete(s.spaceId);
      toast.success('Space removed.');
    } catch (e) {
      toast.error(`Remove failed: ${err(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
          Synced spaces{' '}
          <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({ws.spaces.length})</span>
        </span>
        {isOwner && (
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" variant="ghost" loading={discovering} onClick={discover}>
              Discover from ClickUp
            </Button>
            <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={startAdd}>
              Add manually
            </Button>
          </div>
        )}
      </div>

      {discovered && (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 10,
            background: 'var(--muted-bg)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
            Spaces in ClickUp ({discovered.length}) — pick the ones to sync
          </div>
          {discovered.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No spaces found.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflowY: 'auto' }}>
              {discovered.map((s) => (
                <label
                  key={s.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
                    color: s.configured ? 'var(--text-muted)' : 'var(--text)',
                    cursor: s.configured ? 'default' : 'pointer', padding: '4px 2px',
                  }}
                >
                  <input
                    type="checkbox"
                    disabled={s.configured}
                    checked={s.configured || picked.has(s.id)}
                    onChange={(e) =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(s.id); else next.delete(s.id);
                        return next;
                      })
                    }
                  />
                  <span style={{ flex: 1 }}>{s.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>
                    {s.id}{s.configured ? ' · already added' : ''}
                  </span>
                </label>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="accent" size="sm" loading={busy} onClick={addPicked}>
              Add selected
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDiscovered(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {showForm && (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 10,
            background: 'var(--muted-bg)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <Field label="Space ID">
              <Input
                value={form.spaceId}
                disabled={!!editingSpaceId}
                onChange={(e) => setForm((f) => ({ ...f, spaceId: e.target.value }))}
                placeholder="3577824"
              />
            </Field>
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Digital Marketing"
              />
            </Field>
            <Field label="Backfill lookback (days)">
              <Input
                type="number"
                min={1}
                value={form.backfillLookbackDays}
                onChange={(e) => setForm((f) => ({ ...f, backfillLookbackDays: e.target.value }))}
              />
            </Field>
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <Switch ariaLabel="Space enabled" checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
            Scheduled sync enabled
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="accent" size="sm" loading={busy} onClick={save}>Save</Button>
            <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
          </div>
        </div>
      )}

      {ws.spaces.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No spaces configured for this workspace.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ws.spaces.map((s) => (
            <div
              key={s.spaceId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                borderRadius: 8,
                background: 'var(--muted-bg)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{s.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>
                  {s.spaceId} · {s.backfillLookbackDays}d backfill{s.enabled ? '' : ' · scheduled sync paused'}
                </div>
              </div>
              {isOwner && (
                <>
                  <Switch
                    ariaLabel={`Scheduled sync for ${s.name}`}
                    checked={s.enabled}
                    disabled={busy}
                    onChange={(v) => {
                      setBusy(true);
                      void onUpsert({ spaceId: s.spaceId, name: s.name, backfillLookbackDays: s.backfillLookbackDays, enabled: v })
                        .catch((e) => toast.error(`Update failed: ${err(e)}`))
                        .finally(() => setBusy(false));
                    }}
                  />
                  <Button size="sm" variant="ghost" onClick={() => startEdit(s)}>Edit</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => remove(s)} />
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { hasRole } = useAuth();
  const [activeTab, setActiveTab] = useState('workspaces');
  const tagAssignee = useTagAssignee();
  const createTagAssignee = useCreateTagAssignee();
  const updateTagAssignee = useUpdateTagAssignee();
  const deleteTagAssignee = useDeleteTagAssignee();
  const settingsQuery = useSettings();
  const updateSettings = useUpdateSettings();
  const toast = useToast();
  // Full reconciliation runs against the ACTIVE workspace (the axios interceptor
  // attaches its id); progress is likewise per-workspace.
  const reconcileTasks = useReconcileTasks();
  const reconcileProgress = useReconcileActive(hasRole('ADMIN'));
  const { active: activeWorkspace } = useActiveWorkspace();
  const [reconcileDays, setReconcileDays] = useState('365');

  // Connection/save results surface as toasts (top-right, auto-dismiss).
  function showBanner(text: string, tone: 'blue' | 'red' = 'blue') {
    toast.show(text, tone);
  }

  const prefs = settingsQuery.data?.preferences;
  const isOwner = hasRole('OWNER');

  function patchPrefs(patch: SettingsPatch['preferences']) {
    updateSettings.mutate(
      { preferences: patch },
      { onError: (err) => showBanner(`Save failed: ${(err as Error).message}`, 'red') },
    );
  }

  const [showTagForm, setShowTagForm] = useState(false);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [tagForm, setTagForm] = useState<TagFormState>(emptyForm);

  const [defaultCurrency, setDefaultCurrency] = useState('USD');

  const tagItems: TagAssignee[] = tagAssignee.data ?? [];

  function startAddTag() {
    setEditingTagId(null);
    setTagForm(emptyForm);
    setShowTagForm(true);
  }

  function startEditTag(row: TagAssignee) {
    setEditingTagId(row.id);
    setTagForm({
      tagName: row.tagName,
      clickupUserId: row.clickupUserId,
      clickupUserName: row.clickupUserName ?? '',
      clickupEmail: row.clickupEmail ?? '',
      active: row.active,
    });
    setShowTagForm(true);
  }

  function cancelTagForm() {
    setShowTagForm(false);
    setEditingTagId(null);
    setTagForm(emptyForm);
  }

  function saveTagForm() {
    const payload = {
      tagName: tagForm.tagName,
      clickupUserId: tagForm.clickupUserId,
      clickupUserName: tagForm.clickupUserName || null,
      clickupEmail: tagForm.clickupEmail || null,
      active: tagForm.active,
    };
    if (editingTagId) {
      updateTagAssignee.mutate({ id: editingTagId, data: payload }, { onSuccess: () => cancelTagForm() });
    } else {
      createTagAssignee.mutate(payload, { onSuccess: () => cancelTagForm() });
    }
  }

  function deleteTag(id: string) {
    if (!window.confirm('Delete this tag-assignee mapping?')) return;
    deleteTagAssignee.mutate(id);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PageHeader
        title="Settings"
        description="ClickUp workspace connections, sync configuration, and access controls."
      />
      <Tabs
        items={ALL_TAB_ITEMS.filter((t) => !t.ownerOnly || hasRole('OWNER')).map((t) => ({ value: t.value, label: t.label }))}
        value={activeTab}
        onChange={setActiveTab}
        variant="segmented"
      />

      {activeTab === 'workspaces' && (
        <RequireRole min="ADMIN">
          <WorkspacesSection toast={toast} isOwner={isOwner} />
        </RequireRole>
      )}

      {activeTab === 'sync' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Callout tone="amber" icon={<Info size={13} />}>
            These are app-wide cost and failure rules. Per-connection sync schedule, spaces and the
            spike cap now live on each <strong>Workspace</strong>. Changing{' '}
            <strong>Rate matching</strong> or <strong>Treat non-billable as zero</strong>{' '}
            applies to new entries immediately; run <strong>Recalculate costs</strong>{' '}
            (Assignee Rates) to apply it to existing ones.
          </Callout>

          <Card>
            <CardHeader title="Cost calculation" subtitle="How labor cost is computed from time entries." />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <SettingRow
                label="Default currency"
                desc="Per-row currency comes from ClickUp — workspace-wide override isn't implemented yet."
                control={
                  <Select
                    size="sm"
                    value={defaultCurrency}
                    onChange={setDefaultCurrency}
                    disabled
                    options={[
                      { value: 'USD', label: 'USD ($)' },
                      { value: 'EUR', label: 'EUR (€)' },
                      { value: 'GBP', label: 'GBP (£)' },
                    ]}
                  />
                }
              />
              <SettingRow
                label="Rate matching"
                desc="Which date selects the effective rate: the entry's start time, or the task's due date (falls back to start when no due date). Recalculate to apply to existing entries."
                control={
                  <Select
                    size="sm"
                    value={prefs?.cost.rateMatching ?? 'start'}
                    disabled={!isOwner || updateSettings.isPending}
                    onChange={(v) => patchPrefs({ cost: { rateMatching: v as 'start' | 'due' } })}
                    options={[
                      { value: 'start', label: 'Start date' },
                      { value: 'due', label: 'Task due date' },
                    ]}
                  />
                }
              />
              <SettingRow
                label="Auto-recalculate on rate change"
                desc="Active — editing a rate enqueues a maintenance recalc job."
                control={
                  <Switch
                    checked={prefs?.cost.autoRecalcOnRateChange ?? true}
                    disabled={!isOwner || updateSettings.isPending}
                    onChange={(v) => patchPrefs({ cost: { autoRecalcOnRateChange: v } })}
                  />
                }
              />
              <SettingRow
                label="Treat non-billable as zero cost"
                desc="When on, non-billable time entries are costed at 0. Recalculate to apply to existing entries."
                control={
                  <Switch
                    checked={prefs?.cost.nonBillableZero ?? false}
                    disabled={!isOwner || updateSettings.isPending}
                    onChange={(v) => patchPrefs({ cost: { nonBillableZero: v } })}
                  />
                }
              />
            </div>
          </Card>

          <Card>
            <CardHeader title="Failure handling" subtitle="What happens when sync jobs error." />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <SettingRow
                label="Webhook retry"
                desc="Number of BullMQ attempts before a failed webhook job moves to dead-letter (exponential backoff)."
                control={
                  <Select
                    size="sm"
                    value={String(prefs?.failure.webhookRetryAttempts ?? 5)}
                    disabled={!isOwner || updateSettings.isPending}
                    onChange={(v) => patchPrefs({ failure: { webhookRetryAttempts: Number(v) } })}
                    options={[
                      { value: '3', label: '3 attempts' },
                      { value: '5', label: '5 attempts' },
                      { value: '10', label: '10 attempts' },
                    ]}
                  />
                }
              />
              <SettingRow
                label="Pause syncing on repeated failure"
                desc="Not implemented — failed jobs go to dead-letter but syncing isn't paused."
                control={<Switch checked={false} disabled onChange={() => undefined} />}
              />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Full reconciliation"
              subtitle={<>Runs against the active workspace{activeWorkspace ? <> — <strong>{activeWorkspace.name}</strong></> : ''}. Switch workspaces in the top bar to reconcile a different one.</>}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <SettingRow
                label="Reconcile now"
                desc="Sweeps every stored task in this workspace: soft-deletes ones removed in ClickUp (and their time entries) and re-syncs the rest's tracked time, so deletions made directly in ClickUp show up here."
                control={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Input
                      type="number"
                      min={1}
                      value={reconcileDays}
                      onChange={(e) => setReconcileDays(e.target.value)}
                      style={{ width: 88 }}
                      aria-label="Reconciliation lookback in days"
                    />
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>days back</span>
                    <Button
                      size="sm"
                      variant="caution"
                      loading={reconcileTasks.isPending}
                      onClick={() => {
                        const days = Number(reconcileDays);
                        if (!Number.isFinite(days) || days < 1) {
                          showBanner('Enter a lookback of at least 1 day.', 'red');
                          return;
                        }
                        reconcileTasks.mutate(days, {
                          onSuccess: (res) => {
                            showBanner(
                              res.alreadyRunning
                                ? 'A reconciliation is already running for this workspace.'
                                : `Reconciliation queued for ${res.queued.toLocaleString()} task${res.queued === 1 ? '' : 's'} (last ${days} days). Deletions will clear as the jobs run.`,
                              'blue',
                            );
                            reconcileProgress.refetch();
                          },
                          onError: (err) => showBanner(`Reconciliation failed to start: ${(err as Error).message}`, 'red'),
                        });
                      }}
                    >
                      Run now
                    </Button>
                  </div>
                }
              />
              {reconcileProgress.data?.active && (
                <div style={{ padding: '4px 0 10px' }}>
                  {(() => {
                    const { done, total } = reconcileProgress.data;
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
                          <span>Reconciling tasks · {done.toLocaleString()} / {total.toLocaleString()}</span>
                          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
                        </div>
                        <div style={{ width: '100%', height: 6, background: 'var(--muted-bg)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 200ms ease-out' }} />
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Tag–assignee map"
              subtitle="Map ClickUp tags to assignees for tracked-time replacement."
              action={
                <Button variant="accent" size="sm" onClick={startAddTag}>
                  Add mapping
                </Button>
              }
            />

            {showTagForm && (
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 14,
                  marginBottom: 14,
                  background: 'var(--muted-bg)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  maxWidth: 620,
                }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <Field label="Tag name">
                    <Input
                      value={tagForm.tagName}
                      onChange={(e) => setTagForm((f) => ({ ...f, tagName: e.target.value }))}
                      placeholder="e.g. rashedul"
                    />
                  </Field>
                  <Field label="User ID">
                    <Input
                      value={tagForm.clickupUserId}
                      onChange={(e) => setTagForm((f) => ({ ...f, clickupUserId: e.target.value }))}
                      placeholder="ClickUp user ID"
                    />
                  </Field>
                  <Field label="User name">
                    <Input
                      value={tagForm.clickupUserName}
                      onChange={(e) => setTagForm((f) => ({ ...f, clickupUserName: e.target.value }))}
                      placeholder="Display name"
                    />
                  </Field>
                  <Field label="Email">
                    <Input
                      value={tagForm.clickupEmail}
                      onChange={(e) => setTagForm((f) => ({ ...f, clickupEmail: e.target.value }))}
                      placeholder="user@example.com"
                    />
                  </Field>
                </div>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 13,
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >
                  <Switch ariaLabel="Tag mapping active" checked={tagForm.active} onChange={(v) => setTagForm((f) => ({ ...f, active: v }))} />
                  Active
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    variant="accent"
                    size="sm"
                    onClick={saveTagForm}
                    loading={createTagAssignee.isPending || updateTagAssignee.isPending}
                  >
                    Save
                  </Button>
                  <Button variant="ghost" size="sm" onClick={cancelTagForm}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {tagAssignee.isLoading ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</p>
            ) : tagItems.length === 0 ? (
              <EmptyState title="No mappings" body="Add tag-to-assignee mappings to enable tracked-time replacement." />
            ) : (
              <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
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
                      <th style={{ textAlign: 'left', padding: '8px 16px' }}>Tag</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px' }}>User ID</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px' }}>Name</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px' }}>Email</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px' }}>Active</th>
                      <th style={{ width: 100, padding: '8px 16px' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {tagItems.map((row, i) => (
                      <tr key={row.id} style={{ borderTop: i > 0 ? '1px solid var(--border-soft)' : undefined }}>
                        <td style={{ padding: '10px 16px' }}>
                          <Pill tone="purple" size="sm">
                            {row.tagName}
                          </Pill>
                        </td>
                        <td style={{ padding: '10px 12px', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                          {row.clickupUserId}
                        </td>
                        <td style={{ padding: '10px 12px' }}>{row.clickupUserName ?? '—'}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--text-muted)' }}>{row.clickupEmail ?? '—'}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <Switch
                            checked={row.active}
                            onChange={(v) => updateTagAssignee.mutate({ id: row.id, data: { active: v } })}
                          />
                        </td>
                        <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                          <Button size="sm" variant="ghost" onClick={() => startEditTag(row)}>
                            Edit
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => deleteTag(row.id)}>
                            Delete
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {activeTab === 'notifications' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Callout tone="amber" icon={<AlertTriangle size={13} />}>
            Preview only — no notifications are actually delivered yet.
            Toggle preferences are persisted, but outbound delivery (email, Slack, PagerDuty) is on the roadmap.
            Operational alerts surface in the <strong> Overview → Alerts</strong> card today.
          </Callout>
          <Card>
            <CardHeader title="Alerts" subtitle="Get notified when sync issues need attention." />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <SettingRow
                label="Sync run failed"
                desc="Notify on any failed sync run."
                control={
                  <Switch
                    ariaLabel="Sync run failed alerts"
                    checked={prefs?.notifications.alerts.syncFail ?? true}
                    disabled={!isOwner || updateSettings.isPending}
                    onChange={(v) => patchPrefs({ notifications: { alerts: { syncFail: v } } })}
                  />
                }
              />
              <SettingRow
                label="Webhook errors spike"
                desc="Alert if more than 25 webhooks fail in 5 min."
                control={
                  <Switch
                    ariaLabel="Webhook error spike alerts"
                    checked={prefs?.notifications.alerts.webhookSpike ?? true}
                    disabled={!isOwner || updateSettings.isPending}
                    onChange={(v) => patchPrefs({ notifications: { alerts: { webhookSpike: v } } })}
                  />
                }
              />
              <SettingRow
                label="Missing rate created"
                desc="Alert when an assignee logs time without a rate."
                control={
                  <Switch
                    ariaLabel="Missing rate alerts"
                    checked={prefs?.notifications.alerts.missingRate ?? true}
                    disabled={!isOwner || updateSettings.isPending}
                    onChange={(v) => patchPrefs({ notifications: { alerts: { missingRate: v } } })}
                  />
                }
              />
              <SettingRow
                label="Token expiring"
                desc="Notify 14 days before ClickUp token expires."
                control={
                  <Switch
                    ariaLabel="Token expiring alerts"
                    checked={prefs?.notifications.alerts.tokenExpiring ?? true}
                    disabled={!isOwner || updateSettings.isPending}
                    onChange={(v) => patchPrefs({ notifications: { alerts: { tokenExpiring: v } } })}
                  />
                }
              />
            </div>
          </Card>

          <Card>
            <CardHeader title="Channels" subtitle="Where alerts are delivered." />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <SettingRow
                label="Email"
                desc="ops-alerts@acme.co"
                control={
                  <Switch
                    ariaLabel="Email channel"
                    checked={prefs?.notifications.channels.email ?? true}
                    disabled={!isOwner || updateSettings.isPending}
                    onChange={(v) => patchPrefs({ notifications: { channels: { email: v } } })}
                  />
                }
              />
              <SettingRow
                label="Slack"
                desc="#data-platform-alerts"
                control={
                  <Switch
                    ariaLabel="Slack channel"
                    checked={prefs?.notifications.channels.slack ?? true}
                    disabled={!isOwner || updateSettings.isPending}
                    onChange={(v) => patchPrefs({ notifications: { channels: { slack: v } } })}
                  />
                }
              />
              <SettingRow
                label="PagerDuty"
                desc="Connect for critical failures"
                control={
                  <Switch
                    ariaLabel="PagerDuty channel"
                    checked={prefs?.notifications.channels.pagerduty ?? false}
                    disabled={!isOwner || updateSettings.isPending}
                    onChange={(v) => patchPrefs({ notifications: { channels: { pagerduty: v } } })}
                  />
                }
              />
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
