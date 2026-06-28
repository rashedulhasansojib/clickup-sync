import { Controller, Get, Query } from "@nestjs/common";
import type { AuthPrincipal } from "@clicksy/shared";
import { CurrentUser, Roles } from "../auth/decorators";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import { ClickUpClient } from "./clickup.client";
import { AssignableMember, ClickUpSpaceNode } from "./clickup.types";

/**
 * Read-only ClickUp pickers for the push-settings UI. Owner/Admin only (the same
 * roles that may write the push config).
 */
@Controller("clickup")
export class ClickUpController {
  constructor(
    private readonly client: ClickUpClient,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  /** Space → folder → list tree for the target-list picker. */
  @Get("lists")
  @Roles("OWNER", "ADMIN")
  async lists(
    @CurrentUser() user: AuthPrincipal,
    @Query("workspaceId") workspaceId?: string,
  ): Promise<{ spaces: ClickUpSpaceNode[] }> {
    const ws = await this.workspaces.resolve(user.orgId, workspaceId);
    return { spaces: await this.client.getSpaceTree(ws) };
  }

  /** Team members for the assignable-members picker (picker-ready shape). */
  @Get("members")
  @Roles("OWNER", "ADMIN")
  async members(
    @CurrentUser() user: AuthPrincipal,
    @Query("workspaceId") workspaceId?: string,
  ): Promise<{ members: AssignableMember[] }> {
    const ws = await this.workspaces.resolve(user.orgId, workspaceId);
    const members = await this.client.getAssignableMembers(ws);
    return { members };
  }
}
