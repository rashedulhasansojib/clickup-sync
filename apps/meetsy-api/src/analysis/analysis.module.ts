import { Module } from "@nestjs/common";
import { AzureModule } from "../azure/azure.module";
import { KbModule } from "../kb/kb.module";
import { ClickUpModule } from "../clickup/clickup.module";
import { AnalysisController } from "./analysis.controller";
import { AnalysisService } from "./analysis.service";
import { AnalysisQueue } from "./queue/analysis.queue";
import { AnalysisProcessor } from "./queue/analysis.processor";
import { WorkspaceResolver } from "./workspace.resolver";

/**
 * Wires the HTTP flow (controller + service), the BullMQ producer (AnalysisQueue)
 * and the in-process worker (AnalysisProcessor). PrismaModule/ConfigModule are
 * global; AzureModule is imported for the pipeline LLM calls. Phase 2c.1: KbModule
 * provides KbSearchService/KbQueue so the worker can ground tasks in KB history
 * (one-way dep analysis → kb).
 */
@Module({
  imports: [AzureModule, KbModule, ClickUpModule],
  controllers: [AnalysisController],
  providers: [AnalysisService, AnalysisQueue, AnalysisProcessor, WorkspaceResolver],
})
export class AnalysisModule {}
