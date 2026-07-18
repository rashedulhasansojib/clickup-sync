import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import type { AuthPrincipal } from "@clicksy/shared";
import {
  RunSnapshotPayloadSchema,
  type RunSnapshotPayload,
} from "@ma/shared";
import { CurrentUser, Roles } from "../auth/decorators";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import {
  MlConfigService,
  WorkspaceMlConfigView,
} from "../kb/ml-config.service";
import {
  MlConfigPreviewService,
  MlConfigPreviewView,
} from "./ml-config-preview.service";

/**
 * v2 Phase 5 — `/tuning` API. Three routes on one prefix:
 *   GET  /workspaces/:id/ml-config           — read (any authed user)
 *   PUT  /workspaces/:id/ml-config           — write (OWNER only)
 *   POST /workspaces/:id/ml-config/preview   — replay last N runs against
 *                                              candidate config (OWNER only)
 *
 * GET is intentionally NOT role-gated: the `/tuning` UI renders read-only for
 * non-Owners so they can inspect current tunables. PUT + preview are Owner-only.
 */
@Controller("workspaces/:id/ml-config")
export class TuningController {
  constructor(
    private readonly workspaces: WorkspaceResolver,
    private readonly mlConfig: MlConfigService,
    private readonly preview: MlConfigPreviewService,
  ) {}

  @Get()
  async get(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
  ): Promise<WorkspaceMlConfigView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.mlConfig.viewForWorkspace(workspaceId);
  }

  @Put()
  @Roles("OWNER")
  async put(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RunSnapshotPayloadSchema))
    body: RunSnapshotPayload,
  ): Promise<WorkspaceMlConfigView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.mlConfig.upsert(workspaceId, user.orgId, user.userId, body);
  }

  @Post("preview")
  @Roles("OWNER")
  async previewReplay(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RunSnapshotPayloadSchema))
    body: RunSnapshotPayload,
    @Query("limit") limit?: string,
  ): Promise<MlConfigPreviewView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    const parsedLimit =
      limit !== undefined && limit !== ""
        ? Number.parseInt(limit, 10) || undefined
        : undefined;
    return this.preview.run(workspaceId, body, { limit: parsedLimit });
  }
}
