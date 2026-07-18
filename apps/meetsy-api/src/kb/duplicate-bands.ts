/**
 * Phase 2c.2 — duplicate-detection bands (pure). Classifies an extracted task
 * against existing tasks by raw cosine similarity. NEVER auto-merges / never
 * auto-skips a push — purely advisory flags surfaced on the run.
 *
 * Bands are EMPIRICALLY calibrated for this regime, not taken on faith. A new
 * extracted task's card is necessarily SPARSER than a stored card (it has no
 * status/client/list/assignee yet), so even a near-verbatim duplicate peaks well
 * below 1.0: live calibration on real Nifty data showed a re-extraction of an
 * existing task scoring ~0.73 against that exact task (the #1 hit), with the next
 * DISTINCT task at ~0.69. So the spec's 0.90/0.82 would never fire. Bands are set
 * just under the observed duplicate peak. NOTE: this corpus is dense (everything
 * is 0.6–0.75 similar), so the dup/related boundary is inherently fuzzy — these
 * are corpus-tuned; a richer query card or per-workspace calibration is a follow-up.
 */
export type DupBand = "flag" | "suggest";

/** ≥ this raw cosine ⇒ very likely already exists (just under the ~0.73 dup peak). */
export const DUP_FLAG = 0.72;
/** ≥ this (and < flag) ⇒ possibly related. */
export const DUP_SUGGEST = 0.64;

export interface DuplicateHit {
  taskId: string;
  score: number;
  band: DupBand;
}

/**
 * v2 Phase 5 — per-call band overrides. When omitted, falls back to the
 * module-level constants above so existing callers keep working. The Phase-5
 * pipeline call-site (FieldPredictionService) reads `WorkspaceMlConfig.tunables`
 * and passes `{ dupFlag, dupSuggest }` here; the /tuning preview endpoint
 * passes candidate bands to compute deltas.
 */
export interface DuplicateBands {
  dupFlag: number;
  dupSuggest: number;
}

/** Classify the nearest existing tasks into flag/suggest; drop the rest. */
export function classifyDuplicates(
  neighbours: Array<{ taskId: string; sim: number }>,
  bands: DuplicateBands = { dupFlag: DUP_FLAG, dupSuggest: DUP_SUGGEST },
  max = 3,
): DuplicateHit[] {
  return neighbours
    .filter((n) => n.sim >= bands.dupSuggest)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, max)
    .map((n) => ({
      taskId: n.taskId,
      score: Math.round(n.sim * 1000) / 1000,
      band: n.sim >= bands.dupFlag ? "flag" : "suggest",
    }));
}
