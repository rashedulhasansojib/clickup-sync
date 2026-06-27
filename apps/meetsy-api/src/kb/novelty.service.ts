import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Corpus-novelty: how much genuinely NEW information a document adds vs what the
 * KB already contains. Exact, pgvector-only (no LLM, no hallucination) — the
 * "solid headline" half of the Phase-2b improvement metric (see the 2b spec §3a).
 *
 * For each chunk of the document, we find its nearest EXISTING chunk (any source
 * EXCEPT this same document) by cosine distance. pgvector `<=>` returns cosine
 * DISTANCE = 1 − cosine similarity, so the distance to the nearest neighbour IS
 * the chunk's novelty directly (novelty = 1 − maxSimilarity = minDistance).
 */
export interface NoveltyResult {
  /** Doc chunks scored. */
  chunkCount: number;
  /** Chunks whose nearest existing neighbour is far enough to count as "new". */
  novelChunkCount: number;
  /** novelChunkCount / chunkCount, 0..1 — the headline ("X% is new"). */
  pctNovel: number;
  /** Median per-chunk novelty (0..1). */
  medianNovelty: number;
  /** How many existing KB chunks the doc was compared against (context). */
  comparedAgainst: number;
}

/** A chunk is "novel" when its best similarity to the existing KB is below this. */
export const NOVEL_MAXSIM_CUTOFF = 0.6;

@Injectable()
export class NoveltyService {
  constructor(private readonly prisma: PrismaService) {}

  async compute(workspaceId: string, documentId: string): Promise<NoveltyResult> {
    // Per doc chunk: the cosine DISTANCE to its nearest existing neighbour that is
    // NOT part of this same document. NULL when the KB has no other chunks yet.
    const rows = await this.prisma.$queryRaw<Array<{ min_dist: number | null }>>(Prisma.sql`
      SELECT (
        SELECT MIN(d."embedding" OPERATOR(public.<=>) e."embedding")
        FROM "meetsy"."KbChunk" e
        WHERE e."workspaceId" = ${workspaceId}
          AND e."embedding" IS NOT NULL
          AND e."id" <> d."id"
          AND NOT (e."sourceType" = 'document'::"meetsy"."KbSourceType" AND e."sourceId" = ${documentId})
      ) AS min_dist
      FROM "meetsy"."KbChunk" d
      WHERE d."workspaceId" = ${workspaceId}
        AND d."sourceType" = 'document'::"meetsy"."KbSourceType"
        AND d."sourceId" = ${documentId}
        AND d."embedding" IS NOT NULL
    `);

    // Existing chunks the doc was compared against (embeddings are always set in
    // practice; the Unsupported vector column can't be filtered via Prisma).
    const countExisting = await this.prisma.kbChunk.count({
      where: { workspaceId, NOT: { sourceType: "document", sourceId: documentId } },
    });

    const chunkCount = rows.length;
    if (chunkCount === 0) {
      return { chunkCount: 0, novelChunkCount: 0, pctNovel: 0, medianNovelty: 0, comparedAgainst: countExisting };
    }

    // novelty = minDistance; a NULL neighbour (empty KB) ⇒ fully novel (1.0).
    const novelties = rows.map((r) => (r.min_dist == null ? 1 : clamp01(r.min_dist)));
    const novelChunkCount = novelties.filter((n) => 1 - n < NOVEL_MAXSIM_CUTOFF).length;

    return {
      chunkCount,
      novelChunkCount,
      pctNovel: round3(novelChunkCount / chunkCount),
      medianNovelty: round3(median(novelties)),
      comparedAgainst: countExisting,
    };
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
