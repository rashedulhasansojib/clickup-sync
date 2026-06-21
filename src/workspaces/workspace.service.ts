import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CryptoService } from '../settings/crypto.service';
import { WorkspaceRepository, WorkspaceWithSpaces } from './workspace.repository';

const DEFAULT_TEAM_ID = '3450636';
const DEFAULT_SPIKE_HOURS_CAP = 12;
const DEFAULT_MAX_BACKFILL_LOOKBACK = 1095; // 3 years
const MAX_BACKFILL_LOOKBACK_BACKSTOP = 3650; // 10 years — absolute upper bound
const DEFAULT_EVENTS = 'taskCreated,taskUpdated,taskDeleted,taskTimeTrackedUpdated,taskStatusUpdated';

/** Per-workspace sync preferences (stored under workspace.preferences.sync). */
export interface SyncPreferences {
  reconcileLookbackDays: number;
  realtimeWebhooks: boolean;
  backfillOnConnect: boolean;
  maxBackfillLookbackDays: number;
}

export const DEFAULT_SYNC_PREFERENCES: SyncPreferences = {
  reconcileLookbackDays: 365,
  realtimeWebhooks: true,
  backfillOnConnect: true,
  maxBackfillLookbackDays: DEFAULT_MAX_BACKFILL_LOOKBACK,
};

export interface WorkspaceSpaceEntry {
  spaceId: string;
  name: string;
  backfillLookbackDays: number;
  enabled: boolean;
}

/** Decrypted, ready-to-use snapshot of one workspace's connection + scope. */
interface CachedWorkspace {
  id: string;
  name: string;
  teamId: string;
  apiToken: string | null;
  webhookSecret: string | null;
  webhookEndpoint: string | null;
  webhookEvents: string | null;
  webhookId: string | null;
  spikeHoursCap: number;
  isDefault: boolean;
  status: 'ACTIVE' | 'DISABLED';
  sync: SyncPreferences;
  spaces: WorkspaceSpaceEntry[];
  updatedAt: Date | null;
  updatedBy: string | null;
}

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
  sync: SyncPreferences;
  spaces: WorkspaceSpaceEntry[];
  updatedAt: Date | null;
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
  sync?: Partial<SyncPreferences> | Record<string, unknown>;
}

/**
 * Source of truth for per-workspace ClickUp connection settings + space scope.
 * Reads every `workspaces` row (with its spaces) into an in-memory cache at boot
 * (and after every write), exposing SYNCHRONOUS getters keyed by workspaceId so
 * per-request consumers (the ClickUp client auth header, the webhook signature
 * guard) stay sync.
 *
 * Token resolution per workspace: workspace token (if set) → shared
 * CLICKUP_API_TOKEN env → ''. So a single service-account token can serve every
 * workspace it is a member of; a per-workspace override covers the rare
 * different-account case. Webhook secrets are always per-workspace (ClickUp
 * issues one per registered webhook).
 */
@Injectable()
export class WorkspaceService implements OnModuleInit {
  private readonly logger = new Logger(WorkspaceService.name);
  private cache = new Map<string, CachedWorkspace>();
  private defaultId: string | null = null;

  constructor(
    private readonly repo: WorkspaceRepository,
    private readonly crypto: CryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const rows = await this.repo.listAll();
    const next = new Map<string, CachedWorkspace>();
    let def: string | null = null;
    for (const row of rows) {
      const cached = this.toCached(row);
      next.set(row.id, cached);
      if (cached.isDefault && !def) def = row.id;
    }
    // Fall back to the first workspace if none is flagged default.
    if (!def && rows.length) def = rows[0].id;
    this.cache = next;
    this.defaultId = def;
  }

