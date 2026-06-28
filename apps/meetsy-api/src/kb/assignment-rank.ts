import { qualifying, SIM_FLOOR, type Neighbour } from "./prediction-prior";

/**
 * Phase 3.1 — pure owner-ranking from kNN neighbours. Kept dependency-free so the
 * echo-breaker (client/area conditioning) and the closed>open weighting are
 * unit-testable without a DB.
 *
 * THE ECHO-TRAP (assignment edition): a task's qualifying neighbours mix areas
 * (e.g. an AIT task pulls Nifty-AI neighbours too), and a prolific cross-area
 * owner can out-score the true area owner. The floor doesn't fix that. So when
 * 2c.2 predicted a client/area for the task, we CONDITION ownership on neighbours
 * of that same client — the minority-area owner then wins cleanly. With no client
 * prediction we fall back to all qualifying neighbours.
 */
export interface OwnerAgg {
  name: string;
  /** Similarity-weighted ownership score (closed precedent weighs more), 0..1. */
  score: number;
  /** How many CLOSED similar tasks this owner completed (precedent strength). */
  closedSimilar: number;
  /** The neighbour task ids this owner owned (evidence). */
  evidenceTaskIds: string[];
}

export interface OwnerRanking {
  owners: OwnerAgg[];
  /** True when ownership was conditioned on the predicted client (echo-broken). */
  conditionedOnClient: boolean;
  /** Qualifying neighbours considered (after the floor + any client conditioning). */
  consideredCount: number;
}

/** A completed task is stronger precedent than an open one. */
const CLOSED_WEIGHT = 2;

export function rankOwners(neighbours: Neighbour[], predictedClient: string | null): OwnerRanking {
  const quali = qualifying(neighbours); // sim >= SIM_FLOOR
  let considered = quali;
  let conditionedOnClient = false;
  if (predictedClient) {
    const sameArea = quali.filter((n) => n.client === predictedClient);
    if (sameArea.length > 0) {
      considered = sameArea;
      conditionedOnClient = true;
    }
  }

  const byOwner = new Map<string, OwnerAgg>();
  let totalWeight = 0;
  for (const n of considered) {
    const name = n.assignee?.trim();
    if (!name) continue;
    const w = n.sim * (n.closedDate ? CLOSED_WEIGHT : 1);
    totalWeight += w;
    const agg = byOwner.get(name) ?? { name, score: 0, closedSimilar: 0, evidenceTaskIds: [] };
    agg.score += w;
    if (n.closedDate) agg.closedSimilar += 1;
    if (agg.evidenceTaskIds.length < 5) agg.evidenceTaskIds.push(n.taskId);
    byOwner.set(name, agg);
  }

  const owners = [...byOwner.values()]
    .map((o) => ({ ...o, score: totalWeight > 0 ? round3(o.score / totalWeight) : 0 }))
    .sort((a, b) => b.score - a.score);

  return { owners, conditionedOnClient, consideredCount: considered.length };
}

export { SIM_FLOOR };

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
