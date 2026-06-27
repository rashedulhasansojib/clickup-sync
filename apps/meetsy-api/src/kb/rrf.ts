/**
 * Reciprocal Rank Fusion — fuse two (or more) independently-ranked result lists
 * into one. A document's fused score is Σ 1/(k + rank), where `rank` is its
 * 1-based position in each list it appears in. The constant k (60, the standard)
 * damps the influence of any single list's top ranks.
 *
 * Pure + deterministic so it can be unit-tested without pgvector.
 */
export const RRF_K = 60;

export interface RankedHit {
  /** The dedupe key across lists (here: the ClickUp task_id / chunk sourceId). */
  sourceId: string;
}

export interface FusedHit<T extends RankedHit> {
  sourceId: string;
  score: number;
  /** The richest record seen for this sourceId across the input lists. */
  hit: T;
}

/**
 * Fuse ranked lists (each already ordered best-first) via RRF.
 * Ties in fused score break by `sourceId` ascending for a stable, deterministic
 * order. Returns at most `topK` fused hits.
 */
export function rrfFuse<T extends RankedHit>(
  lists: T[][],
  topK: number,
  k: number = RRF_K,
): FusedHit<T>[] {
  const scores = new Map<string, number>();
  const records = new Map<string, T>();

  for (const list of lists) {
    list.forEach((hit, idx) => {
      const rank = idx + 1; // 1-based
      scores.set(hit.sourceId, (scores.get(hit.sourceId) ?? 0) + 1 / (k + rank));
      if (!records.has(hit.sourceId)) records.set(hit.sourceId, hit);
    });
  }

  return [...scores.entries()]
    .map(([sourceId, score]) => ({ sourceId, score, hit: records.get(sourceId)! }))
    .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId))
    .slice(0, topK);
}
