import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AzureEmbeddingService } from "../azure/azure-embedding.service";
import { AzureOpenAIService } from "../azure/azure-openai.service";
import { toVectorLiteral } from "./kb.processor";

/**
 * Answerability-lift: a question-answering proxy for "did this document make the
 * KB better?" (2b spec §3b). For a set of HELD-OUT questions, count how many the
 * KB can answer BEFORE vs AFTER the document's chunks are present.
 *
 * Honesty by construction (locked decisions):
 *  - Questions are NOT generated from the doc being scored. They come from real
 *    meeting transcripts (independent) when available; otherwise from the
 *    workspace's own tasks, and the result is flagged `provisional` — because
 *    "answers questions derived from its own tasks" is somewhat circular. True
 *    lift becomes meaningful once real transcripts exist (Phase 2c).
 *  - The judge is BLIND and IDENTICAL before vs after: same prompt, same k; only
 *    the retrieved context differs (BEFORE excludes the doc's chunks, AFTER
 *    includes them). The delta is therefore attributable to retrieval, not the
 *    model. Per-question verdicts are returned for full inspectability.
 */
export interface AnswerabilityQuestionResult {
  question: string;
  answerableBefore: boolean;
  answerableAfter: boolean;
}

export interface AnswerabilityResult {
  /** true when questions came from tasks (no transcripts yet) — circular, labelled. */
  provisional: boolean;
  /** "transcript" | "task" — where the questions came from. */
  questionSource: "transcript" | "task";
  questionCount: number;
  answerableBefore: number;
  answerableAfter: number;
  /** was-no → now-yes (the headline lift). */
  newlyAnswerable: number;
  /** was-yes → now-no (retrieval regressions; should be ~0). */
  regressions: number;
  questions: AnswerabilityQuestionResult[];
}

const MAX_QUESTIONS = 10;
const RETRIEVE_K = 5;
const JUDGE_DEPLOYMENT = "gpt-5.4-mini";

const QuestionsSchema = z.object({ questions: z.array(z.string()).max(MAX_QUESTIONS) });
const VerdictSchema = z.object({ answerable: z.boolean(), reason: z.string() });

interface CtxRow {
  content: string;
}

@Injectable()
export class AnswerabilityService {
  private readonly logger = new Logger(AnswerabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embed: AzureEmbeddingService,
    private readonly chat: AzureOpenAIService,
  ) {}

