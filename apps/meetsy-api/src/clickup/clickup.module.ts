import { Module } from "@nestjs/common";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import { KbModule } from "../kb/kb.module";
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
  // Phase 3.2 — PushService uses LearningService (clickup → kb, one-way) to record
  // the shown nudge + acceptance on each FieldOverride.
  imports: [KbModule],
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
