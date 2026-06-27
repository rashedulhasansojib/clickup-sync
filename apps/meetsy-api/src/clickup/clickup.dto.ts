import { z } from "zod";

/**
 * Request/response contracts for the Phase 1 write-back endpoints. Local zod
 * schemas validated via the existing ZodValidationPipe (matches the analysis
 * controllers). Kept in meetsy-api (not @ma/shared) since the web client is a
 * separate, later agent.
 */

export const AssignableMemberSchema = z.object({
  clickupUserId: z.string().min(1),
  name: z.string().min(1),
  email: z.string().optional(),
});
export type AssignableMemberDto = z.infer<typeof AssignableMemberSchema>;

export const PutPushConfigSchema = z.object({
  targetListId: z.string().min(1),
  targetListName: z.string().nullable().optional(),
  assignableMembers: z.array(AssignableMemberSchema),
  defaultStatus: z.string().nullable().optional(),
});
export type PutPushConfigDto = z.infer<typeof PutPushConfigSchema>;

const EvidenceSchema = z.object({
  quote: z.string(),
  speaker: z.string().nullable().optional(),
  timestamp: z.string().nullable().optional(),
});

/** A single (edited, human-confirmed) task to push. */
export const PushTaskSchema = z.object({
  meetsyTaskId: z.string().min(1),
  /** Per-task list override; defaults to the workspace target list. */
  listId: z.string().min(1).optional(),
  /** Confirmed ClickUp assignee from the allowlist; null = unassigned. */
  clickupUserId: z.string().nullable().optional(),
  title: z.string().min(1),
  description: z.string().default(""),
  acceptanceCriteria: z.array(z.string()).default([]),
  evidence: z.array(EvidenceSchema).default([]),
  priority: z.enum(["urgent", "high", "normal", "low"]).default("normal"),
  dueDate: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  subtasks: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
});
export type PushTaskDto = z.infer<typeof PushTaskSchema>;

export const PushRunSchema = z.object({
  tasks: z.array(PushTaskSchema).min(1),
});
export type PushRunDto = z.infer<typeof PushRunSchema>;
