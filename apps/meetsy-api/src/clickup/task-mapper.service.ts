import { Injectable } from "@nestjs/common";
import { CreateTaskPayload } from "./clickup.types";

/** The Meetsy task fields needed to build a ClickUp create payload. */
export interface MappableTask {
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  evidence?: Array<{ quote: string; speaker?: string | null; timestamp?: string | null }>;
  subtasks?: string[];
  dependencies?: string[];
  priority: "urgent" | "high" | "normal" | "low";
  /** ISO date (YYYY-MM-DD or full ISO) or null. */
  dueDate?: string | null;
  tags?: string[];
}

const PRIORITY_MAP: Record<MappableTask["priority"], number> = {
  urgent: 1,
  high: 2,
  normal: 3,
  low: 4,
};

/**
 * Pure mapper: Meetsy `Task` (+ confirmed assignee/status) → ClickUp
 * `POST /list/{id}/task` payload. Deterministic and side-effect free so it is
 * trivially unit-tested.
 */
@Injectable()
export class TaskMapperService {
  map(
    task: MappableTask,
    opts: { clickupUserId?: string | null; defaultStatus?: string | null } = {},
  ): CreateTaskPayload {
    const payload: CreateTaskPayload = {
      name: task.title,
      markdown_description: this.buildMarkdown(task),
      priority: PRIORITY_MAP[task.priority],
    };

    // Assignee — omit entirely when unassigned. ClickUp wants numeric ids.
    if (opts.clickupUserId) {
      const id = Number(opts.clickupUserId);
      if (Number.isFinite(id)) payload.assignees = [id];
    }

    // Due date — ISO → epoch ms; skip if null/unparseable. due_date_time:false =
    // a date-only due (no time-of-day). For a bare YYYY-MM-DD we anchor at NOON UTC
    // so ClickUp's workspace-timezone interpretation can't shift the date to the
    // previous/next day (live-verified: UTC-midnight date-only showed as the prior
    // day for a +06:00 workspace). A full datetime string is passed through as-is.
    if (task.dueDate) {
      const bare = /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate.trim());
      const ms = Date.parse(bare ? `${task.dueDate.trim()}T12:00:00Z` : task.dueDate);
      if (Number.isFinite(ms)) {
        payload.due_date = ms;
        payload.due_date_time = false;
      }
    }

    if (task.tags && task.tags.length > 0) payload.tags = task.tags;
    if (opts.defaultStatus) payload.status = opts.defaultStatus;

    return payload;
  }

  /**
   * Compose the ClickUp markdown_description: the description, then Acceptance
   * criteria bullets, Evidence quotes, and — until real ClickUp subtasks /
   * dependency links land (Phase 1.x) — subtasks as a checklist and
   * dependencies as a note.
   */
  private buildMarkdown(task: MappableTask): string {
    const parts: string[] = [];
    if (task.description?.trim()) parts.push(task.description.trim());

    const criteria = (task.acceptanceCriteria ?? []).filter((c) => c.trim());
    if (criteria.length) {
      parts.push(["## Acceptance criteria", ...criteria.map((c) => `- ${c}`)].join("\n"));
    }

    const evidence = (task.evidence ?? []).filter((e) => e.quote?.trim());
    if (evidence.length) {
      parts.push(
        [
          "## Evidence",
          ...evidence.map((e) => {
            const attrib = [e.speaker, e.timestamp].filter(Boolean).join(", ");
            return `> ${e.quote}${attrib ? ` — ${attrib}` : ""}`;
          }),
        ].join("\n"),
      );
    }

    const subtasks = (task.subtasks ?? []).filter((s) => s.trim());
    if (subtasks.length) {
      parts.push(["## Subtasks", ...subtasks.map((s) => `- [ ] ${s}`)].join("\n"));
    }

    const deps = (task.dependencies ?? []).filter((d) => d.trim());
    if (deps.length) {
      parts.push(["## Dependencies", ...deps.map((d) => `- ${d}`)].join("\n"));
    }

    return parts.join("\n\n");
  }
}
