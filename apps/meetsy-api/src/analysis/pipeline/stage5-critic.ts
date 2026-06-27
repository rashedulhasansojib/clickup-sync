import { z } from "zod";
import type { Participant, Task, TaskPriority } from "@ma/shared";
import { TaskSchema } from "@ma/shared";
import { AzureOpenAIService } from "../../azure/azure-openai.service";

/**
 * Stage 5 — Critic / verification pass (runs BEFORE enrich).
 *
 * Adversarially reviews the extracted task set against the transcript and
 * returns a corrected, deduplicated, complete list:
 *  - drops tasks not grounded in the transcript,
 *  - merges duplicates,
 *  - fixes owners (assigneeId must be a roster id or null),
 *  - adds clearly-actionable tasks that were discussed but missed,
 *  - calibrates confidence (no more "everything is 1.0").
 *
 * Returns the revised tasks plus a short human-readable list of changes (handy
 * for debugging and for the future feedback loop).
 */
const PRIORITIES = ["urgent", "high", "normal", "low"] as const;

const CriticLLMSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      assigneeId: z.string().nullable(),
      priority: z.enum(PRIORITIES),
      dueDate: z.string().nullable(),
      evidence: z.array(
        z.object({
          quote: z.string(),
          speaker: z.string().nullable(),
          timestamp: z.string().nullable(),
        }),
      ),
      explicit: z.boolean(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  /** Short notes on what changed, e.g. "Merged duplicate PDF tasks", "Dropped ungrounded item". */
  changes: z.array(z.string()),
});

export interface CriticOutput {
  tasks: Task[];
  changes: string[];
}

const SYSTEM = `You are a meticulous reviewer of tasks extracted from a meeting.
Given the transcript, the participant roster, and the candidate tasks, produce a
corrected, deduplicated, and complete task list:

- Remove any task that is NOT clearly grounded in the transcript.
- Merge duplicates into a single task.
- Fix ownership: assigneeId MUST be one of the provided roster ids, or null.
  Re-check "I"/"you"/delegations ("X, can you…") against who actually spoke.
- Add any clearly-actionable task that was discussed but missed, each with a
  verbatim evidence quote.
- Calibrate confidence per task honestly (0..1). Reserve >0.9 for explicit,
  unambiguous assignments; lower it for inferred ownership or vague tasks.
- Keep evidence quotes verbatim from the transcript.

Be conservative: do not delete a solid task or invent speculative ones. Also
return a short list summarizing the changes you made.`;

export async function criticPass(
  azure: AzureOpenAIService,
  transcript: string,
  roster: Participant[],
  tasks: Task[],
): Promise<CriticOutput> {
  const rosterBlock = roster
    .map((p) => `- ${p.id}: ${p.displayName}${p.aliases.length ? ` (aliases: ${p.aliases.join(", ")})` : ""}`)
    .join("\n");

  const taskView = tasks.map((t) => ({
    title: t.title,
    description: t.description,
    assigneeId: t.assigneeId,
    priority: t.priority,
    dueDate: t.dueDate,
    evidence: t.evidence,
    explicit: t.explicit,
    confidence: t.confidence,
  }));

  const out = await azure.structured({
    system: SYSTEM,
    user: [
      `Roster (valid assigneeId values):\n${rosterBlock || "(none)"}`,
      ``,
      `Candidate tasks (JSON):\n${JSON.stringify(taskView, null, 2)}`,
      ``,
      `Transcript:\n${transcript}`,
      ``,
      `Return the corrected task list and the changes you made.`,
    ].join("\n"),
    schema: CriticLLMSchema,
    schemaName: "critique",
    reasoningEffort: "high",
  });

  const byId = new Map(roster.map((p) => [p.id, p]));

  const revised: Task[] = out.tasks.map((t, i) => {
    const resolved = t.assigneeId ? byId.get(t.assigneeId) ?? null : null;
    const candidate: Task = {
      id: `t${i + 1}`,
      title: t.title,
      description: t.description,
      acceptanceCriteria: [],
      assigneeId: resolved ? resolved.id : null,
      assigneeName: resolved ? resolved.displayName : null,
      priority: t.priority as TaskPriority,
      dueDate: t.dueDate,
      estimate: null,
      dependencies: [],
      tags: [],
      subtasks: [],
      evidence: t.evidence,
      explicit: t.explicit,
      confidence: t.confidence,
    };
    return TaskSchema.parse(candidate);
  });

  return { tasks: revised, changes: out.changes };
}
