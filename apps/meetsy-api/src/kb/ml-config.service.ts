import { Injectable, Logger } from "@nestjs/common";
import {
  RunSnapshotPayloadSchema,
  WorkspaceModelsSchema,
  WorkspaceTunablesSchema,
  type RunSnapshotPayload,
} from "@ma/shared";
import { PrismaService } from "../prisma/prisma.service";
import { LearningCacheService } from "./learning-cache.service";
import { DEFAULT_MODELS, DEFAULT_TUNABLES } from "./ml-config.defaults";

/** v2 Phase 5 — GET payload for the /tuning surface (adds row provenance). */
export interface WorkspaceMlConfigView {
  tunables: RunSnapshotPayload["tunables"];
  models: RunSnapshotPayload["models"];
  /** Null when no row exists yet (returning defaults). */
  updatedBy: string | null;
  /** ISO string of the row's `updatedAt`; null when no row exists. */
  updatedAt: string | null;
  /** True iff no row is persisted — the UI shows a "using defaults" chip. */
  isDefault: boolean;
}

/**
 * Reads the per-workspace ML tunables + model routing (`WorkspaceMlConfig`).
 * Falls back to the hardcoded defaults from `ml-config.defaults.ts` — so a
 * workspace with no row today still gets a valid config, and Phase 5's tuning
 * UI (which will lazy-create the row on first read) doesn't need a migration
 * seeder.
 *
 * Also serializes writes for `AnalysisRunSnapshot` (Phase 0 only writes; Phase
 * 5 reads for the preview replay). Never throws — a malformed row falls back
 * to defaults with a warning, so a bad column value can't break the pipeline.
 *
 * v2 Phase 5 adds `viewForWorkspace` (adds row provenance for the /tuning UI)
 * and `upsert` (Owner-gated write path). A successful upsert invalidates the
 * learning-snapshot cache so `minCorrections`/`minAgreement` edits take effect
 * on the next `/learning` read.
 */
@Injectable()
export class MlConfigService {
  private readonly logger = new Logger(MlConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: LearningCacheService,
  ) {}

  /**
   * Returns the workspace's tunables + models. When no row exists (or when a
   * row's JSON columns are invalid), returns the defaults with defaults-applied
   * Zod parses so downstream reads see canonical shapes.
   */
  async forWorkspace(workspaceId: string): Promise<RunSnapshotPayload> {
    const row = await this.prisma.workspaceMlConfig
      .findUnique({ where: { workspaceId } })
      .catch((err) => {
        this.logger.warn(
          `WorkspaceMlConfig lookup failed for ${workspaceId}: ${(err as Error).message}`,
        );
        return null;
      });

    if (!row) {
      return {
        tunables: WorkspaceTunablesSchema.parse(DEFAULT_TUNABLES),
        models: WorkspaceModelsSchema.parse(DEFAULT_MODELS),
      };
    }

    // Merge partial DB values over defaults so a row that only overrides some
    // fields still parses (the schemas fill missing keys with their defaults).
    const tunables = WorkspaceTunablesSchema.safeParse({
      ...DEFAULT_TUNABLES,
      ...(row.tunables as object),
    });
    const models = WorkspaceModelsSchema.safeParse({
      ...DEFAULT_MODELS,
      ...(row.models as object),
    });

    if (!tunables.success || !models.success) {
      this.logger.warn(
        `WorkspaceMlConfig row for ${workspaceId} failed schema validation; falling back to defaults.`,
      );
      return RunSnapshotPayloadSchema.parse({
        tunables: DEFAULT_TUNABLES,
        models: DEFAULT_MODELS,
      });
    }

    return { tunables: tunables.data, models: models.data };
  }

  /**
   * v2 Phase 5 — the /tuning surface's GET payload: the parsed config plus row
   * provenance (`updatedBy`, `updatedAt`, `isDefault`). Never throws; a missing
   * or malformed row degrades to defaults just like `forWorkspace`.
   */
  async viewForWorkspace(workspaceId: string): Promise<WorkspaceMlConfigView> {
    const row = await this.prisma.workspaceMlConfig
      .findUnique({ where: { workspaceId } })
      .catch((err) => {
        this.logger.warn(
          `WorkspaceMlConfig view lookup failed for ${workspaceId}: ${(err as Error).message}`,
        );
        return null;
      });

    const cfg = await this.forWorkspace(workspaceId);
    if (!row) {
      return {
        tunables: cfg.tunables,
        models: cfg.models,
        updatedBy: null,
        updatedAt: null,
        isDefault: true,
      };
    }
    return {
      tunables: cfg.tunables,
      models: cfg.models,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
      isDefault: false,
    };
  }

  /**
   * v2 Phase 5 — Owner-gated write path. Persists candidate tunables + models
   * for the workspace and invalidates the learning-snapshot cache so gate-value
   * edits take effect on the next `/learning` read. Payload is expected to have
   * already been validated by `ZodValidationPipe(RunSnapshotPayloadSchema)` at
   * the controller; we defensively re-parse here to be resilient to a service
   * caller that skips the pipe (e.g. an internal batch job).
   */
  async upsert(
    workspaceId: string,
    orgId: string,
    updatedBy: string,
    payload: RunSnapshotPayload,
  ): Promise<WorkspaceMlConfigView> {
    const parsed = RunSnapshotPayloadSchema.parse(payload);
    const tunablesJson = parsed.tunables as unknown as object;
    const modelsJson = parsed.models as unknown as object;
    const row = await this.prisma.workspaceMlConfig.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        orgId,
        tunables: tunablesJson,
        models: modelsJson,
        updatedBy,
      },
      update: {
        tunables: tunablesJson,
        models: modelsJson,
        updatedBy,
      },
    });
    await this.cache.invalidate(workspaceId);
    return {
      tunables: parsed.tunables,
      models: parsed.models,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
      isDefault: false,
    };
  }
}
