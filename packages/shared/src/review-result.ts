import { z } from "zod";
import { AnalysisResultSchema } from "./domain";

/**
 * Phase 2c/3 review-UI signal keys attached to the stored AnalysisRun result by
 * the pipeline (kbContext, fieldPredictions, duplicates, assignment, adjustments).
 *
 * These schemas are the SINGLE SOURCE OF TRUTH for the shape of `run.result`
 * end-to-end: the API validates writes with them, the web app derives its types
 * from them. Before v2 Phase 0, these keys survived to `GET /runs/:id` only via
 * `AnalysisResultSchema.passthrough()` widening; feedback + chat mutations would
 * silently strip them because `loadRunContext` ran plain `.parse()`, and the
 * web app kept a locally-declared `ReviewResult` interface with all fields
 * optional (any missing field just disappeared from the UI).
 *
 * All five signal keys are OPTIONAL — historical runs from v1 Phases 0–3 may
 * lack any subset.
 */

// ── KB grounding (top-K hybrid retrieval hits) ─────────────────────────────
export const KbSourceType = z.enum(["clickup_task", "transcript", "document"]);
export type KbSourceType = z.infer<typeof KbSourceType>;

export const KbContextHitSchema = z.object({
  sourceType: KbSourceType,
  sourceId: z.string(),
  score: z.number(),
  snippet: z.string(),
});
export type KbContextHit = z.infer<typeof KbContextHitSchema>;

// ── Field prediction (sprint / assigneeHint / estimate) ────────────────────
export const PriorCandidateSchema = z.object({
  value: z.string(),
  support: z.number().int().nonnegative(),
  /** Similarity-weighted share of this value over qualifying neighbours, 0..1. */
  share: z.number().min(0).max(1),
});
export type PriorCandidate = z.infer<typeof PriorCandidateSchema>;

export const FieldPredictionSchema = z.object({
  value: z.string().nullable(),
  abstain: z.boolean(),
  support: z.number().int().nonnegative(),
  /** The picked value's true similarity-weighted share (NOT zeroed for minority picks). */
  share: z.number().min(0).max(1),
  /** Whether the picked value is the statistical mode (false ⇒ LLM clamp chose a minority). */
  isModal: z.boolean(),
  confidence: z.enum(["high", "low"]),
  candidates: z.array(PriorCandidateSchema),
  reason: z.string().optional(),
});
export type FieldPrediction = z.infer<typeof FieldPredictionSchema>;

export const DuePredictionSchema = z.object({
  /** YYYY-MM-DD or null. */
  date: z.string().nullable(),
  abstain: z.boolean(),
  basedOnClosedTasks: z.number().int().nonnegative(),
  cycleDaysP80: z.number().nullable(),
});
export type DuePrediction = z.infer<typeof DuePredictionSchema>;

export const TaskPredictionSchema = z.object({
  sprint: FieldPredictionSchema,
  /** Soft hint only; confident assignment lives in `assignment`. */
  assigneeHint: FieldPredictionSchema,
  estimate: FieldPredictionSchema,
  due: DuePredictionSchema,
  qualifyingNeighbours: z.number().int().nonnegative(),
});
export type TaskPrediction = z.infer<typeof TaskPredictionSchema>;

// ── Duplicate detection (empirically-calibrated 0.72 flag / 0.64 suggest) ──
export const DupBand = z.enum(["flag", "suggest"]);
export type DupBand = z.infer<typeof DupBand>;

export const DuplicateHitSchema = z.object({
  taskId: z.string(),
  score: z.number(),
  band: DupBand,
});
export type DuplicateHit = z.infer<typeof DuplicateHitSchema>;

// ── Smart-assign (ownership precedent ranking) ─────────────────────────────
export const AssignmentCandidateSchema = z.object({
  /** null when the historical owner is NOT in the workspace's assignable pool. */
  clickupUserId: z.string().nullable(),
  name: z.string(),
  inPool: z.boolean(),
  ownershipScore: z.number(),
  closedSimilar: z.number().int().nonnegative(),
  openTasks: z.number().int().nonnegative(),
  trackedHours30d: z.number(),
  evidenceTaskIds: z.array(z.string()),
});
export type AssignmentCandidate = z.infer<typeof AssignmentCandidateSchema>;

export const TaskAssignmentSchema = z.object({
  /** Top IN-POOL owner, or null when abstaining (thin history / no pool match). */
  recommended: AssignmentCandidateSchema.nullable(),
  ranked: z.array(AssignmentCandidateSchema),
  abstain: z.boolean(),
  conditionedOnClient: z.boolean(),
  rationale: z.string(),
});
export type TaskAssignment = z.infer<typeof TaskAssignmentSchema>;

// ── Learning-loop nudge (Phase 3.2) ────────────────────────────────────────
export const FieldAdjustmentSchema = z.object({
  from: z.string(),
  to: z.string(),
  count: z.number().int().nonnegative(),
  agreement: z.number().min(0).max(1),
});
export type FieldAdjustment = z.infer<typeof FieldAdjustmentSchema>;

export const TaskAdjustmentsSchema = z.object({
  assignee: FieldAdjustmentSchema.optional(),
  /** Reserved for v2 Phase 3 — learning loop expands to include sprint. */
  sprint: FieldAdjustmentSchema.optional(),
});
export type TaskAdjustments = z.infer<typeof TaskAdjustmentsSchema>;

// ── The full review-result contract ────────────────────────────────────────
/**
 * The persisted shape of `AnalysisRun.result` when a run has completed with the
 * v2c/3 pipeline. Extends AnalysisResult with the five signal keys; every key
 * is optional so historical runs (or runs whose stages abstained) still parse.
 */
export const ReviewResultSchema = AnalysisResultSchema.extend({
  kbContext: z.array(KbContextHitSchema).optional(),
  fieldPredictions: z.record(z.string(), TaskPredictionSchema).optional(),
  duplicates: z.record(z.string(), z.array(DuplicateHitSchema)).optional(),
  assignment: z.record(z.string(), TaskAssignmentSchema).optional(),
  adjustments: z.record(z.string(), TaskAdjustmentsSchema).optional(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/**
 * The five signal keys as a picked type — used by mergeSignals() in the API
 * layer to re-attach evidence after a strict AnalysisResult re-assembly.
 */
export type ReviewSignals = Pick<
  ReviewResult,
  "kbContext" | "fieldPredictions" | "duplicates" | "assignment" | "adjustments"
>;
