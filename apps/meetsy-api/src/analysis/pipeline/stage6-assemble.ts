import type { AnalysisResult, Participant, PersonTasks, Task } from "@ma/shared";
import { AnalysisResultSchema } from "@ma/shared";

/**
 * Stage 6 — Assemble (pure TS, no LLM).
 *
 * Groups tasks by assigneeId into PersonTasks[], routes unresolved tasks to
 * unassignedTasks, and attaches the overview. Only people who own at least one
 * task appear in `people` (keeps the result focused).
 */
export function assemble(
  overview: string,
  roster: Participant[],
  tasks: Task[],
): AnalysisResult {
  const byId = new Map(roster.map((p) => [p.id, p]));

  const grouped = new Map<string, Task[]>();
  const unassignedTasks: Task[] = [];

  for (const task of tasks) {
    if (task.assigneeId && byId.has(task.assigneeId)) {
      const list = grouped.get(task.assigneeId) ?? [];
      list.push(task);
      grouped.set(task.assigneeId, list);
    } else {
      unassignedTasks.push(task);
    }
  }

  // Preserve roster order for stable, predictable output.
  const people: PersonTasks[] = roster
    .filter((p) => grouped.has(p.id))
    .map((p) => ({ participant: p, tasks: grouped.get(p.id)! }));

  const result: AnalysisResult = { overview, people, unassignedTasks };

  // Final assertion against the shared contract before persisting.
  return AnalysisResultSchema.parse(result);
}
