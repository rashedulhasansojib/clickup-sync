import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Doc↔task auto-linking: after a document is embedded, discover which EXISTING
 * ClickUp tasks it relates to (the seed for 2c context injection). For each doc
 * chunk we take its nearest task chunks (HNSW-indexed cosine), then aggregate the
 * BEST similarity per task across the doc's chunks and persist the top-N links.
 *
 * Per-chunk indexed queries (ORDER BY <-> LIMIT k) keep this scalable — the HNSW
 * index is used per chunk, vs a doc×task cross-join which would seq-scan. Links
 * are plain `taskId` strings (soft ref to public.clickup_tasks; no FK/no write).
 */
export interface DocTaskLink {
  taskId: string;
  score: number;
}

/** Minimum cosine similarity for a doc↔task link to be recorded. */
export const LINK_MIN_SIM = 0.75;
/** Nearest task chunks fetched per doc chunk before aggregating. */
const PER_CHUNK_K = 10;
/** Max links persisted per document. */
const TOP_N_LINKS = 20;

@Injectable()
export class DocTaskLinkService {
  constructor(private readonly prisma: PrismaService) {}

  /** Compute + persist the doc's task links; returns what was written. */
  async linkDocument(workspaceId: string, documentId: string): Promise<DocTaskLink[]> {
    // Best similarity per task across ALL of the doc's chunks, in one query.
    // The lateral join takes each doc chunk's K nearest task chunks (index-assisted),
    // then we MAX the similarity (= 1 − distance) per task.
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      return tx.$queryRaw<Array<{ task_id: string; sim: number }>>(Prisma.sql`
        SELECT n."sourceId" AS task_id, MAX(1 - n.dist) AS sim
        FROM "meetsy"."KbChunk" d
        CROSS JOIN LATERAL (
          SELECT t."sourceId",
                 (d."embedding" OPERATOR(public.<=>) t."embedding") AS dist
          FROM "meetsy"."KbChunk" t
          WHERE t."workspaceId" = ${workspaceId}
            AND t."sourceType" = 'clickup_task'::"meetsy"."KbSourceType"
            AND t."embedding" IS NOT NULL
          ORDER BY t."embedding" OPERATOR(public.<=>) d."embedding"
          LIMIT ${PER_CHUNK_K}
        ) n
        WHERE d."workspaceId" = ${workspaceId}
          AND d."sourceType" = 'document'::"meetsy"."KbSourceType"
          AND d."sourceId" = ${documentId}
          AND d."embedding" IS NOT NULL
        GROUP BY n."sourceId"
        HAVING MAX(1 - n.dist) >= ${LINK_MIN_SIM}
        ORDER BY sim DESC
        LIMIT ${TOP_N_LINKS}
      `);
    });

    const links: DocTaskLink[] = rows.map((r) => ({ taskId: r.task_id, score: round3(r.sim) }));

    // Replace the doc's links idempotently.
    await this.prisma.$transaction([
      this.prisma.kbDocTaskLink.deleteMany({ where: { documentId } }),
      this.prisma.kbDocTaskLink.createMany({
        data: links.map((l) => ({ workspaceId, documentId, taskId: l.taskId, score: l.score })),
        skipDuplicates: true,
      }),
    ]);

    return links;
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
