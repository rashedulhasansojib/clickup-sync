import { z } from "zod";

/**
 * Pipeline stage definitions + the live-progress (SSE) event contract.
 *
 * V1 walking skeleton runs a 3-stage subset (comprehend → extract → assemble).
 * The full Phase-2 pipeline runs all stages including the critic loop.
 */
export const PipelineStage = z.enum([
  "normalize", // Stage 0: clean transcript, resolve speakers, build roster
  "comprehend", // Stage 1: topics, decisions, roles (high reasoning)
  "extract", // Stage 2: candidate tasks + evidence quotes
  "assign", // Stage 3: resolve each task to a roster member
  "enrich", // Stage 4: fill ClickUp-standard fields
  "critic", // Stage 5: verify grounding / owners / dedup / completeness
  "assemble", // Stage 6: group by person, finalize
]);
export type PipelineStage = z.infer<typeof PipelineStage>;

export const StageStatus = z.enum(["started", "progress", "completed", "failed"]);
export type StageStatus = z.infer<typeof StageStatus>;

/** Emitted over SSE so the UI can show the pipeline working live. */
export const ProgressEventSchema = z.object({
  runId: z.string(),
  stage: PipelineStage,
  status: StageStatus,
  /** Human-readable message, e.g. "Extracted 12 candidate tasks". */
  message: z.string(),
  /** Overall progress 0..1 across the whole pipeline. */
  progress: z.number().min(0).max(1),
  /** Epoch ms; set by the producer. */
  at: z.number(),
});
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;
