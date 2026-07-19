import { z } from "zod";

/**
 * Core domain models for the meeting-analyzer.
 * These Zod schemas are the single source of truth shared by the NestJS API
 * (validation + Azure structured-output schemas) and the Next.js web app (types).
 */

// ── Participants / roster ──────────────────────────────────────────────

/**
 * v2 Phase 7 — the resolver tier that produced a suggestion. Powers the
 * badge on the roster review chip so the user sees WHY each suggestion was
 * made. `undefined` on legacy rows written before Phase 7.
 *   kb        — hit the per-workspace ParticipantAlias table (learned).
 *   heuristic — matched via AssigneeResolverService's 3-tier deterministic pass.
 *   llm       — matched via the (future PR-E) LLM fallback.
 *   none      — no tier resolved this alias.
 */
export const SuggestionSourceSchema = z.enum(["kb", "heuristic", "llm", "none"]);
export type SuggestionSource = z.infer<typeof SuggestionSourceSchema>;

export const ParticipantSchema = z.object({
  /** Stable id within a meeting (e.g. "p1"). */
  id: z.string(),
  /** Best-known real name, e.g. "Sarah Khan". */
  displayName: z.string(),
  /** Raw labels seen in the transcript that map to this person, e.g. ["Speaker 2", "Sarah"]. */
  aliases: z.array(z.string()).default([]),
  /**
   * ClickUp member this participant maps to. The backend suggests a match
   * (transcript name → workspace member) at meeting creation; the user
   * confirms/overrides it at the roster step. null = no/unconfirmed match.
   */
  clickupUserId: z.string().nullable().default(null),
  /** Matched ClickUp member display name (for the verification UI). */
  clickupName: z.string().nullable().default(null),
  /**
   * v2 Phase 7 — provenance of the current suggestion. Backend-populated at
   * upload time; the confirmed roster stored on Meeting.roster preserves the
   * source that was suggested (so PR-C can diff and toast).
   */
  source: SuggestionSourceSchema.optional(),
  /**
   * v2 Phase 7 — number of prior confirmations for a KB hit. Powers the
   * "KB · confirmed N×" badge. Only present when `source === "kb"`.
   */
  confirmations: z.number().int().nonnegative().optional(),
  /**
   * v2 Phase 7 — set by the roster review UI when the user clicks "Never match
   * this name". Combined with a null `clickupUserId`, tells the write path to
   * record a blocklist row (source=user_blocklisted) instead of skipping the
   * cleared field as a no-op. Transient at confirmation time.
   */
  blocklist: z.boolean().optional(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

// ── Evidence (grounding) ───────────────────────────────────────────────
/** Every task carries the transcript quote that justifies it — trust + verifiability. */
export const EvidenceSchema = z.object({
  quote: z.string(),
  speaker: z.string().nullable().default(null),
  /** Free-form timestamp as it appears in the transcript, e.g. "00:12:30". */
  timestamp: z.string().nullable().default(null),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// ── Tasks (ClickUp-ready) ──────────────────────────────────────────────
export const TaskPriority = z.enum(["urgent", "high", "normal", "low"]);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()).default([]),
  /** Participant id of the owner; null if the pipeline could not resolve an owner. */
  assigneeId: z.string().nullable().default(null),
  /** Denormalized owner name for display. */
  assigneeName: z.string().nullable().default(null),
  priority: TaskPriority.default("normal"),
  /** ISO date string or natural-language due ("end of sprint"); null if none discussed. */
  dueDate: z.string().nullable().default(null),
  estimate: z.string().nullable().default(null),
  /**
   * Effort estimate in HOURS — produced by the LLM in the enrich stage (grounded
   * in the task scope, not the sparse historical estimates). This is what the
   * ClickUp push sets as `time_estimate` (hours × 3.6e6 ms). null = not sized.
   */
  estimateHours: z.number().positive().nullable().default(null),
  dependencies: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  subtasks: z.array(z.string()).default([]),
  evidence: z.array(EvidenceSchema).default([]),
  /** Was the task explicitly assigned, or inferred from discussion? */
  explicit: z.boolean().default(true),
  /** Pipeline confidence 0..1. */
  confidence: z.number().min(0).max(1).default(0.5),
});
export type Task = z.infer<typeof TaskSchema>;

// ── Per-person grouping + final result ─────────────────────────────────
export const PersonTasksSchema = z.object({
  participant: ParticipantSchema,
  tasks: z.array(TaskSchema),
});
export type PersonTasks = z.infer<typeof PersonTasksSchema>;

export const AnalysisResultSchema = z.object({
  /** One-paragraph executive overview of the meeting. */
  overview: z.string(),
  /** Tasks grouped by their assigned person. */
  people: z.array(PersonTasksSchema),
  /** Tasks the pipeline could not confidently assign to anyone. */
  unassignedTasks: z.array(TaskSchema).default([]),
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

// ── Run lifecycle ──────────────────────────────────────────────────────
// `cancelled` is a terminal state set by `POST /runs/:id/cancel` — the
// processor checks `AnalysisRun.cancelRequestedAt` between stages and exits
// with this status instead of `failed`. Distinguished in the UI so a
// deliberate user cancel doesn't render as an error.
export const RunStatus = z.enum(["queued", "running", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;
