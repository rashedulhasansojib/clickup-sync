import { Injectable, Logger } from "@nestjs/common";
import {
  RunSnapshotPayloadSchema,
  WorkspaceModelsSchema,
  WorkspaceTunablesSchema,
  type RunSnapshotPayload,
} from "@ma/shared";
import { PrismaService } from "../prisma/prisma.service";
import { DEFAULT_MODELS, DEFAULT_TUNABLES } from "./ml-config.defaults";

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
 */
@Injectable()
export class MlConfigService {
  private readonly logger = new Logger(MlConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

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
}
