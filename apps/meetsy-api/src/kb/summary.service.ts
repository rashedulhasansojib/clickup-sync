import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SummaryFactsService } from "./summary-facts.service";
import { NarrativeService } from "./narrative.service";
import type { KbFacts, KbSummaryView } from "./summary.types";
import { isStale } from "./summary.util";

/**
 * Orchestrates the Phase 2a.1 summary card: serve the cached `KbSummary` when it's
 * still fresh, else recompute the exact facts (always) + the LLM narrative (best
 * effort — facts-only with `narrative: null` if Azure fails/unconfigured), persist,
 * and return. Facts are SQL (≈free); the single narrative call + cache keep cost
 * to cents regardless of workspace size.
 */
@Injectable()
export class SummaryService {
  private readonly logger = new Logger(SummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly facts: SummaryFactsService,
    private readonly narrative: NarrativeService,
  ) {}

  async getOrGenerate(workspaceId: string, refresh = false): Promise<KbSummaryView> {
    const currentEmbedded = await this.facts.embeddedCount(workspaceId);
    const cached = await this.prisma.kbSummary.findUnique({ where: { workspaceId } });

    if (cached && !refresh && !isStale(cached.taskCountAtGen, currentEmbedded)) {
      return {
        facts: cached.facts as unknown as KbFacts,
        narrative: cached.narrative,
        generatedAt: cached.generatedAt.toISOString(),
      };
    }

    const facts = await this.facts.computeFacts(workspaceId);
    const narrative = await this.tryNarrative(workspaceId, facts);
    const generatedAt = new Date();

    await this.prisma.kbSummary.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        facts: facts as unknown as object,
        narrative,
        taskCountAtGen: currentEmbedded,
        generatedAt,
      },
      update: {
        facts: facts as unknown as object,
        narrative,
        taskCountAtGen: currentEmbedded,
        generatedAt,
      },
    });

    return { facts, narrative, generatedAt: generatedAt.toISOString() };
  }

  /**
   * Generate the narrative, degrading to `null` (facts-only card) if Azure is
   * unconfigured or the call fails — the facts are the source of truth and must
   * never be blocked by the prose layer.
   */
  private async tryNarrative(workspaceId: string, facts: KbFacts): Promise<string | null> {
    try {
      const titles = await this.facts.sampleTitles(workspaceId);
      return await this.narrative.generate(facts, titles);
    } catch (err) {
      this.logger.warn(`Narrative generation failed; returning facts-only: ${(err as Error).message}`);
      return null;
    }
  }
}
