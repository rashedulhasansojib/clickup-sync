import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AzureEmbeddingService } from "../azure/azure-embedding.service";
import { toVectorLiteral } from "./kb.processor";
import { rrfFuse } from "./rrf";

/** Source types retrievable from the KB. */
export type KbSourceTypeName = "clickup_task" | "transcript" | "document";

/** A raw KbChunk projection used by both hybrid branches; `sourceId` = RankedHit. */
interface RawHit {
  sourceType: string;
  sourceId: string;
  content: string;
  status: string | null;
  assignee: string | null;
  component: string | null;
  client: string | null;
  department: string | null;
  taskUpdatedAt: Date | null;
}

/** A retrieved context snippet with provenance (for pipeline injection + display). */
export interface KbContextHit {
  sourceType: KbSourceTypeName;
  sourceId: string;
  score: number;
  snippet: string;
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

  /**
   * Hybrid search over `clickup_task` chunks (the public KB search endpoint).
   * Behaviour unchanged from 2a — defaults to tasks only.
   */
  async search(workspaceId: string, query: string, k = 10): Promise<KbSearchHit[]> {
    const fused = await this.runHybrid(workspaceId, query, k, ["clickup_task"]);
    return fused.map((f) => ({
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

  /**
   * Retrieve context snippets WITH provenance, across the requested source types
   * (Phase 2c: tasks + uploaded documents). Used to ground the analysis pipeline;
   * the provenance is surfaced on the run so injected context is inspectable.
   */
  async retrieveContext(
    workspaceId: string,
    query: string,
    opts: { k?: number; sourceTypes?: KbSourceTypeName[] } = {},
  ): Promise<KbContextHit[]> {
    const k = opts.k ?? 8;
    const sourceTypes = opts.sourceTypes ?? ["clickup_task", "document"];
    if (!query.trim()) return [];
    const fused = await this.runHybrid(workspaceId, query, k, sourceTypes);
    return fused.map((f) => ({
      sourceType: f.hit.sourceType as KbSourceTypeName,
      sourceId: f.sourceId,
      score: f.score,
      snippet: f.hit.content.slice(0, SNIPPET_CHARS),
    }));
  }

  /**
   * Shared hybrid core: a pgvector cosine branch + a Postgres FTS branch, fused
   * by RRF (k=60), scoped to the workspace and the requested source types.
   *
   * `sourceTypes` is bound as a text[] and matched via `"sourceType"::text = ANY`.
   * The vector cast + operator are fully qualified (public.vector /
   * OPERATOR(public.<=>)) because MEETSY_DATABASE_URL pins the search_path to
   * meetsy; OPERATOR(public.<=>) is the same OID the HNSW index uses, so the
   * index is still chosen. SET LOCAL needs a transaction; iterative_scan keeps
   * recall up despite the workspace_id/sourceType predicates.
   */
  private async runHybrid(
    workspaceId: string,
    query: string,
    k: number,
    sourceTypes: KbSourceTypeName[],
  ): Promise<Array<{ sourceId: string; score: number; hit: RawHit }>> {
    const [vec] = await this.azure.embed(query, { dimensions: 1024 });
    const vecLit = toVectorLiteral(vec);
    const types = sourceTypes as string[];

    const vectorHits = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      return tx.$queryRaw<RawHit[]>(Prisma.sql`
        SELECT "sourceType"::text AS "sourceType", "sourceId", "content", "status", "assignee",
               "component", "client", "department", "taskUpdatedAt"
        FROM "meetsy"."KbChunk"
        WHERE "workspaceId" = ${workspaceId}
          AND "sourceType"::text = ANY(${types})
          AND "embedding" IS NOT NULL
        ORDER BY "embedding" OPERATOR(public.<=>) ${vecLit}::public.vector
        LIMIT ${BRANCH_LIMIT}
      `);
    });

    const keywordHits = await this.prisma.$queryRaw<RawHit[]>(Prisma.sql`
      SELECT "sourceType"::text AS "sourceType", "sourceId", "content", "status", "assignee",
             "component", "client", "department", "taskUpdatedAt"
      FROM "meetsy"."KbChunk"
      WHERE "workspaceId" = ${workspaceId}
        AND "sourceType"::text = ANY(${types})
        AND "tsv" @@ websearch_to_tsquery('english', ${query})
      ORDER BY ts_rank_cd("tsv", websearch_to_tsquery('english', ${query})) DESC
      LIMIT ${BRANCH_LIMIT}
    `);

    return rrfFuse<RawHit>([vectorHits, keywordHits], k).map((f) => ({
      sourceId: f.sourceId,
      score: f.score,
      hit: f.hit,
    }));
  }
}
