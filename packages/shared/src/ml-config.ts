import { z } from "zod";

/**
 * Per-workspace ML tunables + model routing — the persisted shape of
 * `WorkspaceMlConfig.tunables` / `.models`, and the frozen snapshot payload of
 * `AnalysisRunSnapshot.tunables` / `.models` (v2 Phase 0).
 *
 * Every tunable has a Zod default that mirrors today's in-code constants so a
 * missing/partial DB row falls back to the current behavior verbatim. Phase 5
 * consumes this (Preview replay + `/tuning` UI); Phase 0 only writes.
 *
 * Sources for the defaults (kept in one place: `kb/ml-config.defaults.ts`):
 *   - dupFlag / dupSuggest — src/kb/duplicate-bands.ts:19-21
 *   - simFloor / minQualifying — src/kb/prediction-prior.ts:44-46
 *   - minCorrections / minAgreement — src/kb/learning-aggregate.ts:51-52
 *   - rrfK — src/kb/rrf.ts:9
 *   - closedWeight — src/kb/assignment-rank.ts (weight applied on closed neighbours)
 *   - novelMaxSimCutoff — src/kb/novelty.service.ts
 *   - linkMinSim — src/kb/doc-task-link.service.ts
 *   - embedBatch — src/kb/kb.processor.ts default batch size
 */

// ── Tunables ──────────────────────────────────────────────────────────────
export const WorkspaceTunablesSchema = z.object({
  /** Duplicate detection — ≥ this cosine flags a hard duplicate. */
  dupFlag: z.number().min(0).max(1).default(0.72),
  /** Duplicate detection — ≥ this (but < dupFlag) suggests a soft duplicate. */
  dupSuggest: z.number().min(0).max(1).default(0.64),
  /** Neighbours below this cosine are treated as noise (not similar). */
  simFloor: z.number().min(0).max(1).default(0.5),
  /** Fewer than this many qualifying neighbours ⇒ thin history ⇒ abstain. */
  minQualifying: z.number().int().positive().default(3),
  /** Closed-precedent weight vs open in the assignment ranking. */
  closedWeight: z.number().positive().default(2),
  /** Minimum organic corrections before the learning loop nudges a field. */
  minCorrections: z.number().int().positive().default(3),
  /** Minimum agreement rate on those corrections before nudging. */
  minAgreement: z.number().min(0).max(1).default(0.6),
  /** RRF constant k (60 is the standard). */
  rrfK: z.number().int().positive().default(60),
  /** Novelty gate — a doc chunk with peak similarity below this counts as novel. */
  novelMaxSimCutoff: z.number().min(0).max(1).default(0.6),
  /** doc↔task linking — minimum cosine for the auto-discovered link. */
  linkMinSim: z.number().min(0).max(1).default(0.75),
  /** Embed worker batch size (chunks/call). */
  embedBatch: z.number().int().positive().default(64),
});
export type WorkspaceTunables = z.infer<typeof WorkspaceTunablesSchema>;

// ── Model routing per pipeline stage ──────────────────────────────────────
export const StageEffort = z.enum(["low", "medium", "high"]);
export type StageEffort = z.infer<typeof StageEffort>;

export const StageRoutingSchema = z.object({
  /** Azure OpenAI deployment name (e.g. "gpt-5.5"). */
  deployment: z.string(),
  effort: StageEffort.default("medium"),
});
export type StageRouting = z.infer<typeof StageRoutingSchema>;

export const WorkspaceModelsSchema = z.object({
  pipeline: z.object({
    normalize: StageRoutingSchema,
    analyze: StageRoutingSchema,
    critic: StageRoutingSchema,
    enrich: StageRoutingSchema,
    refine: StageRoutingSchema,
    chat: StageRoutingSchema,
  }),
  narrative: StageRoutingSchema,
  clamp: StageRoutingSchema,
  judge: StageRoutingSchema,
});
export type WorkspaceModels = z.infer<typeof WorkspaceModelsSchema>;

/**
 * The frozen ML config payload written to `AnalysisRunSnapshot` on run
 * completion — a point-in-time capture so the Phase-5 preview can replay
 * a historical run's parameters exactly.
 */
export const RunSnapshotPayloadSchema = z.object({
  tunables: WorkspaceTunablesSchema,
  models: WorkspaceModelsSchema,
});
export type RunSnapshotPayload = z.infer<typeof RunSnapshotPayloadSchema>;
