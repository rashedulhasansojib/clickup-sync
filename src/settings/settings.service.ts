import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CLICKUP_SPACES } from '../config/clickup-spaces.config';
import { CryptoService } from './crypto.service';
import { SettingsRepository } from './settings.repository';

const DEFAULT_TEAM_ID = '3450636';
const DEFAULT_SPIKE_HOURS_CAP = 12;
const DEFAULT_MAX_BACKFILL_LOOKBACK = 1095; // 3 years
const MAX_BACKFILL_LOOKBACK_BACKSTOP = 3650; // 10 years — absolute upper bound
const DEFAULT_EVENTS = 'taskCreated,taskUpdated,taskDeleted,taskTimeTrackedUpdated,taskStatusUpdated';

export interface SettingsPreferences {
  notifications: {
    alerts: { syncFail: boolean; webhookSpike: boolean; missingRate: boolean; tokenExpiring: boolean };
    channels: { email: boolean; slack: boolean; pagerduty: boolean };
  };
  sync: { reconcileLookbackDays: number; realtimeWebhooks: boolean; backfillOnConnect: boolean; maxBackfillLookbackDays: number; includeArchived: boolean };
  cost: { autoRecalcOnRateChange: boolean; rateMatching: 'start' | 'due'; nonBillableZero: boolean; excludedAssignees: { id: string; name: string | null; email: string | null }[] };
  failure: { webhookRetryAttempts: number };
  spike: { medianEnabled: boolean };
  spaces: Record<string, { enabled: boolean }>;
}

export const DEFAULT_PREFERENCES: SettingsPreferences = {
  notifications: {
    alerts: { syncFail: true, webhookSpike: true, missingRate: true, tokenExpiring: true },
    channels: { email: true, slack: true, pagerduty: false },
  },
  sync: { reconcileLookbackDays: 365, realtimeWebhooks: true, backfillOnConnect: true, maxBackfillLookbackDays: DEFAULT_MAX_BACKFILL_LOOKBACK, includeArchived: true },
  cost: { autoRecalcOnRateChange: true, rateMatching: 'start', nonBillableZero: false, excludedAssignees: [] },
  failure: { webhookRetryAttempts: 5 },
  spike: { medianEnabled: true },
  spaces: {},
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Recursively merge `patch` onto `base`, returning a new object. Plain objects
 *  merge key-by-key; everything else (incl. the per-space leaf objects) replaces. */
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
  apiToken?: string;
  teamId?: string;
  webhookEndpoint?: string;
  webhookEvents?: string;
  webhookSecret?: string;
  spikeHoursCap?: number;
  preferences?: DeepPartial<SettingsPreferences>;
}

export interface MaskedSettings {
  apiTokenSet: boolean;
  apiTokenLast4: string | null;
  teamId: string;
  webhookEndpoint: string;
  webhookEvents: string;
  webhookSecretSet: boolean;
  spikeHoursCap: number;
  encryptionEnabled: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
  preferences: SettingsPreferences;
  configuredSpaces: { id: string; name: string }[];
}

interface Cache {
  apiToken: string | null;
  webhookSecret: string | null;
  teamId: string | null;
  webhookEndpoint: string | null;
  webhookEvents: string | null;
  spikeHoursCap: number | null;
  updatedAt: Date | null;
  updatedBy: string | null;
  preferences: SettingsPreferences;
}

const EMPTY: Cache = {
  apiToken: null,
  webhookSecret: null,
  teamId: null,
  webhookEndpoint: null,
  webhookEvents: null,
  spikeHoursCap: null,
  updatedAt: null,
  updatedBy: null,
  preferences: DEFAULT_PREFERENCES,
};

