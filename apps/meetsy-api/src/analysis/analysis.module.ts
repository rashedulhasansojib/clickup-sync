import { Module } from "@nestjs/common";
import { AzureModule } from "../azure/azure.module";
import { AnalysisController } from "./analysis.controller";
import { AnalysisService } from "./analysis.service";
import { AnalysisQueue } from "./queue/analysis.queue";
import { AnalysisProcessor } from "./queue/analysis.processor";
import { WorkspaceResolver } from "./workspace.resolver";

/**
 * Wires the HTTP flow (controller + service), the BullMQ producer (AnalysisQueue)
 * and the in-process worker (AnalysisProcessor). PrismaModule/ConfigModule are
 * global; AzureModule is imported for the pipeline LLM calls.
 */
@Module({
  imports: [AzureModule],
  controllers: [AnalysisController],
  providers: [AnalysisService, AnalysisQueue, AnalysisProcessor, WorkspaceResolver],
})
export class AnalysisModule {}
