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
import { TasksLookupController } from "./tasks-lookup.controller";
import { TasksLookupService } from "./tasks-lookup.service";
import { PushRetryQueue } from "./push-retry/push-retry.queue";
import { PushRetryProcessor } from "./push-retry/push-retry.processor";
import { PushRetryService } from "./push-retry/push-retry.service";
import { PushRetryController } from "./push-retry/push-retry.controller";
import { PushDeadLetterService } from "./push-retry/push-dead-letter.service";
import { PushDeadLetterController } from "./push-retry/push-dead-letter.controller";

/**
 * Phase 1 ClickUp write-back: per-workspace push config, the minimal ClickUp
 * client (token decrypt + create/list/members), field mapping, assignee
 * resolution, and the idempotent push flow. PrismaModule/ConfigModule are global.
 *
 * v2 Phase 2 (PR-I): the retry pipeline — BullMQ queue + worker + retry endpoint
 * + Owner/Admin dead-letter surface — lives under `push-retry/` and reuses
 * ClickUpClient + WorkspaceResolver from this module.
 */
@Module({
  // Phase 3.2 — PushService uses LearningService (clickup → kb, one-way) to record
  // the shown nudge + acceptance on each FieldOverride.
  imports: [KbModule],
  controllers: [
    PushConfigController,
    ClickUpController,
    PushController,
    WorkspacesController,
    TasksLookupController,
    PushRetryController,
    PushDeadLetterController,
  ],
  providers: [
    ClickUpTokenService,
    ClickUpClient,
    AssigneeResolverService,
    TaskMapperService,
    PushConfigService,
    PushService,
    TasksLookupService,
    WorkspaceResolver,
    PushRetryQueue,
    PushRetryProcessor,
    PushRetryService,
    PushDeadLetterService,
  ],
  // Exported so AnalysisModule can suggest a ClickUp member per roster participant
  // at meeting creation (analysis → clickup, one-way; no cycle).
  exports: [ClickUpClient, AssigneeResolverService],
})
export class ClickUpModule {}
