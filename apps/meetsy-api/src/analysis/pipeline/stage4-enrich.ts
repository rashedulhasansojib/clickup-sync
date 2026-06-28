import { z } from "zod";
import type { Task } from "@ma/shared";
import { TaskSchema } from "@ma/shared";
import { AzureOpenAIService } from "../../azure/azure-openai.service";

/**
 * Stage 4 — Enrich tasks to industry-standard, ClickUp-ready detail.
 *
 * Takes the extracted tasks and fills/improves the operational fields:
 * acceptance criteria, dependencies, subtasks, tags, estimate — and RESOLVES the
 * spoken due-date phrase ("by Wednesday") to an absolute calendar date using the
 * meeting date as the anchor (this fixes the wrong-year bug).
 *
 * Owner, title, description, evidence, priority and confidence are preserved
 * from extraction — enrichment only adds operational detail.
 */
const EnrichLLMSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      acceptanceCriteria: z.array(z.string()),
      /** Human-readable titles of other tasks this one depends on. */
      dependencies: z.array(z.string()),
      subtasks: z.array(z.string()),
      tags: z.array(z.string()),
      /** Effort estimate like "4h" / "2d", or null if not inferable. */
      estimate: z.string().nullable(),
      /** Absolute due date as YYYY-MM-DD, or null if none was discussed. */
      dueDate: z.string().nullable(),
    }),
  ),
});

function systemPrompt(meetingDateISO: string): string {
  return `You enrich tasks extracted from a meeting into industry-standard,
ClickUp-ready work items. The meeting took place on ${meetingDateISO}.

For each task, given its title/description and the spoken due-date phrase:
- acceptanceCriteria: 2-4 concrete, verifiable completion conditions.
- subtasks: a short actionable breakdown (only if the work clearly decomposes).
- dependencies: titles of OTHER tasks in the list this one depends on (only real
  dependencies; otherwise empty).
- tags: a few relevant labels (component/area), lowercase.
- estimate: a rough effort like "4h" or "2d" only if reasonably inferable, else null.
- dueDate: resolve the spoken phrase to an absolute calendar date in YYYY-MM-DD
  relative to the meeting date (e.g. "by Wednesday" → the next Wednesday on/after
  the meeting date). If no due date was discussed, return null. NEVER invent a date.

Do not change ownership, titles, or invent tasks. Return one entry per input task,
keyed by the same id.`;
}

export async function enrichTasks(
  azure: AzureOpenAIService,
  tasks: Task[],
  summary: string,
  meetingDateISO: string,
  /**
   * Phase 2c — optional KB context (related existing tasks/docs). REFERENCE ONLY:
   * helps keep estimates/tags/components consistent with how this team actually
   * scopes similar work. Omitted (default) ⇒ byte-identical to the pre-2c behaviour.
   */
  context?: string,
): Promise<Task[]> {
  if (tasks.length === 0) return tasks;

  // Compact view the model needs to enrich (don't resend evidence/owner).
  const taskView = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    priority: t.priority,
    spokenDueDate: t.dueDate,
  }));

  const userParts = [
    `Meeting summary: ${summary}`,
    ``,
    `Tasks to enrich (JSON):`,
    JSON.stringify(taskView, null, 2),
  ];
  if (context?.trim()) {
    userParts.push(
      ``,
      `Related existing work from this client's history (REFERENCE ONLY — align ` +
        `estimates/tags/components with how similar work is usually scoped here; do ` +
        `NOT invent facts not in the meeting):\n${context.trim()}`,
    );
  }

  const out = await azure.structured({
    system: systemPrompt(meetingDateISO),
    user: userParts.join("\n"),
    schema: EnrichLLMSchema,
    schemaName: "enriched_tasks",
    reasoningEffort: "low",
  });

  const byId = new Map(out.tasks.map((e) => [e.id, e]));
  // Map for resolving any dependency the model expressed as a task id ("t2")
  // back to a human-readable title.
  const titleById = new Map(tasks.map((t) => [t.id, t.title]));

  return tasks.map((t) => {
    const e = byId.get(t.id);
    if (!e) return t; // model dropped it — keep the original
    const merged: Task = {
      ...t,
      acceptanceCriteria: e.acceptanceCriteria.length ? e.acceptanceCriteria : t.acceptanceCriteria,
      dependencies: e.dependencies.map((d) => titleById.get(d) ?? d),
      subtasks: e.subtasks,
      tags: e.tags,
      estimate: e.estimate,
      dueDate: e.dueDate,
    };
    return TaskSchema.parse(merged);
  });
}
