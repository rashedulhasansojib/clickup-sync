import { Controller, Get, Param } from "@nestjs/common";
import type { AuthPrincipal } from "@clicksy/shared";
import { CurrentUser } from "../auth/decorators";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import { LearningService, LearningSummaryView } from "./learning.service";

/**
 * Phase 3.2 — "what we've learned": the correction stats + the two honest metrics
 * (raw-model override rate = KB-quality proxy; nudge-acceptance = loop lift).
 * Workspace-scoped + session-authed (global AuthGuard).
 */
@Controller("workspaces/:id/learning")
export class LearningController {
  constructor(
    private readonly learning: LearningService,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  @Get()
  async summary(@CurrentUser() user: AuthPrincipal, @Param("id") id: string): Promise<LearningSummaryView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.learning.summary(workspaceId);
  }
}
