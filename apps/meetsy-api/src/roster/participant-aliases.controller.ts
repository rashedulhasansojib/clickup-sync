import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import type { AuthPrincipal } from "@clicksy/shared";
import { CurrentUser, Roles } from "../auth/decorators";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import { RosterBrowserService } from "./roster-browser.service";
import {
  BulkImportParticipantAliasBody,
  BulkImportParticipantAliasSchema,
  BulkImportResult,
  CreateParticipantAliasBody,
  CreateParticipantAliasSchema,
  ParticipantAliasesPage,
  ParticipantAliasRow,
  UpdateParticipantAliasBody,
  UpdateParticipantAliasSchema,
} from "./participant-aliases.dto";

/**
 * v2 Phase 7 PR-D — per-workspace roster-memory KB browser. Powers the /kb
 * Participants tab.
 *
 * Read: any authenticated user (Members should be able to inspect what the KB
 * has learned about their workspace).
 * Write: Owner/Admin only (matches the /kb Rebuild tab convention — humans with
 * write authority can seed, correct, or blocklist mappings).
 */
@Controller("workspaces/:id/participant-aliases")
export class ParticipantAliasesController {
  constructor(
    private readonly browser: RosterBrowserService,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("filter") filter?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limitParam?: string,
  ): Promise<ParticipantAliasesPage> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
    return this.browser.list(workspaceId, {
      filter,
      cursor,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
  }

  @Post()
  @Roles("OWNER", "ADMIN")
  async create(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CreateParticipantAliasSchema))
    body: CreateParticipantAliasBody,
  ): Promise<ParticipantAliasRow> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.browser.create(workspaceId, user.userId, body);
  }

  @Post("bulk-import")
  @Roles("OWNER", "ADMIN")
  async bulkImport(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(BulkImportParticipantAliasSchema))
    body: BulkImportParticipantAliasBody,
  ): Promise<BulkImportResult> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.browser.bulkImport(workspaceId, user.userId, body);
  }

  @Patch(":aliasId")
  @Roles("OWNER", "ADMIN")
  async update(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Param("aliasId") aliasId: string,
    @Body(new ZodValidationPipe(UpdateParticipantAliasSchema))
    body: UpdateParticipantAliasBody,
  ): Promise<ParticipantAliasRow> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.browser.update(workspaceId, aliasId, body);
  }

  @Delete(":aliasId")
  @Roles("OWNER", "ADMIN")
  async remove(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Param("aliasId") aliasId: string,
  ): Promise<{ ok: true }> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    await this.browser.delete(workspaceId, aliasId);
    return { ok: true };
  }
}
