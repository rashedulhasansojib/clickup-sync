import { apiClient } from './client';
import type { MaskedWorkspace } from './workspaces';

/**
 * App-GLOBAL preferences only. Per-connection ClickUp settings (token, team id,
 * webhook secret/endpoint/events, spike cap) and per-workspace sync prefs + space
 * scope now live on the Workspace and are managed via the workspaces API.
 */
export interface SettingsPreferences {
  notifications: {
    alerts: { syncFail: boolean; webhookSpike: boolean; missingRate: boolean; tokenExpiring: boolean };
    channels: { email: boolean; slack: boolean; pagerduty: boolean };
  };
  cost: { autoRecalcOnRateChange: boolean; rateMatching: 'start' | 'due'; nonBillableZero: boolean; excludedAssignees: { id: string; name: string | null; email: string | null }[] };
  failure: { webhookRetryAttempts: number };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface AppSettings {
  preferences: SettingsPreferences;
  updatedAt: string | null;
  updatedBy: string | null;
  encryptionEnabled: boolean;
  workspaces: MaskedWorkspace[];
}

export interface SettingsPatch {
  preferences?: DeepPartial<SettingsPreferences>;
}

export const settingsApi = {
  get: (): Promise<AppSettings> => apiClient.get('/admin/settings').then((r) => r.data),
  update: (patch: SettingsPatch): Promise<AppSettings> =>
    apiClient.patch('/admin/settings', patch).then((r) => r.data),
};