  private toCached(row: WorkspaceWithSpaces): CachedWorkspace {
    const prefs = (row.preferences as { sync?: Partial<SyncPreferences> } | null) ?? {};
    return {
      id: row.id,
      name: row.name,
      teamId: row.clickupTeamId,
      apiToken: this.tryDecrypt(row.clickupApiTokenEnc),
      webhookSecret: this.tryDecrypt(row.webhookSecretEnc),
      webhookEndpoint: row.webhookEndpoint,
      webhookEvents: row.webhookEvents,
      webhookId: row.webhookId,
      spikeHoursCap: row.spikeHoursCap ?? DEFAULT_SPIKE_HOURS_CAP,
      isDefault: row.isDefault,
      status: row.status as 'ACTIVE' | 'DISABLED',
      sync: { ...DEFAULT_SYNC_PREFERENCES, ...(prefs.sync ?? {}) },
      spaces: row.spaces.map((s) => ({
        spaceId: s.spaceId,
        name: s.name,
        backfillLookbackDays: s.backfillLookbackDays,
        enabled: s.enabled,
      })),
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  private tryDecrypt(blob: string | null | undefined): string | null {
    if (!blob) return null;
    try {
      return this.crypto.decrypt(blob);
    } catch (err) {
      this.logger.error(
        `Failed to decrypt a stored workspace secret — check APP_ENCRYPTION_KEY matches the key used to encrypt it. ${(err as Error).message}`,
      );
      return null;
    }
  }

  private require(workspaceId: string): CachedWorkspace {
    const ws = this.cache.get(workspaceId);
    if (!ws) throw new NotFoundException(`Unknown workspace: ${workspaceId}`);
    return ws;
  }

  // ── Resolution helpers ──────────────────────────────────────────────────────

  /** The default workspace id (the legacy single workspace). Throws if none exist. */
  getDefaultWorkspaceId(): string {
    if (!this.defaultId) throw new NotFoundException('No workspace configured');
    return this.defaultId;
  }

  hasWorkspace(workspaceId: string): boolean {
    return this.cache.has(workspaceId);
  }

  /** Validate an incoming workspace id, falling back to the default when absent. */
  resolveWorkspaceId(workspaceId?: string | null): string {
    if (!workspaceId) return this.getDefaultWorkspaceId();
    if (!this.cache.has(workspaceId)) throw new BadRequestException(`Unknown workspace: ${workspaceId}`);
    return workspaceId;
  }

  listWorkspaceIds(): string[] {
    return [...this.cache.keys()];
  }

  listActiveWorkspaceIds(): string[] {
    return [...this.cache.values()].filter((w) => w.status === 'ACTIVE').map((w) => w.id);
  }

  // ── Synchronous per-workspace getters (cache-backed) ────────────────────────

  getApiToken(workspaceId: string): string {
    return this.require(workspaceId).apiToken ?? process.env.CLICKUP_API_TOKEN ?? '';
  }

  getTeamId(workspaceId: string): string {
    return this.require(workspaceId).teamId || process.env.CLICKUP_TEAM_ID || DEFAULT_TEAM_ID;
  }

  getWebhookSecret(workspaceId: string): string {
    const ws = this.require(workspaceId);
    if (ws.webhookSecret) return ws.webhookSecret;
    // Legacy env fallback applies only to the default (single) workspace.
    return ws.isDefault ? (process.env.CLICKUP_WEBHOOK_SECRET ?? '') : '';
  }

  getWebhookEndpoint(workspaceId: string): string {
    const ws = this.require(workspaceId);
    return ws.webhookEndpoint ?? (ws.isDefault ? (process.env.CLICKUP_WEBHOOK_ENDPOINT ?? '') : '');
  }

  getWebhookEvents(workspaceId: string): string {
    return this.require(workspaceId).webhookEvents ?? process.env.CLICKUP_WEBHOOK_EVENTS ?? DEFAULT_EVENTS;
  }

  getWebhookId(workspaceId: string): string | null {
    return this.require(workspaceId).webhookId;
  }

  getSpikeHoursCap(workspaceId: string): number {
    return this.require(workspaceId).spikeHoursCap ?? DEFAULT_SPIKE_HOURS_CAP;
  }

  getSyncPreferences(workspaceId: string): SyncPreferences {
    return this.require(workspaceId).sync;
  }

  /** Configurable upper bound for a manual backfill's lookbackDays. Clamped to
   *  [1, 3650] so a missing/out-of-range stored value can never leak through. */
  getBackfillMaxLookbackDays(workspaceId: string): number {
    const v = this.require(workspaceId).sync.maxBackfillLookbackDays ?? DEFAULT_MAX_BACKFILL_LOOKBACK;
    return Math.min(MAX_BACKFILL_LOOKBACK_BACKSTOP, Math.max(1, Math.round(v)));
  }

  getSpaces(workspaceId: string): WorkspaceSpaceEntry[] {
    return this.require(workspaceId).spaces;
  }

  getSpace(workspaceId: string, spaceId: string): WorkspaceSpaceEntry | undefined {
    return this.require(workspaceId).spaces.find((s) => s.spaceId === spaceId);
  }

  isSpaceEnabled(workspaceId: string, spaceId: string): boolean {
    return this.getSpace(workspaceId, spaceId)?.enabled ?? false;
  }

  // ── Reads for the admin UI (secrets masked) ─────────────────────────────────

  getMasked(workspaceId: string): MaskedWorkspace {
    const ws = this.require(workspaceId);
    const token = this.getApiToken(workspaceId);
    const secret = this.getWebhookSecret(workspaceId);
    return {
      id: ws.id,
      name: ws.name,
      teamId: ws.teamId,
      apiTokenSet: token.length > 0,
      apiTokenLast4: token.length >= 4 ? token.slice(-4) : null,
      usesSharedToken: !ws.apiToken && token.length > 0,
      webhookEndpoint: ws.webhookEndpoint,
      webhookEvents: this.getWebhookEvents(workspaceId),
      webhookSecretSet: secret.length > 0,
      webhookId: ws.webhookId,
      spikeHoursCap: ws.spikeHoursCap,
      isDefault: ws.isDefault,
      status: ws.status,
      sync: ws.sync,
      spaces: ws.spaces,
      updatedAt: ws.updatedAt,
      updatedBy: ws.updatedBy,
    };
  }

  listMasked(): MaskedWorkspace[] {
    return this.listWorkspaceIds().map((id) => this.getMasked(id));
  }

  /** Non-secret workspace list for the all-roles dashboard switcher (no token
   *  hints or secret flags — just what a Member needs to pick a workspace). */
  listForSwitcher(): { id: string; name: string; isDefault: boolean; status: 'ACTIVE' | 'DISABLED'; teamId: string; maxBackfillLookbackDays: number; spaces: WorkspaceSpaceEntry[] }[] {
    return [...this.cache.values()].map((w) => ({
      id: w.id,
      name: w.name,
      isDefault: w.isDefault,
      status: w.status,
      teamId: w.teamId,
      maxBackfillLookbackDays: this.getBackfillMaxLookbackDays(w.id),
      spaces: w.spaces,
    }));
  }

  encryptionEnabled(): boolean {
    return this.crypto.isEnabled;
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  async createWorkspace(input: CreateWorkspaceInput, actor?: string): Promise<MaskedWorkspace> {
    if (input.apiToken && !this.crypto.isEnabled) {
      throw new BadRequestException('Cannot store a token: APP_ENCRYPTION_KEY is not configured.');
    }
    const created = await this.repo.create({
      org: { connect: { id: 'org_seed' } },
      name: input.name.trim(),
      clickupTeamId: input.teamId.trim(),
      clickupApiTokenEnc: input.apiToken ? this.crypto.encrypt(input.apiToken) : null,
      webhookEndpoint: input.webhookEndpoint?.trim() || null,
      webhookEvents: input.webhookEvents?.trim() || null,
      isDefault: false,
      updatedBy: actor ?? null,
    });
    await this.refresh();
    return this.getMasked(created.id);
  }

  async updateWorkspace(workspaceId: string, input: UpdateWorkspaceInput, actor?: string): Promise<MaskedWorkspace> {
    this.require(workspaceId);
    if (input.apiToken && !this.crypto.isEnabled) {
      throw new BadRequestException('Cannot store a token: APP_ENCRYPTION_KEY is not configured.');
    }
    const data: Prisma.WorkspaceUpdateInput = { updatedBy: actor ?? null };
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.teamId !== undefined) data.clickupTeamId = input.teamId.trim();
    if (input.webhookEndpoint !== undefined) data.webhookEndpoint = input.webhookEndpoint.trim() || null;
    if (input.webhookEvents !== undefined) data.webhookEvents = input.webhookEvents.trim() || null;
    if (input.spikeHoursCap !== undefined) data.spikeHoursCap = input.spikeHoursCap;
    if (input.status !== undefined) data.status = input.status;
    if (input.apiToken) data.clickupApiTokenEnc = this.crypto.encrypt(input.apiToken);
    if (input.sync !== undefined) {
      const merged = { ...this.getSyncPreferences(workspaceId), ...input.sync };
      data.preferences = { sync: merged } as unknown as Prisma.InputJsonValue;
    }
    await this.repo.update(workspaceId, data);
    await this.refresh();
    return this.getMasked(workspaceId);
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const ws = this.require(workspaceId);
    if (ws.isDefault) throw new BadRequestException('Cannot delete the default workspace');
    const dataCount = await this.repo.countData(workspaceId);
    if (dataCount > 0) {
      throw new BadRequestException(
        `Workspace still has ${dataCount} synced rows. Purge its ClickUp data before deleting.`,
      );
    }
    await this.repo.delete(workspaceId);
    await this.refresh();
  }

  /** Persist webhook id/endpoint and (when newly issued) the signing secret.
   *  On a ClickUp PUT the secret is unchanged, so `secret` is omitted there. */
  async setWebhook(workspaceId: string, args: { secret?: string; webhookId: string; endpoint: string }): Promise<void> {
    const data: Prisma.WorkspaceUpdateInput = { webhookId: args.webhookId, webhookEndpoint: args.endpoint };
    if (args.secret) data.webhookSecretEnc = this.crypto.encrypt(args.secret);
    await this.repo.update(workspaceId, data);
    await this.refresh();
  }

  async upsertSpace(
    workspaceId: string,
    spaceId: string,
    data: { name: string; backfillLookbackDays?: number; enabled?: boolean },
  ): Promise<MaskedWorkspace> {
    this.require(workspaceId);
    await this.repo.upsertSpace(workspaceId, spaceId, data);
    await this.refresh();
    return this.getMasked(workspaceId);
  }

  async deleteSpace(workspaceId: string, spaceId: string): Promise<MaskedWorkspace> {
    this.require(workspaceId);
    await this.repo.deleteSpace(workspaceId, spaceId);
    await this.refresh();
    return this.getMasked(workspaceId);
  }
}
