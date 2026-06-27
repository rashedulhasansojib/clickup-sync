import { z } from "zod";
import type { Participant, Task, TaskPriority } from "@ma/shared";
import { TaskSchema } from "@ma/shared";

/**
 * Reusable LLM-facing "full task" shape (strict-safe: all required, nullable
 * only) + a mapper to the @ma/shared domain Task. Shared by the refine and chat
 * stages so a model can return complete, ClickUp-ready tasks.
 */
export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;

export const FullTaskLLMSchema = z.object({
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  /** Must be a roster participant id, or null. */
  assigneeId: z.string().nullable(),
  priority: z.enum(PRIORITIES),
  /** Absolute due date YYYY-MM-DD, or null. */
  dueDate: z.string().nullable(),
  estimate: z.string().nullable(),
  dependencies: z.array(z.string()),
  subtasks: z.array(z.string()),
  tags: z.array(z.string()),
  evidence: z.array(
    z.object({
      quote: z.string(),
      speaker: z.string().nullable(),
      timestamp: z.string().nullable(),
    }),
  ),
  explicit: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type FullTaskLLM = z.infer<typeof FullTaskLLMSchema>;

/** Map an LLM task to a validated domain Task, resolving the owner vs roster. */
export function mapToTask(raw: FullTaskLLM, id: string, roster: Participant[]): Task {
  const byId = new Map(roster.map((p) => [p.id, p]));
  const resolved = raw.assigneeId ? byId.get(raw.assigneeId) ?? null : null;
  return TaskSchema.parse({
    id,
    title: raw.title,
    description: raw.description,
    acceptanceCriteria: raw.acceptanceCriteria,
    assigneeId: resolved ? resolved.id : null,
    assigneeName: resolved ? resolved.displayName : null,
    priority: raw.priority as TaskPriority,
    dueDate: raw.dueDate,
    estimate: raw.estimate,
    dependencies: raw.dependencies,
    subtasks: raw.subtasks,
    tags: raw.tags,
    evidence: raw.evidence,
    explicit: raw.explicit,
    confidence: raw.confidence,
  });
}

/** Compact roster block for prompts. */
export function rosterBlock(roster: Participant[]): string {
  return (
    roster
      .map(
        (p) =>
          `- ${p.id}: ${p.displayName}${p.aliases.length ? ` (aliases: ${p.aliases.join(", ")})` : ""}`,
      )
      .join("\n") || "(none)"
  );
}
