/**
 * Pipeline stages. Each stage is a pure function taking AzureOpenAIService +
 * typed inputs and returning typed output (see @ma/shared PipelineStage).
 *
 * Pipeline:
 *   0 normalize (upload-time): VTT parse → clean transcript + roster
 *   1+2 analyze  → comprehend + extract in one pass (summary + grounded tasks)
 *   5 critic     → verify grounding/owners, dedup, completeness, calibrate
 *   4 enrich     → ClickUp-ready fields + absolute due dates
 *   6 assemble   → group by person
 *
 * Note: critic runs BEFORE enrich so enrichment applies to the verified set.
 *
 * ── Phase-3 seams (NOT yet implemented) ──────────────────────────────────────
 * TODO(phase3): feedback-driven targeted re-run; chat-over-result to recover
 * missed tasks.
 */
export { normalizeTranscript, buildRoster } from "./stage0-normalize";
// Stages 1+2 merged into a single reasoning pass (comprehend + extract).
export { analyzeMeeting } from "./stage12-analyze";
export type { AnalyzeResult } from "./stage12-analyze";
export { enrichTasks } from "./stage4-enrich";
export { criticPass } from "./stage5-critic";
export type { CriticOutput } from "./stage5-critic";
export { assemble } from "./stage6-assemble";
// Phase 3: targeted re-run + chat-over-result.
export { refineTasks } from "./refine";
export type { RefineItem } from "./refine";
export { chatOverResult } from "./chat";
export type { ChatResult } from "./chat";
