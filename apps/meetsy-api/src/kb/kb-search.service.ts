import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AzureEmbeddingService } from "../azure/azure-embedding.service";
import { toVectorLiteral } from "./kb.processor";
import { rrfFuse } from "./rrf";

/** A raw KbChunk projection used by both hybrid branches; `sourceId` = RankedHit. */
interface RawHit {
  sourceId: string;
  content: string;
  status: string | null;
  assignee: string | null;
  component: string | null;
  client: string | null;
  department: string | null;
  taskUpdatedAt: Date | null;
}

export interface KbSearchHit {
  sourceId: string;
  score: number;
  snippet: string;
  metadata: {
    status: string | null;
    assignee: string | null;
    component: string | null;
    client: string | null;
    department: string | null;
    taskUpdatedAt: string | null;
  };
}

const BRANCH_LIMIT = 50;
const SNIPPET_CHARS = 300;

/**
 * Hybrid retrieval over `kb_chunk`: a pgvector cosine branch and a Postgres FTS
 * branch, fused by Reciprocal Rank Fusion (k=60). Workspace-scoped.
 *
 * Both branches run via `$queryRaw` (pgvector ops + tsvector aren't in Prisma's
 * query builder). The query vector is bound as a text param and cast `::vector`.
 * NOTE: the raw SQL paths can't be unit-tested without a live pgvector DB — they
 * are exercised in the orchestrator's live verification; `rrfFuse` is unit-tested.
 */
@Injectable()
export class KbSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly azure: AzureEmbeddingService,
  ) {}

  async search(workspaceId: string, query: string, k = 10): Promise<KbSearchHit[]> {
    const [vec] = await this.azure.embed(query, { dimensions: 1024 });
    const vecLit = toVectorLiteral(vec);

    // ── Vector branch ──────────────────────────────────────────────────────
    // SET LOCAL needs a transaction. hnsw.iterative_scan=relaxed_order keeps
    // recall up despite the workspace_id predicate filtering the shared HNSW index.
    // The cast + operator are fully qualified (public.vector / OPERATOR(public.<=>))
    // because MEETSY_DATABASE_URL pins the connection search_path to meetsy, which
    // would otherwise hide pgvector's public type/operator. OPERATOR(public.<=>) is
    // the same OID the HNSW index uses, so the index is still chosen.
    const vectorHits = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      return tx.$queryRaw<RawHit[]>(Prisma.sql`
        SELECT "sourceId", "content", "status", "assignee", "component", "client",
               "department", "taskUpdatedAt"
        FROM "meetsy"."KbChunk"
        WHERE "workspaceId" = ${workspaceId}
          AND "sourceType" = 'clickup_task'::"meetsy"."KbSourceType"
          AND "embedding" IS NOT NULL
        ORDER BY "embedding" OPERATOR(public.<=>) ${vecLit}::public.vector
        LIMIT ${BRANCH_LIMIT}
      `);
    });

    // ── Keyword branch ─────────────────────────────────────────────────────
    const keywordHits = await this.prisma.$queryRaw<RawHit[]>(Prisma.sql`
      SELECT "sourceId", "content", "status", "assignee", "component", "client",
             "department", "taskUpdatedAt"
      FROM "meetsy"."KbChunk"
      WHERE "workspaceId" = ${workspaceId}
        AND "sourceType" = 'clickup_task'::"meetsy"."KbSourceType"
        AND "tsv" @@ websearch_to_tsquery('english', ${query})
      ORDER BY ts_rank_cd("tsv", websearch_to_tsquery('english', ${query})) DESC
      LIMIT ${BRANCH_LIMIT}
    `);

    // ── Fuse (RRF k=60) ────────────────────────────────────────────────────
    return rrfFuse<RawHit>([vectorHits, keywordHits], k).map((f) => ({
      sourceId: f.sourceId,
      score: f.score,
      snippet: f.hit.content.slice(0, SNIPPET_CHARS),
      metadata: {
        status: f.hit.status,
        assignee: f.hit.assignee,
        component: f.hit.component,
        client: f.hit.client,
        department: f.hit.department,
        taskUpdatedAt: f.hit.taskUpdatedAt ? f.hit.taskUpdatedAt.toISOString() : null,
      },
    }));
  }
}
