import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsRepository } from './settings.repository';

/**
 * App-GLOBAL, non-connection preferences. Per-connection ClickUp settings
 * (team id, token, webhook secret/endpoint/events, spike-hours cap) and the
 * per-workspace sync prefs + space scope live on the `Workspace` table and are
 * served by WorkspaceService. What remains here is shared across all workspaces:
 * notification routing, costing rules (rates are shared), and failure-retry.
 */
export interface SettingsPreferences {
  notifications: {
    alerts: { syncFail: boolean; webhookSpike: boolean; missingRate: boolean; tokenExpiring: boolean };
    channels: { email: boolean; slack: boolean; pagerduty: boolean };
  };
  cost: { autoRecalcOnRateChange: boolean; rateMatching: 'start' | 'due'; nonBillableZero: boolean; excludedAssignees: { id: string; name: string | null; email: string | null }[] };
  failure: { webhookRetryAttempts: number };
}

export const DEFAULT_PREFERENCES: SettingsPreferences = {
  notifications: {
    alerts: { syncFail: true, webhookSpike: true, missingRate: true, tokenExpiring: true },
    channels: { email: true, slack: true, pagerduty: false },
  },
  cost: { autoRecalcOnRateChange: true, rateMatching: 'start', nonBillableZero: false, excludedAssignees: [] },
  failure: { webhookRetryAttempts: 5 },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Recursively merge `patch` onto `base`, returning a new object. Plain objects
 *  merge key-by-key; everything else replaces. */
function deepMergePrefs(base: SettingsPreferences, patch: DeepPartial<SettingsPreferences>): SettingsPreferences {
  const out: any = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    const cur = (base as any)[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = deepMergePrefs(cur, v as any);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as SettingsPreferences;
}

export interface SettingsPatch {
  preferences?: DeepPartial<SettingsPreferences>;
}

interface Cache {
  updatedAt: Date | null;
  updatedBy: string | null;
  preferences: SettingsPreferences;
}

const EMPTY: Cache = { updatedAt: null, updatedBy: null, preferences: DEFAULT_PREFERENCES };

/**
 * Source of truth for app-global preferences. Reads the single `app_settings`
 * row into an in-memory cache at boot (and after every write), exposing
 * SYNCHRONOUS getters so per-request consumers (the per-entry costing hot path)
 * stay sync.
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private cache: Cache = { ...EMPTY };

  constructor(private readonly repo: SettingsRepository) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const row = await this.repo.get();
    this.cache = {
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
      preferences: deepMergePrefs(DEFAULT_PREFERENCES, (row?.preferences as DeepPartial<SettingsPreferences>) ?? {}),
    };
  }

  getPreferences(): SettingsPreferences {
    return this.cache.preferences;
  }

  /** Sync set of assignee ids excluded from costing. Read on the per-entry cost
   *  hot path, so it must stay synchronous (backed by the in-memory cache). */
  getExcludedAssigneeIds(): Set<string> {
    return new Set((this.cache.preferences.cost.excludedAssignees ?? []).map((a) => a.id));
  }

  getGlobal(): { preferences: SettingsPreferences; updatedAt: Date | null; updatedBy: string | null } {
    return { preferences: this.cache.preferences, updatedAt: this.cache.updatedAt, updatedBy: this.cache.updatedBy };
  }

  async update(patch: SettingsPatch, actor?: string): Promise<SettingsPreferences> {
    const data: Parameters<SettingsRepository['upsert']>[0] = { updatedBy: actor ?? null };
    if (patch.preferences !== undefined) {
      data.preferences = deepMergePrefs(this.cache.preferences, patch.preferences) as unknown as import('@prisma/client').Prisma.InputJsonValue | import('@prisma/client').Prisma.NullableJsonNullValueInput;
    }
    await this.repo.upsert(data);
    await this.refresh();
    return this.cache.preferences;
  }
}
