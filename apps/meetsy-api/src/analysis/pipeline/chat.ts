import { z } from "zod";
import type { ChatMessage, Participant, Task } from "@ma/shared";
import { AzureOpenAIService } from "../../azure/azure-openai.service";
import { FullTaskLLMSchema, mapToTask, rosterBlock } from "./taskShape";

/**
 * Phase 3 — chat over a result (recover missed tasks, answer questions).
 *
 * Given the transcript, roster, current tasks and the conversation, the model
 * replies conversationally AND, when the user points out a missed/omitted task,
 * returns it fully-formed and grounded so the caller can append it to the result.
 */
const ChatLLMSchema = z.object({
  /** Short conversational reply to show the user. */
  reply: z.string(),
  /** Tasks to ADD to the result (empty unless the user surfaced a missed task). */
  newTasks: z.array(FullTaskLLMSchema),
});

export interface ChatResult {
  reply: string;
  newTasks: Task[];
}

function systemPrompt(meetingDateISO: string): string {
  return `You help a user refine the task list extracted from a meeting (held on
${meetingDateISO}) via chat. You are given the transcript, the roster, and the
current tasks.

- If the user points out a task that was MISSED or asks to add one, find it in the
  transcript and return it in newTasks: complete, ClickUp-ready, grounded in a
  verbatim evidence quote. assigneeId MUST be a roster id or null; resolve due
  dates to YYYY-MM-DD. Only add tasks actually supported by the transcript.
- If the user is just asking a question, answer it and return an empty newTasks.
- Always provide a brief, helpful reply. Never invent tasks with no transcript basis.`;
}

export async function chatOverResult(
  azure: AzureOpenAIService,
  transcript: string,
  roster: Participant[],
  currentTasks: Task[],
  history: ChatMessage[],
  userMessage: string,
  meetingDateISO: string,
  nextIdStart: number,
): Promise<ChatResult> {
  const taskView = currentTasks.map((t) => ({
    id: t.id,
    title: t.title,
    assigneeId: t.assigneeId,
  }));

  const historyBlock = history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const out = await azure.structured({
    system: systemPrompt(meetingDateISO),
    user: [
      `Roster (valid assigneeId values):\n${rosterBlock(roster)}`,
      ``,
      `Current tasks (JSON):\n${JSON.stringify(taskView, null, 2)}`,
      ``,
      historyBlock ? `Conversation so far:\n${historyBlock}\n` : ``,
      `User: ${userMessage}`,
      ``,
      `Transcript:\n${transcript}`,
    ].join("\n"),
    schema: ChatLLMSchema,
    schemaName: "chat_turn",
    reasoningEffort: "medium",
  });

  const newTasks = out.newTasks.map((t, i) => mapToTask(t, `t${nextIdStart + i}`, roster));
  return { reply: out.reply, newTasks };
}
