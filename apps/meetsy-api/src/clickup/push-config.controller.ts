import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import type { AuthPrincipal } from "@clicksy/shared";
import { CurrentUser, Roles } from "../auth/decorators";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import { PushConfigService, PushConfigView } from "./push-config.service";
import { PutPushConfigDto, PutPushConfigSchema } from "./clickup.dto";

@Controller("workspaces/:id/push-config")
export class PushConfigController {
  constructor(
    private readonly pushConfig: PushConfigService,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  /** Current push config for the workspace (null if unset). Any authenticated user. */
  @Get()
  async get(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
  ): Promise<PushConfigView | null> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.pushConfig.get(workspaceId);
  }

  /** Set the target list + assignable members. Owner/Admin only. */
  @Put()
  @Roles("OWNER", "ADMIN")
  async put(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(PutPushConfigSchema)) body: PutPushConfigDto,
  ): Promise<PushConfigView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.pushConfig.set(workspaceId, body, user.userId);
  }
}
