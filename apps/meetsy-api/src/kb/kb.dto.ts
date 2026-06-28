import { z } from "zod";

/** Onboarding window presets. `all` = embed the entire mirrored history. */
export const KbRangeSchema = z.enum(["3m", "6m", "12m", "24m", "36m", "all"]);
export type KbRange = z.infer<typeof KbRangeSchema>;

/**
 * Optional per-onboarding scope filter. Every axis is optional; an absent (or
 * empty) axis means "no sub-filter on that dimension". Axes AND together.
 * - `spaceIds`   → ClickUp space ids (also narrows the backfill coverage step)
 * - `folderNames`→ ClickUp folder NAMES (there is no folder_id on the mirror)
 * - `listIds`    → ClickUp list ids (a sprint is a list, so it folds in here)
 * - `clients`    → resolved client option NAME strings
 */
export const KbScopeSchema = z.object({
  spaceIds: z.array(z.string()).optional(),
  folderNames: z.array(z.string()).optional(),
  listIds: z.array(z.string()).optional(),
  clients: z.array(z.string()).optional(),
});
export type KbScope = z.infer<typeof KbScopeSchema>;

export const OnboardSchema = z.object({
  range: KbRangeSchema.default("3m"),
  scope: KbScopeSchema.optional(),
});
export type OnboardDto = z.infer<typeof OnboardSchema>;

/** `all` maps to a very wide window (≈100y) so the same cursor logic applies. */
const ALL_DAYS = 36_500;

const RANGE_DAYS: Record<KbRange, number> = {
  "3m": 90,
  "6m": 180,
  "12m": 365,
  "24m": 730,
  "36m": 1095,
  all: ALL_DAYS,
};

/** Pure preset → lookback-days. Unit-tested. */
export function lookbackDaysForRange(range: KbRange): number {
  return RANGE_DAYS[range];
}

/** The window start for a first-run scan: now − lookbackDays. */
export function windowStart(range: KbRange, now: Date = new Date()): Date {
  return new Date(now.getTime() - lookbackDaysForRange(range) * 24 * 60 * 60 * 1000);
}

/**
 * Coverage gap decision (pure, unit-tested): is the already-mirrored window
 * narrower than what onboarding requested? `mirroredDays` is the widest backfill
 * lookback Clicksy has completed for the space (0 / null = nothing mirrored yet).
 * A small slack avoids re-triggering on day-boundary rounding.
 */
export function hasCoverageGap(
  requestedDays: number,
  mirroredDays: number | null | undefined,
  slackDays = 1,
): boolean {
  return (mirroredDays ?? 0) + slackDays < requestedDays;
}
