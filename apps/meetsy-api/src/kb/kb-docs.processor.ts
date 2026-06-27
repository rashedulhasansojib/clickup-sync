import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { Job, Worker } from "bullmq";
import { Prisma } from "@prisma/client";
import { ConfigService } from "../config/config.service";
import { PrismaService } from "../prisma/prisma.service";
import { AzureEmbeddingService } from "../azure/azure-embedding.service";
import { KB_DOCS_QUEUE_NAME, KbDocsJobData } from "./kb-docs.queue";
import { extractText } from "./doc-extract";
import { chunkText } from "./chunk-text";
import { embedInBatches, toVectorLiteral } from "./kb.processor";
import { NoveltyService } from "./novelty.service";
import { DocTaskLinkService } from "./doc-task-link.service";
import { AnswerabilityService } from "./answerability.service";
import type { KbDocMetric } from "./kb-docs.service";

const EMBED_DIMS = 1024;
const EMBED_VERSION = 1;
/** Hard page cap (parse-time) — pairs with the byte cap in KbDocsService. */
const MAX_PAGES = 300;

/**
 * The `meetsy-kb-docs` worker: parse → chunk → embed → metric, per uploaded doc.
 * Reuses the Phase-2b onboarding-robustness config (short lock + stalled-recovery
 * + authoritative `failed` handler) so a crash mid-ingest recovers fast and never
 * strands a document on a non-terminal status.
 */
@Injectable()
export class KbDocsProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbDocsProcessor.name);
  private worker!: Worker<KbDocsJobData>;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly azure: AzureEmbeddingService,
    private readonly novelty: NoveltyService,
    private readonly links: DocTaskLinkService,
    private readonly answerability: AnswerabilityService,
  ) {}

  onModuleInit(): void {
    const { host, port } = this.config.redis;
    this.worker = new Worker<KbDocsJobData>(KB_DOCS_QUEUE_NAME, (job) => this.process(job), {
      connection: { host, port, maxRetriesPerRequest: null },
      lockDuration: 120_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    });
    this.worker.on("failed", (job, err) => {
      this.logger.error(`KB-docs job ${job?.id} failed: ${err.message}`);
      void this.markError(job?.data?.documentId, err.message);
    });
    this.logger.log(`KB-docs worker listening on "${KB_DOCS_QUEUE_NAME}"`);
  }

  private async process(job: Job<KbDocsJobData>): Promise<void> {
    const { workspaceId, documentId, buffer, mimeType } = job.data;
    try {
      // 1) Parse → extract text (discard the bytes after this).
      await this.prisma.kbDocument.update({ where: { id: documentId }, data: { status: "parsing", error: null } });
      const { text, pageCount } = await extractText(Buffer.from(buffer, "base64"), mimeType);
      if (pageCount != null && pageCount > MAX_PAGES) {
        throw new Error(`Document has ${pageCount} pages; the limit is ${MAX_PAGES}`);
      }

      // 2) Chunk → embed → upsert into KbChunk (sourceType=document).
      await this.prisma.kbDocument.update({
        where: { id: documentId },
        data: { status: "embedding", extractedText: text, charCount: text.length, pageCount: pageCount ?? null },
      });
      const chunks = chunkText(text);
      if (chunks.length === 0) throw new Error("No extractable text after chunking");

      const model = this.config.get("AZURE_EMBED_DEPLOYMENT");
      const vectors = await embedInBatches(
        this.azure,
        chunks.map((c) => ({ sourceId: `${documentId}#${c.index}`, content: c.content })),
      );
      await this.prisma.$transaction(async (tx) => {
        // Replace any prior chunks for this doc (idempotent re-ingest).
        await tx.kbChunk.deleteMany({ where: { workspaceId, sourceType: "document", sourceId: documentId } });
        for (const c of chunks) {
          const vec = vectors.get(`${documentId}#${c.index}`);
          if (!vec) continue;
          await this.upsertDocChunk(tx, workspaceId, documentId, c.index, c.content, vec, model);
        }
        await tx.kbDocument.update({ where: { id: documentId }, data: { chunkCount: chunks.length } });
      });

      // 3) Metric (novelty = exact; answerability = held-out judge) + doc↔task links.
      const novelty = await this.novelty.compute(workspaceId, documentId);
      await this.links.linkDocument(workspaceId, documentId);
      const answerability = await this.answerability.compute(workspaceId, documentId);

      const metric: KbDocMetric = {
        novelty,
        answerability: answerability
          ? {
              provisional: answerability.provisional,
              questionSource: answerability.questionSource,
              questionCount: answerability.questionCount,
              answerableBefore: answerability.answerableBefore,
              answerableAfter: answerability.answerableAfter,
              newlyAnswerable: answerability.newlyAnswerable,
              regressions: answerability.regressions,
              questions: answerability.questions,
            }
          : null,
        computedAt: new Date().toISOString(),
      };

      await this.prisma.kbDocument.update({
        where: { id: documentId },
        data: { status: "ready", metric: metric as unknown as Prisma.InputJsonValue },
      });
      this.logger.log(`Document ${documentId} ready (${chunks.length} chunks, ${novelty.pctNovel * 100}% novel)`);
    } catch (err) {
      const message = (err as Error).message ?? "Unknown error";
      this.logger.error(`KB-docs ingest for ${documentId} failed: ${message}`);
      await this.markError(documentId, message);
      throw err;
    }
  }

  /** Raw upsert so the pgvector `embedding` column can be written (Prisma can't). */
  private async upsertDocChunk(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    documentId: string,
    chunkIndex: number,
    content: string,
    vec: number[],
    model: string,
  ): Promise<void> {
    const contentHash = createHash("sha256").update(content).digest("hex");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "meetsy"."KbChunk" (
        "id","workspaceId","sourceType","sourceId","chunkIndex","content","contentHash",
        "embedding","embeddingModel","embeddingDims","embeddingVersion","createdAt","updatedAt"
      ) VALUES (
        ${`kbc_${randomUUID()}`}, ${workspaceId}, 'document'::"meetsy"."KbSourceType", ${documentId}, ${chunkIndex},
        ${content}, ${contentHash}, ${toVectorLiteral(vec)}::public.vector,
        ${model}, ${EMBED_DIMS}, ${EMBED_VERSION}, now(), now()
      )
      ON CONFLICT ("workspaceId","sourceType","sourceId","chunkIndex") DO UPDATE SET
        "content" = EXCLUDED."content",
        "contentHash" = EXCLUDED."contentHash",
        "embedding" = EXCLUDED."embedding",
        "embeddingModel" = EXCLUDED."embeddingModel",
        "embeddingDims" = EXCLUDED."embeddingDims",
        "embeddingVersion" = EXCLUDED."embeddingVersion",
        "updatedAt" = now()
    `);
  }

  private async markError(documentId: string | undefined, message: string): Promise<void> {
    if (!documentId) return;
    await this.prisma.kbDocument
      .update({ where: { id: documentId }, data: { status: "error", error: message } })
      .catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
