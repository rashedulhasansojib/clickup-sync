import { Module } from "@nestjs/common";
import { AzureModule } from "../azure/azure.module";
import { ClickUpModule } from "../clickup/clickup.module";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import { RosterMemoryService } from "./roster-memory.service";
import { RosterBrowserService } from "./roster-browser.service";
import { RosterLlmService } from "./roster-llm.service";
import { ParticipantAliasesController } from "./participant-aliases.controller";

/**
 * v2 Phase 7 — per-workspace roster memory (learned participant→member map).
 *
 * PR-A/B/C: `RosterMemoryService` (read/write) is consumed by AnalysisModule.
 * PR-D: `RosterBrowserService` + `ParticipantAliasesController` power the
 *       /kb Participants tab. ClickUpModule is imported so the browser can join
 *       the ClickUp member name onto each row.
 * PR-E: `RosterLlmService` — Azure structured call, KB rows as few-shot context.
 *       Only fires when both KB and heuristic miss.
 *
 * PrismaModule is @Global — no import needed.
 */
@Module({
  imports: [ClickUpModule, AzureModule],
  controllers: [ParticipantAliasesController],
  providers: [
    RosterMemoryService,
    RosterBrowserService,
    RosterLlmService,
    WorkspaceResolver,
  ],
  exports: [RosterMemoryService, RosterLlmService],
})
export class RosterModule {}
