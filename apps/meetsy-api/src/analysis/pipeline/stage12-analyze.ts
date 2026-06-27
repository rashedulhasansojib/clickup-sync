import { z } from "zod";
import type { Participant, Task, TaskPriority } from "@ma/shared";
import { TaskSchema } from "@ma/shared";
import { AzureOpenAIService } from "../../azure/azure-openai.service";

/**
 * Stages 1+2 merged — comprehend + extract in a single reasoning pass.
 *
 * Comprehension and extraction naturally belong together: doing them in one call
 * removes a round-trip AND avoids information loss between two calls. The model
 * returns the meeting summary/topics/decisions plus the candidate tasks (each
 * grounded in a verbatim evidence quote, owner resolved against the roster).
 *
 * Tasks stay "extract-level": due dates are the spoken phrase (Stage 4 enrich
 * resolves them to absolute dates), and operational fields may be sparse.
 */
const PRIORITIES = ["urgent", "high", "normal", "low"] as const;

const AnalyzeLLMSchema = z.object({
  summary: z.string(),
  topics: z.array(z.string()),
  decisions: z.array(z.string()),
  tasks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      acceptanceCriteria: z.array(z.string()),
      assigneeId: z.string().nullable(),
      priority: z.enum(PRIORITIES),
      /** The due date EXACTLY as spoken; null if none. Stage 4 resolves it. */
      dueDate: z.string().nullable(),
      estimate: z.string().nullable(),
      dependencies: z.array(z.string()),
      tags: z.array(z.string()),
      subtasks: z.array(z.string()),
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
});

export interface AnalyzeResult {
  summary: string;
  topics: string[];
  decisions: string[];
  tasks: Task[];
}

const SYSTEM = `You analyze a meeting transcript in one pass. First understand the
meeting (summary, key topics, decisions). Then extract the actionable tasks.

Each task MUST be grounded in at least one verbatim evidence quote. Use the
provided roster: set assigneeId to the owner's participant id when ownership is
clear, else null. Never invent an id not in the roster. Capture due dates as the
exact phrase spoken (e.g. "by Wednesday") — do NOT convert to a calendar date.
Record dependencies and acceptance criteria only when actually discussed. Prefer
fewer, well-grounded tasks over speculative ones.`;

export async function analyzeMeeting(
  azure: AzureOpenAIService,
  transcript: string,
  roster: Participant[],
): Promise<AnalyzeResult> {
  const rosterBlock = roster
    .map((p) => `- ${p.id}: ${p.displayName}${p.aliases.length ? ` (aliases: ${p.aliases.join(", ")})` : ""}`)
    .join("\n");

  const out = await azure.structured({
    system: SYSTEM,
    user: [
      `Roster (use these ids for assigneeId):\n${rosterBlock || "(none extracted)"}`,
      ``,
      `Transcript:\n${transcript}`,
      ``,
      `Summarize the meeting and extract the tasks.`,
    ].join("\n"),
    schema: AnalyzeLLMSchema,
    schemaName: "analysis",
    reasoningEffort: "medium",
  });

  const byId = new Map(roster.map((p) => [p.id, p]));
  const tasks: Task[] = out.tasks.map((t, i) => {
    const resolved = t.assigneeId ? byId.get(t.assigneeId) ?? null : null;
    return TaskSchema.parse({
      id: `t${i + 1}`,
      title: t.title,
      description: t.description,
      acceptanceCriteria: t.acceptanceCriteria,
      assigneeId: resolved ? resolved.id : null,
      assigneeName: resolved ? resolved.displayName : null,
      priority: t.priority as TaskPriority,
      dueDate: t.dueDate,
      estimate: t.estimate,
      dependencies: t.dependencies,
      tags: t.tags,
      subtasks: t.subtasks,
      evidence: t.evidence,
      explicit: t.explicit,
      confidence: t.confidence,
    });
  });

  return { summary: out.summary, topics: out.topics, decisions: out.decisions, tasks };
}
