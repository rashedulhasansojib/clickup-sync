import { sha256 } from "@clicksy/shared";

/**
 * The subset of a Clicksy `clickup_tasks` row the card builder reads. Mirrors the
 * public read-model (Kb only SELECTs these). All optional/nullable like the DB.
 */
export interface TaskCardInput {
  taskId: string;
  taskName: string;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  assigneesNames?: string | null;
  listName?: string | null;
  folderName?: string | null;
  spaceName?: string | null;
  client?: string | null;
  department?: string | null;
  executiveName?: string | null;
  sprintName?: string | null;
  tags?: string | null;
  createdDate?: Date | null;
  updatedDate?: Date | null;
  dueDate?: Date | null;
  startDate?: Date | null;
  closedDate?: Date | null;
  /**
   * Comment-completeness marker (Clicksy 2.0). Comments are folded into the card
   * ONLY when this is set — so a task re-embeds exactly once when its comment sync
   * completes, not once per paginated comment page (the advisor's cost trap).
   */
  commentsSyncedAt?: Date | null;
}

/** A comment row (oldest-first when passed in). */
export interface CommentCardInput {
  commentText?: string | null;
  userName?: string | null;
  commentDate?: Date | null;
}

/** Metadata copied onto the chunk for workspace/facet filtering. */
export interface CardMetadata {
  status: string | null;
  assignee: string | null;
  component: string | null;
  client: string | null;
  department: string | null;
  taskUpdatedAt: Date | null;
}

export interface TaskCard {
  content: string;
  contentHash: string;
  metadata: CardMetadata;
}

// ~1.5k tokens. We approximate 1 token ≈ 4 chars (English prose), so the whole
// card is capped near this; oldest comments are truncated first to stay under it.
const MAX_CARD_CHARS = 6000;

function isoDate(d?: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** `component` = the most specific location label available. */
function component(task: TaskCardInput): string | null {
  return task.listName ?? task.folderName ?? task.spaceName ?? null;
}

export function taskCardMetadata(task: TaskCardInput): CardMetadata {
  return {
    status: task.status ?? null,
    assignee: task.assigneesNames ?? null,
    component: component(task),
    client: task.client ?? null,
    department: task.department ?? null,
    taskUpdatedAt: task.updatedDate ?? null,
  };
}

/**
 * Deterministic, pure builder: a compact text "card" from a task's title +
 * description + key fields, plus its comment text WHEN `commentsSyncedAt` is set.
 * Same input → same `content` → same `contentHash` (the incremental gate).
 */
export function buildTaskCard(task: TaskCardInput, comments: CommentCardInput[] = []): TaskCard {
  const lines: string[] = [];
  lines.push(`Title: ${task.taskName}`);

  // Key fields — emit only the present ones, in a fixed order for determinism.
  const fields: Array<[string, string | null]> = [
    ["Status", task.status ?? null],
    ["Priority", task.priority ?? null],
    ["Assignee", task.assigneesNames ?? null],
    ["List", task.listName ?? null],
    ["Folder", task.folderName ?? null],
    ["Space", task.spaceName ?? null],
    ["Client", task.client ?? null],
    ["Department", task.department ?? null],
    ["Executive", task.executiveName ?? null],
    ["Sprint", task.sprintName ?? null],
    ["Tags", task.tags ?? null],
    ["Created", isoDate(task.createdDate)],
    ["Updated", isoDate(task.updatedDate)],
    ["Start", isoDate(task.startDate)],
    ["Due", isoDate(task.dueDate)],
    ["Closed", isoDate(task.closedDate)],
  ];
  for (const [label, value] of fields) {
    if (value && value.trim()) lines.push(`${label}: ${value.trim()}`);
  }

  if (task.description && task.description.trim()) {
    lines.push("", "Description:", task.description.trim());
  }

  // Comments — folded in ONLY once the task's comment sync has completed.
  if (task.commentsSyncedAt) {
    const rendered = comments
      .filter((c) => c.commentText && c.commentText.trim())
      .map((c) => {
        const who = c.userName?.trim() || "Unknown";
        const when = isoDate(c.commentDate);
        return `- ${who}${when ? ` (${when})` : ""}: ${c.commentText!.trim()}`;
      });
    if (rendered.length > 0) {
      // Drop OLDEST comments first if the card would exceed the budget. The head
      // of the card (title + fields + description) is always preserved.
      const head = lines.join("\n");
      let budget = MAX_CARD_CHARS - head.length - "\n\nComments:\n".length;
      const kept: string[] = [];
      for (let i = rendered.length - 1; i >= 0; i--) {
        const line = rendered[i];
        if (budget - (line.length + 1) < 0 && kept.length > 0) break;
        kept.unshift(line);
        budget -= line.length + 1;
      }
      lines.push("", "Comments:", ...kept);
    }
  }

  let content = lines.join("\n");
  // Final hard cap (e.g. a single huge description) — deterministic truncation.
  if (content.length > MAX_CARD_CHARS) content = content.slice(0, MAX_CARD_CHARS);

  return { content, contentHash: sha256(content), metadata: taskCardMetadata(task) };
}
