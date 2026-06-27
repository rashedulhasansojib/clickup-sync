import { z } from "zod";

/**
 * Core domain models for the meeting-analyzer.
 * These Zod schemas are the single source of truth shared by the NestJS API
 * (validation + Azure structured-output schemas) and the Next.js web app (types).
 */

// ── Participants / roster ──────────────────────────────────────────────
export const ParticipantSchema = z.object({
  /** Stable id within a meeting (e.g. "p1"). */
  id: z.string(),
  /** Best-known real name, e.g. "Sarah Khan". */
  displayName: z.string(),
  /** Raw labels seen in the transcript that map to this person, e.g. ["Speaker 2", "Sarah"]. */
  aliases: z.array(z.string()).default([]),
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
export const RunStatus = z.enum(["queued", "running", "completed", "failed"]);
export type RunStatus = z.infer<typeof RunStatus>;
