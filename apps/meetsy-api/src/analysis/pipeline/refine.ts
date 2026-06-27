import { z } from "zod";
import type { Participant, Task } from "@ma/shared";
import { AzureOpenAIService } from "../../azure/azure-openai.service";
import { FullTaskLLMSchema, mapToTask, rosterBlock } from "./taskShape";

/**
 * Phase 3 — targeted re-run.
 *
 * Revises ONLY the tasks the user downvoted with a correction comment. Each is
 * regenerated as a complete, ClickUp-ready task, grounded in the transcript and
 * honoring the user's correction. Tasks not passed here are left untouched by
 * the caller (the whole point of "targeted").
 */
const RefineLLMSchema = z.object({
  tasks: z.array(
    FullTaskLLMSchema.extend({
      /** Echo back the original task id so we can map the revision in place. */
      originalId: z.string(),
    }),
  ),
});

export interface RefineItem {
  task: Task;
  comment: string;
}

function systemPrompt(meetingDateISO: string): string {
  return `You revise specific meeting tasks based on the user's correction. The
meeting took place on ${meetingDateISO}. For each task you are given the current
task and the user's correction comment. Produce the corrected task, fully detailed
and ClickUp-ready, and KEEP it grounded in the transcript (evidence quotes must be
verbatim). assigneeId MUST be a roster id or null. Resolve any due date to an
absolute YYYY-MM-DD. Apply the user's correction faithfully; do not change tasks
the user did not mention. Echo each task's originalId.`;
}

export async function refineTasks(
  azure: AzureOpenAIService,
  transcript: string,
  roster: Participant[],
  items: RefineItem[],
  meetingDateISO: string,
): Promise<Map<string, Task>> {
  const revisedById = new Map<string, Task>();
  if (items.length === 0) return revisedById;

  const view = items.map((it) => ({
    originalId: it.task.id,
    correction: it.comment,
    current: {
      title: it.task.title,
      description: it.task.description,
      assigneeId: it.task.assigneeId,
      priority: it.task.priority,
      dueDate: it.task.dueDate,
      evidence: it.task.evidence,
    },
  }));

  const out = await azure.structured({
    system: systemPrompt(meetingDateISO),
    user: [
      `Roster (valid assigneeId values):\n${rosterBlock(roster)}`,
      ``,
      `Tasks to revise with the user's corrections (JSON):\n${JSON.stringify(view, null, 2)}`,
      ``,
      `Transcript:\n${transcript}`,
      ``,
      `Return the corrected tasks (echo originalId for each).`,
    ].join("\n"),
    schema: RefineLLMSchema,
    schemaName: "refined_tasks",
    reasoningEffort: "medium",
  });

  for (const r of out.tasks) {
    const { originalId, ...rest } = r;
    // Preserve the original id so the revision replaces the task in place.
    revisedById.set(originalId, mapToTask(rest, originalId, roster));
  }
  return revisedById;
}
