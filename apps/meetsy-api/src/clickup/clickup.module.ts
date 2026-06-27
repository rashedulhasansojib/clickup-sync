import { Module } from "@nestjs/common";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import { ClickUpTokenService } from "./clickup-token.service";
import { ClickUpClient } from "./clickup.client";
import { AssigneeResolverService } from "./assignee-resolver.service";
import { TaskMapperService } from "./task-mapper.service";
import { PushConfigService } from "./push-config.service";
import { PushService } from "./push.service";
import { PushConfigController } from "./push-config.controller";
import { ClickUpController } from "./clickup.controller";
import { PushController } from "./push.controller";
import { WorkspacesController } from "./workspaces.controller";

/**
 * Phase 1 ClickUp write-back: per-workspace push config, the minimal ClickUp
 * client (token decrypt + create/list/members), field mapping, assignee
 * resolution, and the idempotent push flow. PrismaModule/ConfigModule are global.
 */
@Module({
  controllers: [PushConfigController, ClickUpController, PushController, WorkspacesController],
  providers: [
    ClickUpTokenService,
    ClickUpClient,
    AssigneeResolverService,
    TaskMapperService,
    PushConfigService,
    PushService,
    WorkspaceResolver,
  ],
})
export class ClickUpModule {}
