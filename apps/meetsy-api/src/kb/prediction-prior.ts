/**
 * Phase 2c.2 — pure helpers for kNN field priors. Kept dependency-free so the
 * echo-trap guards (similarity floor + thin-history abstain) and the percentile
 * cycle-time math are unit-testable without a DB/LLM.
 *
 * THE ECHO TRAP (why the floor matters): this corpus is dominated by a couple of
 * clients and embeddings have a high similarity floor, so a plain kNN always
 * returns K neighbours and modal-of-K just echoes the corpus base rate. We only
 * count neighbours ABOVE a cosine floor, so a task with no genuinely-similar
 * history has too few qualifying neighbours and honestly abstains.
 */

/** A historical task neighbour with its raw cosine similarity to the query card. */
export interface Neighbour {
  taskId: string;
  sim: number;
  client: string | null;
  sprint: string | null;
  assignee: string | null;
  estimation: string | null;
  createdDate: Date | null;
  closedDate: Date | null;
}

export interface PriorCandidate {
  value: string;
  support: number;
}

export interface PriorResult {
  /** The statistical modal value (similarity-weighted). */
  top: string;
  /** Count of qualifying neighbours carrying `top`. */
  support: number;
  /** Weight share of `top` over all qualifying neighbours with a value, 0..1. */
  share: number;
  /** Distinct candidate values (the LLM clamp may pick ONLY among these). */
  candidates: PriorCandidate[];
}

/** Neighbours below this cosine are treated as noise (not genuinely similar). */
export const SIM_FLOOR = 0.5;
/** Fewer than this many QUALIFYING neighbours ⇒ thin history ⇒ abstain. */
export const MIN_QUALIFYING = 3;

/** Neighbours that clear the similarity floor (the only ones we reason over). */
export function qualifying(neighbours: Neighbour[]): Neighbour[] {
  return neighbours.filter((n) => n.sim >= SIM_FLOOR);
}

/**
 * Similarity-weighted modal prior over a field. Returns null when no qualifying
 * neighbour has a value for the field. `support`/`share` come from the
 * DISTRIBUTION (never an LLM self-assertion) so confidence stays honest.
 */
export function aggregatePrior(quali: Neighbour[], pick: (n: Neighbour) => string | null): PriorResult | null {
  const weightByValue = new Map<string, number>();
  const countByValue = new Map<string, number>();
  let totalWeight = 0;
  for (const n of quali) {
    const v = pick(n)?.trim();
    if (!v) continue;
    weightByValue.set(v, (weightByValue.get(v) ?? 0) + n.sim);
    countByValue.set(v, (countByValue.get(v) ?? 0) + 1);
    totalWeight += n.sim;
  }
  if (totalWeight === 0) return null;
  const candidates = [...countByValue.entries()]
    .map(([value, support]) => ({ value, support }))
    .sort((a, b) => b.support - a.support);
  let top = "";
  let topWeight = -1;
  for (const [value, w] of weightByValue) {
    if (w > topWeight) {
      topWeight = w;
      top = value;
    }
  }
  return {
    top,
    support: countByValue.get(top) ?? 0,
    share: round3(topWeight / totalWeight),
    candidates,
  };
}

/**
 * Cycle-time percentile (days) over CLOSED qualifying neighbours. Returns null
 * when fewer than MIN_QUALIFYING have both created+closed dates — so a due-date
 * is only suggested when there's real precedent. Anchors on p80 by default
 * (this workspace's median cycle is ~0 — p50 would say "due today"; see 2a.1).
 */
export function cycleDaysPercentile(quali: Neighbour[], p = 0.8): number | null {
  const days = quali
    .filter((n) => n.createdDate && n.closedDate)
    .map((n) => (n.closedDate!.getTime() - n.createdDate!.getTime()) / 86_400_000)
    .filter((d) => d >= 0)
    .sort((a, b) => a - b);
  if (days.length < MIN_QUALIFYING) return null;
  const idx = Math.min(days.length - 1, Math.max(0, Math.ceil(p * days.length) - 1));
  return round1(days[idx]);
}

/** First assignee from a comma-joined `assignees_names`. */
export function firstAssignee(names: string | null): string | null {
  if (!names) return null;
  const first = names.split(",")[0]?.trim();
  return first || null;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
