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
import { KbDocsController } from "./kb-docs.controller";
import { KbDocsService } from "./kb-docs.service";
import { KbDocsQueue } from "./kb-docs.queue";
import { KbDocsProcessor } from "./kb-docs.processor";
import { NoveltyService } from "./novelty.service";
import { DocTaskLinkService } from "./doc-task-link.service";
import { AnswerabilityService } from "./answerability.service";

/**
 * Phase 2a knowledge-base slice: per-workspace onboarding (coverage check →
 * Clicksy backfill trigger → embed), the BullMQ embed worker, and hybrid search.
 * Phase 2b adds document upload (parse→chunk→embed) + the honest improvement
 * metric (novelty + answerability-lift) + doc↔task linking.
 * PrismaModule/ConfigModule are global; AzureModule provides the embeddings client.
 */
@Module({
  imports: [AzureModule],
  controllers: [KbController, KbDocsController],
  providers: [
    KbOnboardingService,
    KbSearchService,
    SummaryFactsService,
    NarrativeService,
    SummaryService,
    KbQueue,
    KbProcessor,
    ClicksyAdminClient,
    KbDocsService,
    KbDocsQueue,
    KbDocsProcessor,
    NoveltyService,
    DocTaskLinkService,
    AnswerabilityService,
    WorkspaceResolver,
  ],
})
export class KbModule {}
