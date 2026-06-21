import { apiClient } from './client';

export interface WorkspaceSpace {
  spaceId: string;
  name: string;
  backfillLookbackDays: number;
  enabled: boolean;
}

/** Non-secret shape returned by GET /workspaces (all roles, for the switcher). */
export interface SwitcherWorkspace {
  id: string;
  name: string;
  isDefault: boolean;
  status: 'ACTIVE' | 'DISABLED';
  teamId: string;
  maxBackfillLookbackDays: number;
  spaces: WorkspaceSpace[];
}

/** Full masked shape returned by /admin/workspaces (OWNER/ADMIN). */
export interface MaskedWorkspace {
  id: string;
  name: string;
  teamId: string;
  apiTokenSet: boolean;
  apiTokenLast4: string | null;
  usesSharedToken: boolean;
  webhookEndpoint: string | null;
  webhookEvents: string;
  webhookSecretSet: boolean;
  webhookId: string | null;
  spikeHoursCap: number;
  isDefault: boolean;
  status: 'ACTIVE' | 'DISABLED';
  sync: { reconcileLookbackDays: number; realtimeWebhooks: boolean; backfillOnConnect: boolean; maxBackfillLookbackDays: number };
  spaces: WorkspaceSpace[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface CreateWorkspaceInput {
  name: string;
  teamId: string;
  apiToken?: string;
  webhookEndpoint?: string;
  webhookEvents?: string;
}

export interface UpdateWorkspaceInput {
  name?: string;
  teamId?: string;
  apiToken?: string;
  webhookEndpoint?: string;
  webhookEvents?: string;
  spikeHoursCap?: number;
  status?: 'ACTIVE' | 'DISABLED';
  sync?: Partial<MaskedWorkspace['sync']>;
}

export interface UpsertSpaceInput {
  spaceId: string;
  name: string;
  backfillLookbackDays?: number;
  enabled?: boolean;
}

export const workspacesApi = {
  // All roles — switcher.
  list: (): Promise<SwitcherWorkspace[]> =>
    apiClient.get('/workspaces').then((r) => r.data.workspaces),

  // OWNER/ADMIN management.
  listAdmin: (): Promise<{ workspaces: MaskedWorkspace[]; encryptionEnabled: boolean }> =>
    apiClient.get('/admin/workspaces').then((r) => r.data),
  create: (input: CreateWorkspaceInput): Promise<MaskedWorkspace> =>
    apiClient.post('/admin/workspaces', input).then((r) => r.data),
  update: (id: string, input: UpdateWorkspaceInput): Promise<MaskedWorkspace> =>
    apiClient.patch(`/admin/workspaces/${id}`, input).then((r) => r.data),
  remove: (id: string): Promise<{ deleted: boolean; id: string }> =>
    apiClient.delete(`/admin/workspaces/${id}`).then((r) => r.data),
  // Discover the workspace's spaces from ClickUp (for the picker).
  listClickupSpaces: (id: string): Promise<{ id: string; name: string; configured: boolean }[]> =>
    apiClient.get(`/admin/workspaces/${id}/clickup-spaces`).then((r) => r.data.spaces),
  upsertSpace: (id: string, input: UpsertSpaceInput): Promise<MaskedWorkspace> =>
    apiClient.post(`/admin/workspaces/${id}/spaces`, input).then((r) => r.data),
  deleteSpace: (id: string, spaceId: string): Promise<MaskedWorkspace> =>
    apiClient.delete(`/admin/workspaces/${id}/spaces/${spaceId}`).then((r) => r.data),
  // Register the ClickUp webhook for a specific workspace.
  registerWebhook: (id: string): Promise<unknown> =>
    apiClient.post('/admin/webhooks/register', undefined, { params: { workspaceId: id } }).then((r) => r.data),
};
