import type { WorkspaceModels, WorkspaceTunables } from "@ma/shared";

/**
 * The Phase-0-lockdown "known-good" ML config. One place to change tunables +
 * model routing; both `WorkspaceMlConfig` seeder (Phase 5) and the
 * `AnalysisRunSnapshot` fallback (this file's primary caller today) reference it.
 *
 * Every value here corresponds 1:1 to a hardcoded constant in the codebase (v2
 * Phase 0 doesn't change behavior — it just makes the constants inspectable).
 * When a stage's constants change in code, update it here too and Phase 5 will
 * expose the new default via the /tuning surface.
 */

// ── Tunables (mirror the hardcoded thresholds) ──────────────────────────
export const DEFAULT_TUNABLES: WorkspaceTunables = {
  // src/kb/duplicate-bands.ts:19,21
  dupFlag: 0.72,
  dupSuggest: 0.64,
  // src/kb/prediction-prior.ts:44,46
  simFloor: 0.5,
  minQualifying: 3,
  // Assignment ranking — closed neighbours count 2x open ones.
  closedWeight: 2,
  // src/kb/learning-aggregate.ts:51,52
  minCorrections: 3,
  minAgreement: 0.6,
  // src/kb/rrf.ts:9
  rrfK: 60,
  // Novelty gate + doc↔task linking (KbDocs pipeline).
  novelMaxSimCutoff: 0.6,
  linkMinSim: 0.75,
  // KB embed worker batch size.
  embedBatch: 64,
};

/**
 * Default model routing. Pipeline stage effort levels mirror the current
 * hardcoded `reasoningEffort` per stage; deployments default to the
 * primary Azure chat deployment name so a lookup at snapshot time has a
 * valid value even when no per-workspace override exists.
 *
 * `PRIMARY_DEPLOYMENT` is a soft default only — the actual deployment used at
 * runtime is `AZURE_OPENAI_DEPLOYMENT`. The snapshot fields are for record-
 * keeping (what WOULD Phase-5 preview use), not for runtime dispatch.
 */
const PRIMARY_DEPLOYMENT = "gpt-5.5";

export const DEFAULT_MODELS: WorkspaceModels = {
  pipeline: {
    // src/analysis/pipeline/stage0-normalize.ts:56,67 — "low"
    normalize: { deployment: PRIMARY_DEPLOYMENT, effort: "low" },
    // src/analysis/pipeline/stage12-analyze.ts:90 — "high"
    analyze: { deployment: PRIMARY_DEPLOYMENT, effort: "high" },
    // src/analysis/pipeline/stage5-critic.ts:119 — "high"
    critic: { deployment: PRIMARY_DEPLOYMENT, effort: "high" },
    // src/analysis/pipeline/stage4-enrich.ts:104 — "high"
    enrich: { deployment: PRIMARY_DEPLOYMENT, effort: "high" },
    // src/analysis/pipeline/refine.ts:74 — "medium"
    refine: { deployment: PRIMARY_DEPLOYMENT, effort: "medium" },
    // src/analysis/pipeline/chat.ts:72 — "medium"
    chat: { deployment: PRIMARY_DEPLOYMENT, effort: "medium" },
  },
  // src/kb/narrative.service.ts:8,48 — gpt-5.4 / low
  narrative: { deployment: "gpt-5.4", effort: "low" },
  // src/kb/field-prediction.service.ts:79,272 — gpt-5.4 / low
  clamp: { deployment: "gpt-5.4", effort: "low" },
  // src/kb/answerability.service.ts:48,164 — gpt-5.4-mini / low
  judge: { deployment: "gpt-5.4-mini", effort: "low" },
};
