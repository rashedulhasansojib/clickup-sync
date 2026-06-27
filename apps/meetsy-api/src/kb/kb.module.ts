import { Module } from "@nestjs/common";
import { AzureModule } from "../azure/azure.module";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import { KbController } from "./kb.controller";
import { KbOnboardingService } from "./kb-onboarding.service";
import { KbSearchService } from "./kb-search.service";
import { SummaryFactsService } from "./summary-facts.service";
import { NarrativeService } from "./narrative.service";
import { SummaryService } from "./summary.service";
import { KbQueue } from "./kb.queue";
import { KbProcessor } from "./kb.processor";
import { ClicksyAdminClient } from "./clicksy-admin.client";

/**
 * Phase 2a knowledge-base slice: per-workspace onboarding (coverage check →
 * Clicksy backfill trigger → embed), the BullMQ embed worker, and hybrid search.
 * PrismaModule/ConfigModule are global; AzureModule provides the embeddings client.
 */
@Module({
  imports: [AzureModule],
  controllers: [KbController],
  providers: [
    KbOnboardingService,
    KbSearchService,
    SummaryFactsService,
    NarrativeService,
    SummaryService,
    KbQueue,
    KbProcessor,
    ClicksyAdminClient,
    WorkspaceResolver,
  ],
})
export class KbModule {}