  /**
   * Compute answerability-lift for a freshly-embedded document. Returns null when
   * the metric can't run (no questions derivable AND/OR Azure unavailable) — the
   * caller treats null as "answerability not computed" (novelty still stands).
   */
  async compute(workspaceId: string, documentId: string): Promise<AnswerabilityResult | null> {
    try {
      const { questions, provisional, source } = await this.deriveQuestions(workspaceId);
      if (questions.length === 0) return null;

      const results: AnswerabilityQuestionResult[] = [];
      for (const q of questions) {
        const [vec] = await this.embed.embed(q, { dimensions: 1024 });
        const before = await this.retrieve(workspaceId, vec, documentId, false);
        const after = await this.retrieve(workspaceId, vec, documentId, true);
        const [ansBefore, ansAfter] = await Promise.all([
          this.judge(q, before),
          this.judge(q, after),
        ]);
        results.push({ question: q, answerableBefore: ansBefore, answerableAfter: ansAfter });
      }

      const answerableBefore = results.filter((r) => r.answerableBefore).length;
      const answerableAfter = results.filter((r) => r.answerableAfter).length;
      const newlyAnswerable = results.filter((r) => !r.answerableBefore && r.answerableAfter).length;
      const regressions = results.filter((r) => r.answerableBefore && !r.answerableAfter).length;

      return {
        provisional,
        questionSource: source,
        questionCount: results.length,
        answerableBefore,
        answerableAfter,
        newlyAnswerable,
        regressions,
        questions: results,
      };
    } catch (err) {
      this.logger.warn(`Answerability-lift skipped: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Derive held-out questions. Prefer real transcripts (independent of the KB);
   * fall back to task-derived questions flagged provisional.
   */
  private async deriveQuestions(
    workspaceId: string,
  ): Promise<{ questions: string[]; provisional: boolean; source: "transcript" | "task" }> {
    const meetings = await this.prisma.meeting.findMany({
      where: { workspaceId },
      select: { normalizedTranscript: true, transcript: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    const transcriptText = meetings
      .map((m) => m.normalizedTranscript ?? m.transcript)
      .filter((t): t is string => Boolean(t && t.trim()))
      .join("\n---\n")
      .slice(0, 12_000);

    if (transcriptText) {
      const questions = await this.extractQuestions(
        "You extract the concrete questions a meeting raised — things someone would need answered to act on it.",
        `From these meeting transcript excerpts, list up to ${MAX_QUESTIONS} distinct, self-contained questions the meeting raised. Return only the questions.\n\n${transcriptText}`,
      );
      if (questions.length > 0) return { questions, provisional: false, source: "transcript" };
    }

    // Provisional fallback: questions from the workspace's own tasks.
    const tasks = await this.prisma.clickupTask.findMany({
      where: { workspaceId, isDeleted: false },
      select: { taskName: true, description: true },
      orderBy: { updatedDate: "desc" },
      take: 40,
    });
    const taskText = tasks
      .map((t) => `- ${t.taskName}${t.description ? `: ${t.description.slice(0, 200)}` : ""}`)
      .join("\n")
      .slice(0, 12_000);
    if (!taskText.trim()) return { questions: [], provisional: true, source: "task" };

    const questions = await this.extractQuestions(
      "You write the questions a new team member would need answered to understand a team's work.",
      `From these task titles/descriptions, write up to ${MAX_QUESTIONS} distinct, self-contained questions a new team member would ask to understand this work. Return only the questions.\n\n${taskText}`,
    );
    return { questions, provisional: true, source: "task" };
  }

  private async extractQuestions(system: string, user: string): Promise<string[]> {
    const out = await this.chat.structured({
      system,
      user,
      schema: QuestionsSchema,
      schemaName: "questions",
      deployment: JUDGE_DEPLOYMENT,
      reasoningEffort: "low",
    });
    return out.questions.map((q) => q.trim()).filter(Boolean).slice(0, MAX_QUESTIONS);
  }

  /**
   * Retrieve top-k context for a question. `includeDoc=false` (BEFORE) excludes
   * the document's own chunks; `includeDoc=true` (AFTER) includes the whole KB.
   * Searches across task + document chunks (the full KB).
   */
  private async retrieve(
    workspaceId: string,
    vec: number[],
    documentId: string,
    includeDoc: boolean,
  ): Promise<string[]> {
    const vecLit = toVectorLiteral(vec);
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      return tx.$queryRaw<CtxRow[]>(Prisma.sql`
        SELECT "content"
        FROM "meetsy"."KbChunk"
        WHERE "workspaceId" = ${workspaceId}
          AND "embedding" IS NOT NULL
          AND (${includeDoc}
               OR NOT ("sourceType" = 'document'::"meetsy"."KbSourceType" AND "sourceId" = ${documentId}))
        ORDER BY "embedding" OPERATOR(public.<=>) ${vecLit}::public.vector
        LIMIT ${RETRIEVE_K}
      `);
    });
    return rows.map((r) => r.content);
  }

  /** The BLIND, identical judge — same prompt for BEFORE and AFTER. */
  private async judge(question: string, context: string[]): Promise<boolean> {
    if (context.length === 0) return false;
    const verdict = await this.chat.structured({
      system:
        "You judge whether the provided CONTEXT is sufficient to answer the QUESTION. " +
        "Use ONLY the context — no outside knowledge. Set answerable=true only if the " +
        "context contains enough specific information to actually answer the question.",
      user: `QUESTION:\n${question}\n\nCONTEXT:\n${context.map((c, i) => `[${i + 1}] ${c}`).join("\n\n")}`,
      schema: VerdictSchema,
      schemaName: "answerability_verdict",
      deployment: JUDGE_DEPLOYMENT,
      reasoningEffort: "low",
    });
    return verdict.answerable;
  }
}