/**
 * Source of truth for ClickUp connection settings. Reads the single
 * `app_settings` row into an in-memory cache at boot (and after every write),
 * exposing SYNCHRONOUS getters so per-request consumers (the ClickUp client
 * headers, the webhook signature guard) stay sync.
 *
 * Resolution per field: DB value (if set) → env fallback. Existing deployments
 * keep working from env until an admin saves a value in the UI.
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private cache: Cache = { ...EMPTY };
  /**
   * Notifies OTHER processes that this cache changed. Registered by
   * `SettingsSyncService` (which owns the Redis pub/sub) rather than injected,
   * because `QueueService` already depends on this service — injecting it back
   * would be a provider cycle. Null until that service initialises, and in
   * unit tests, where a write simply skips the broadcast.
   */
  private changePublisher: (() => void) | null = null;

  constructor(
    private readonly repo: SettingsRepository,
    private readonly crypto: CryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** See `changePublisher`. Called once by `SettingsSyncService` on boot. */
  registerChangePublisher(publish: () => void): void {
    this.changePublisher = publish;
  }

  async refresh(): Promise<void> {
    const row = await this.repo.get();
    this.cache = {
      apiToken: this.tryDecrypt(row?.clickupApiTokenEnc),
      webhookSecret: this.tryDecrypt(row?.webhookSecretEnc),
      teamId: row?.clickupTeamId ?? null,
      webhookEndpoint: row?.webhookEndpoint ?? null,
      webhookEvents: row?.webhookEvents ?? null,
      spikeHoursCap: row?.spikeHoursCap ?? null,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
      preferences: deepMergePrefs(DEFAULT_PREFERENCES, (row?.preferences as DeepPartial<SettingsPreferences>) ?? {}),
    };
  }

  private tryDecrypt(blob: string | null | undefined): string | null {
    if (!blob) return null;
    try {
      return this.crypto.decrypt(blob);
    } catch (err) {
      this.logger.error(
        `Failed to decrypt a stored settings secret — check APP_ENCRYPTION_KEY matches the key used to encrypt it. ${(err as Error).message}`,
      );
      return null;
    }
  }

  // ── Synchronous getters (DB → env fallback) ────────────────────────────────

  getApiToken(): string {
    return this.cache.apiToken ?? process.env.CLICKUP_API_TOKEN ?? '';
  }

  getTeamId(): string {
    return this.cache.teamId ?? process.env.CLICKUP_TEAM_ID ?? DEFAULT_TEAM_ID;
  }

  getWebhookSecret(): string {
    return this.cache.webhookSecret ?? process.env.CLICKUP_WEBHOOK_SECRET ?? '';
  }

  getWebhookEndpoint(): string {
    return this.cache.webhookEndpoint ?? process.env.CLICKUP_WEBHOOK_ENDPOINT ?? '';
  }

  getWebhookEvents(): string {
    return this.cache.webhookEvents ?? process.env.CLICKUP_WEBHOOK_EVENTS ?? DEFAULT_EVENTS;
  }

  getSpikeHoursCap(): number {
    return this.cache.spikeHoursCap ?? DEFAULT_SPIKE_HOURS_CAP;
  }

  getPreferences(): SettingsPreferences {
    return this.cache.preferences;
  }

  /** Configurable upper bound for a manual backfill's lookbackDays, read by the
   *  backfill controller and surfaced to the UI. Authoritative source of truth:
   *  a missing or out-of-range stored value can never leak through — it falls
   *  back to the 3-year default and is clamped to [1, 3650] (10-year backstop). */
  getBackfillMaxLookbackDays(): number {
    const v = this.cache.preferences.sync.maxBackfillLookbackDays ?? DEFAULT_MAX_BACKFILL_LOOKBACK;
    return Math.min(MAX_BACKFILL_LOOKBACK_BACKSTOP, Math.max(1, Math.round(v)));
  }

  /** Whether a space backfill runs a second pass to pull archived tasks (and
   *  their tracked time). Defaults to true; runtime-toggleable via Settings. */
  getIncludeArchived(): boolean {
    return this.cache.preferences.sync?.includeArchived ?? true;
  }

  /** Whether the median ("relative") spike rule contributes median numbers and
   *  wording to spike surfaces. Detection is unaffected; this only controls
   *  whether median-derived display is shown. Defaults to true. */
  isSpikeMedianEnabled(): boolean {
    return this.cache.preferences.spike?.medianEnabled ?? true;
  }

  /** Sync set of assignee ids excluded from costing. Read on the per-entry cost
   *  hot path, so it must stay synchronous (backed by the in-memory cache). */
  getExcludedAssigneeIds(): Set<string> {
    return new Set((this.cache.preferences.cost.excludedAssignees ?? []).map((a) => a.id));
  }

  isSpaceEnabled(spaceId: string): boolean {
    return this.cache.preferences.spaces[spaceId]?.enabled ?? true;
  }

  // ── Read for the admin UI (secrets masked) ─────────────────────────────────

  getMasked(): MaskedSettings {
    const token = this.getApiToken();
    const secret = this.getWebhookSecret();
    return {
      apiTokenSet: token.length > 0,
      apiTokenLast4: token.length >= 4 ? token.slice(-4) : null,
      teamId: this.getTeamId(),
      webhookEndpoint: this.getWebhookEndpoint(),
      webhookEvents: this.getWebhookEvents(),
      webhookSecretSet: secret.length > 0,
      spikeHoursCap: this.getSpikeHoursCap(),
      encryptionEnabled: this.crypto.isEnabled,
      updatedAt: this.cache.updatedAt,
      updatedBy: this.cache.updatedBy,
      preferences: this.cache.preferences,
      configuredSpaces: CLICKUP_SPACES.map((s) => ({ id: s.id, name: s.name })),
    };
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /** Update supplied fields. Secrets are only written when a non-empty value is provided. */
  async update(patch: SettingsPatch, actor?: string): Promise<MaskedSettings> {
    const data: Parameters<SettingsRepository['upsert']>[0] = { updatedBy: actor ?? null };
    if (patch.teamId !== undefined) data.clickupTeamId = patch.teamId.trim() || null;
    if (patch.webhookEndpoint !== undefined) data.webhookEndpoint = patch.webhookEndpoint.trim() || null;
    if (patch.webhookEvents !== undefined) data.webhookEvents = patch.webhookEvents.trim() || null;
    if (patch.spikeHoursCap !== undefined) data.spikeHoursCap = patch.spikeHoursCap;
    if (patch.apiToken) data.clickupApiTokenEnc = this.crypto.encrypt(patch.apiToken);
    if (patch.webhookSecret) data.webhookSecretEnc = this.crypto.encrypt(patch.webhookSecret);
    if (patch.preferences !== undefined) {
      data.preferences = deepMergePrefs(this.cache.preferences, patch.preferences) as unknown as import('@prisma/client').Prisma.InputJsonValue | import('@prisma/client').Prisma.NullableJsonNullValueInput;
    }
    await this.repo.upsert(data);
    await this.refresh();
    this.changePublisher?.();
    return this.getMasked();
  }

  /** Persist the webhook signing secret (used by the register-webhook flow). */
  async setWebhookSecret(secret: string, actor?: string): Promise<void> {
    await this.repo.upsert({ webhookSecretEnc: this.crypto.encrypt(secret), updatedBy: actor ?? null });
    await this.refresh();
    // Critical: the auto-heal rotation runs in the worker, but the signature
    // guard reads this secret in web. Without the broadcast, web keeps the old
    // secret and 401s every ClickUp delivery until it is restarted.
    this.changePublisher?.();
  }
}
