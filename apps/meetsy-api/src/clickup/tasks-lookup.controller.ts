import { Controller, Get, Param } from "@nestjs/common";
import type { AuthPrincipal } from "@clicksy/shared";
import type { ClickUpTaskLookupView } from "@ma/shared";
import { CurrentUser } from "../auth/decorators";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import { TasksLookupService } from "./tasks-lookup.service";

/**
 * GET /workspaces/:id/clickup/tasks/:taskId — resolve a ClickUp task_id to
 * display-friendly metadata. Any authenticated user (no role gate). Returns
 * `null` (200) when the task isn't in this workspace's read-only mirror.
 */
@Controller("workspaces/:id/clickup/tasks")
export class TasksLookupController {
  constructor(
    private readonly workspaces: WorkspaceResolver,
    private readonly lookup: TasksLookupService,
  ) {}

  @Get(":taskId")
  async get(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Param("taskId") taskId: string,
  ): Promise<ClickUpTaskLookupView | null> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.lookup.forWorkspace(workspaceId, taskId);
  }
}
