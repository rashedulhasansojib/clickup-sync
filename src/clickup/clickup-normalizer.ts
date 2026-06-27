import { Injectable } from '@nestjs/common';
import { ClickUpComment, ClickUpTask, ClickUpTimeEntry } from './clickup.types';
import { CustomFieldExtractor } from './custom-field-extractor';
import { fromClickupMillis } from '../common/utils/date-utils';
import { joinNames, toNumberOrZero, toStringOrEmpty, toStringOrNull } from '../common/utils/safe-value';

export interface NormalizedTask {
  taskId: string; parentTaskId: string | null; taskName: string; description: string | null; url: string | null;
  status: string | null; statusType: string | null; statusColor: string | null; priority: string | null; orderIndex: number; archived: boolean;
  createdDate: Date | null; updatedDate: Date | null; closedDate: Date | null; dueDate: Date | null; startDate: Date | null;
  timeEstimate: bigint | null; timeSpent: bigint | null; spaceId: string | null; spaceName: string | null; folderId: string | null; folderName: string | null; listId: string | null; listName: string | null;
  assigneesNames: string | null; assigneesEmails: string | null; watchersNames: string | null; watchersEmails: string | null; creatorId: string | null; creatorName: string | null;
  executiveName: string | null; department: string | null; client: string | null; cost: number; estimation: number; sprintName: string | null; sprintPoints: number; tags: string | null; customTags: string | null; raw: unknown;
}

export interface NormalizedTimeEntry {
  timeEntryId: string; taskId: string | null; taskName: string | null; userId: string | null; userName: string | null; userEmail: string | null;
  startTime: Date | null; endTime: Date | null; durationHours: number; billable: boolean; description: string | null; raw: unknown;
}

export interface NormalizedComment {
  commentId: string; taskId: string; parentCommentId: string | null;
  commentText: string | null; userId: string | null; userName: string | null; userEmail: string | null;
  resolved: boolean; assigneeId: string | null; assigneeName: string | null; replyCount: number;
  reactions: unknown; commentDate: Date | null; raw: unknown;
}

@Injectable()
export class ClickupNormalizer {
  constructor(private readonly fields: CustomFieldExtractor) {}

  normalizeTask(t: ClickUpTask): NormalizedTask {
    if (!t.id) throw new Error('ClickUp task is missing id');
    const cf = this.fields.extract(t);
    return {
      taskId: t.id,
      parentTaskId: toStringOrNull(t.parent),
      taskName: toStringOrEmpty(t.name) || 'Untitled',
      description: toStringOrNull(t.description),
      url: toStringOrNull(t.url),
      status: toStringOrNull(t.status?.status),
      statusType: toStringOrNull(t.status?.type),
      statusColor: toStringOrNull(t.status?.color),
      priority: toStringOrNull(t.priority?.priority),
      orderIndex: Math.round(toNumberOrZero(t.orderindex)),
      archived: !!t.archived,
      createdDate: fromClickupMillis(t.date_created),
      updatedDate: fromClickupMillis(t.date_updated),
      closedDate: fromClickupMillis(t.date_closed),
      dueDate: fromClickupMillis(t.due_date),
      startDate: fromClickupMillis(t.start_date),
      timeEstimate: t.time_estimate ? BigInt(Math.round(toNumberOrZero(t.time_estimate))) : null,
      timeSpent: t.time_spent ? BigInt(Math.round(toNumberOrZero(t.time_spent))) : null,
      spaceId: toStringOrNull(t.space?.id), spaceName: toStringOrNull(t.space?.name), folderId: toStringOrNull(t.folder?.id), folderName: toStringOrNull(t.folder?.name), listId: toStringOrNull(t.list?.id), listName: toStringOrNull(t.list?.name),
      assigneesNames: joinNames(t.assignees || [], 'username'), assigneesEmails: joinNames(t.assignees || [], 'email'), watchersNames: joinNames(t.watchers || [], 'username'), watchersEmails: joinNames(t.watchers || [], 'email'),
      creatorId: toStringOrNull(t.creator?.id), creatorName: toStringOrNull(t.creator?.username),
      executiveName: cf.executiveName, department: cf.department, client: cf.client, cost: cf.cost, estimation: cf.estimation, sprintName: cf.sprintName, sprintPoints: cf.sprintPoints,
      tags: joinNames(t.tags || [], 'name'), customTags: joinNames(t.tags || [], 'name'), raw: t,
    };
  }

  normalizeTimeEntry(entry: ClickUpTimeEntry): NormalizedTimeEntry {
    if (!entry.id) throw new Error('ClickUp time entry is missing id');
    return {
      timeEntryId: entry.id,
      taskId: toStringOrNull(entry.task?.id),
      taskName: toStringOrNull(entry.task?.name),
      userId: toStringOrNull(entry.user?.id),
      userName: toStringOrNull(entry.user?.username),
      userEmail: toStringOrNull(entry.user?.email),
      startTime: fromClickupMillis(entry.start),
      endTime: fromClickupMillis(entry.end),
      // Clamp to 0: ClickUp running timers can report a negative duration, which
      // would otherwise yield a negative costCents and corrupt report sums.
      durationHours: entry.duration ? Math.max(0, toNumberOrZero(entry.duration) / 3600000) : 0,
      billable: !!entry.billable,
      description: toStringOrNull(entry.description),
      raw: entry,
    };
  }

  /**
   * Normalize a ClickUp comment to the `clickup_task_comments` shape. The owning
   * `taskId` is passed in because the comment object from
   * `GET /task/{id}/comment` does not echo it. Plaintext is read from
   * `comment_text` first, falling back to joining the rich `comment[].text`
   * fragments. `parentCommentId` is reserved for threaded replies (null today).
   */
  normalizeComment(c: ClickUpComment, taskId: string): NormalizedComment {
    if (!c.id) throw new Error('ClickUp comment is missing id');
    const text =
      toStringOrNull(c.comment_text) ??
      (Array.isArray(c.comment)
        ? (c.comment.map((f) => f?.text ?? '').join('').trim() || null)
        : null);
    return {
      commentId: String(c.id),
      taskId,
      parentCommentId: toStringOrNull(c.parent),
      commentText: text,
      userId: toStringOrNull(c.user?.id),
      userName: toStringOrNull(c.user?.username),
      userEmail: toStringOrNull(c.user?.email),
      resolved: !!c.resolved,
      assigneeId: toStringOrNull(c.assignee?.id),
      assigneeName: toStringOrNull(c.assignee?.username),
      replyCount: Math.max(0, Math.round(toNumberOrZero(c.reply_count))),
      reactions: c.reactions ?? null,
      commentDate: fromClickupMillis(c.date),
      raw: c,
    };
  }
}
