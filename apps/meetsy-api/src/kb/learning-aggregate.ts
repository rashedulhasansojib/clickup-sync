/**
 * Phase 3.2 — pure aggregation for the learning loop. Dependency-free so the gate,
 * the ORGANIC-only filter (anti-self-reinforcement), and the two honest metrics
 * are unit-testable without a DB.
 *
 * THE TWO TRAPS this guards (advisor):
 *  1. The raw override rate (predicted≠confirmed) measures KB/model quality, NOT
 *     the loop — an accepted nudge still reads as an override against the raw
 *     prediction. So we ALSO compute nudge-acceptance (of the nudges the loop
 *     actually showed, how many were accepted) — the only honest "loop helps".
 *  2. Every accepted nudge logs another P→C, which would strengthen the gate that
 *     produced it. So ONLY ORGANIC corrections (no nudge shown) count toward the
 *     gate — the loop cannot feed itself.
 */

/** One normalized per-field record derived from a FieldOverride row. */
export interface FieldRecord {
  /** The model's prediction P (null = abstained ⇒ not a correctable prediction). */
  predicted: string | null;
  /** The confirmed value C, resolved to a comparable name (null = absent/unresolved). */
  confirmed: string | null;
  /** True when confirmed had a raw value that did NOT resolve (a resolution miss, not sparse). */
  unresolved: boolean;
  /** What the loop showed at push time (null = no nudge ⇒ this correction is ORGANIC). */
  nudgeShown: string | null;
  /** Whether the user accepted the shown nudge (confirmed === nudgeShown). */
  nudgeAccepted: boolean;
}

export interface CorrectionStat {
  /** v2 Phase 3 — which learnable field this pattern applies to. */
  field: string;
  /** v2 Phase 3 — stable slug `base64url(field|predicted|confirmed)` used as a
   * URL path segment on `/learning/patterns/:key/history`. Deterministic;
   * clients never construct it — the API is the source of truth. */
  key: string;
  predicted: string;
  confirmed: string;
  count: number;
  /** count / total organic corrections of `predicted`, 0..1. */
  agreement: number;
  gatePassed: boolean;
}

export interface FieldAggregate {
  corrections: CorrectionStat[];
  /** Raw-model override rate = KB-quality proxy (predicted≠confirmed). */
  rawOverrideRate: number | null;
  rawSample: number;
  /** Nudge-acceptance rate = the loop's ACTUAL effectiveness. */
  nudgeAcceptanceRate: number | null;
  nudgeSample: number;
  /** Confirmed values that failed to resolve (surfaced so a resolution bug ≠ "sparse"). */
  unresolved: number;
}

export const MIN_CORRECTIONS = 3;
export const MIN_AGREEMENT = 0.6;
/** v2 Phase 3 — how many corrections before the gate is one short. When a
 * pattern's organic count crosses this threshold we publish a near-gate SSE
 * event so the UI can toast "one more correction and this will start nudging."
 */
export const NEAR_GATE_THRESHOLD = MIN_CORRECTIONS - 1;

/** v2 Phase 3 — stable, URL-safe slug identifying a pattern. Used as a path
 * segment on `/learning/patterns/:key/history`. The `|` separator is safe
 * (base64url doesn't emit it) and preserves the boundaries even when
 * predicted/confirmed contain characters like `/` (sprint names). */
export function patternKey(field: string, predicted: string, confirmed: string): string {
  const raw = `${field}|${predicted}|${confirmed}`;
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Inverse of `patternKey` — throws on malformed input so a bad URL 400s. */
export function decodePatternKey(
  key: string,
): { field: string; predicted: string; confirmed: string } {
  const b64 = key.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const raw = Buffer.from(b64 + pad, "base64").toString("utf8");
  const parts = raw.split("|");
  if (parts.length !== 3) {
    throw new Error(`Malformed pattern key: expected 3 parts, got ${parts.length}`);
  }
  return { field: parts[0], predicted: parts[1], confirmed: parts[2] };
}

export function aggregateField(field: string, records: FieldRecord[]): FieldAggregate {
  let rawSample = 0;
  let rawOverrides = 0;
  let nudgeSample = 0;
  let nudgeAccepted = 0;
  let unresolved = 0;
  // organic corrections: predicted P → { confirmed C → count }
  const byPredicted = new Map<string, Map<string, number>>();

  for (const r of records) {
    if (r.unresolved) unresolved += 1;
    if (r.nudgeShown !== null) {
      nudgeSample += 1;
      if (r.nudgeAccepted) nudgeAccepted += 1;
    }
    if (r.predicted === null) continue; // abstain ⇒ nothing to override/correct
    rawSample += 1;
    if (r.confirmed !== null && r.confirmed !== r.predicted) {
      rawOverrides += 1;
      // ORGANIC only (no nudge shown) → eligible to teach the gate.
      if (r.nudgeShown === null) {
        const inner = byPredicted.get(r.predicted) ?? new Map<string, number>();
        inner.set(r.confirmed, (inner.get(r.confirmed) ?? 0) + 1);
        byPredicted.set(r.predicted, inner);
      }
    }
  }

  const corrections: CorrectionStat[] = [];
  for (const [predicted, inner] of byPredicted) {
    const total = [...inner.values()].reduce((a, b) => a + b, 0);
    for (const [confirmed, count] of inner) {
      const agreement = round3(count / total);
      corrections.push({
        field,
        key: patternKey(field, predicted, confirmed),
        predicted,
        confirmed,
        count,
        agreement,
        gatePassed: count >= MIN_CORRECTIONS && agreement >= MIN_AGREEMENT,
      });
    }
  }
  corrections.sort((a, b) => b.count - a.count);

  return {
    corrections,
    rawOverrideRate: rawSample > 0 ? round3(rawOverrides / rawSample) : null,
    rawSample,
    nudgeAcceptanceRate: nudgeSample > 0 ? round3(nudgeAccepted / nudgeSample) : null,
    nudgeSample,
    unresolved,
  };
}

/** The gated organic correction to apply for a fresh prediction P (or null). */
export function nudgeFor(agg: FieldAggregate, predicted: string | null): CorrectionStat | null {
  if (!predicted) return null;
  return (
    agg.corrections
      .filter((c) => c.predicted === predicted && c.gatePassed)
      .sort((a, b) => b.count - a.count)[0] ?? null
  );
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
