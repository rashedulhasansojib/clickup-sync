import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NormalizedTimeEntry } from '../clickup/clickup-normalizer';

@Injectable()
export class TimeEntriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  upsert(entry: NormalizedTimeEntry, cost: { rateId: bigint | null; currency: string; hourlyRateCents: bigint; costCents: bigint; status: string }, workspaceId: string) {
    // taskName exists on NormalizedTimeEntry for normalizer convenience but is not a column —
    // it comes from the task relation.  Exclude it so Prisma resolves to the Unchecked variant
    // which accepts taskId and rateId as plain scalars.
    const { taskName: _taskName, ...scalarFields } = entry;
    const createPayload = { ...scalarFields, workspaceId, raw: entry.raw as Prisma.InputJsonValue, ...cost };
    // workspaceId is immutable for an entry — only set it on create.
    const updatePayload = { ...scalarFields, raw: entry.raw as Prisma.InputJsonValue, ...cost };
    return this.prisma.clickupTimeEntry.upsert({
      where: { timeEntryId: entry.timeEntryId },
      create: createPayload,
      update: updatePayload,
    });
  }

  /**
   * Remove a local time-entry row by its ClickUp id. Uses deleteMany so it is
   * idempotent (no throw when the row is absent — e.g. replacing a historical
   * entry that was never synced locally).
   */
  deleteByTimeEntryId(timeEntryId: string) {
    return this.prisma.clickupTimeEntry.deleteMany({ where: { timeEntryId } });
  }

  /**
   * Remove every time entry belonging to a task. Used when the task itself is
   * deleted in ClickUp — its tracked time must not linger in reports. Idempotent.
   */
  async deleteByTaskId(taskId: string): Promise<number> {
    const { count } = await this.prisma.clickupTimeEntry.deleteMany({ where: { taskId } });
    return count;
  }

  /**
   * Delete-reconciliation. After re-fetching a task's time entries from ClickUp,
   * remove the local rows that ClickUp no longer returns — but ONLY within the
   * exact slice that was fetched: this task, the assignees we queried
   * (`userIds`), and the [startMs, endMs] window. `keepIds` are the ids ClickUp
   * just returned and must survive. Scoping to `userIds` + the window is what
   * keeps this from deleting other users' entries or rows outside the queried
   * window (and, incidentally, replacement entries — which live under a
   * different, mapped user than the webhook's logged user). Returns rows deleted.
   */
  async pruneTaskEntriesOutsideSet(args: {
    workspaceId: string;
    taskId: string;
    userIds: string[];
    startMs: number;
    endMs: number;
    keepIds: string[];
  }): Promise<number> {
    const { count } = await this.prisma.clickupTimeEntry.deleteMany({
      where: {
        workspaceId: args.workspaceId,
        taskId: args.taskId,
        userId: { in: args.userIds },
        startTime: { gte: new Date(args.startMs), lte: new Date(args.endMs) },
        timeEntryId: { notIn: args.keepIds },
      },
    });
    return count;
  }

  async findUnreplacedAgencyEntries(workspaceId: string, agencyUserId: string, limit = 500) {
    // NOT EXISTS anti-join rather than loading every replaced id into a JS Set
    // and building an unbounded `NOT IN (...)` list (which grows without limit
    // as replacements accumulate). Mirrors findUnreplacedTaggedEntries below.
    type Row = {
      time_entry_id: string;
      task_id: string | null;
      start_time: Date | null;
      end_time: Date | null;
      duration_hours: Prisma.Decimal;
      billable: boolean;
      description: string | null;
    };
    return this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT te.time_entry_id, te.task_id, te.start_time, te.end_time,
             te.duration_hours, te.billable, te.description
      FROM clickup_time_entries te
      WHERE te.user_id = ${agencyUserId}
        AND te.workspace_id = ${workspaceId}
        AND NOT EXISTS (
          SELECT 1 FROM time_entry_replacements r WHERE r.original_entry_id = te.time_entry_id
        )
      ORDER BY te.start_time ASC NULLS LAST
      LIMIT ${limit}
    `);
  }

  /**
   * Time entries that carry a non-empty `tags` array in their raw ClickUp
   * payload AND haven't been replaced yet. Used by the
   * /admin/time-entries/backfill-replacement endpoint to retroactively route
   * historical tagged entries through the assignee-replacement worker.
   *
   * `tag_names` is materialised in SQL (`raw->'tags'[].name` lowercased) so the
   * caller receives a plain `string[]` per row.
   */
  async findUnreplacedTaggedEntries(workspaceId: string, limit = 500) {
    type Row = {
      time_entry_id: string;
      task_id: string | null;
      user_id: string | null;
      start_time: Date | null;
      end_time: Date | null;
      duration_hours: Prisma.Decimal;
      billable: boolean;
      description: string | null;
      tag_names: string[];
    };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT
        te.time_entry_id,
        te.task_id,
        te.user_id,
        te.start_time,
        te.end_time,
        te.duration_hours,
        te.billable,
        te.description,
        ARRAY(
          SELECT LOWER(t->>'name')
          FROM jsonb_array_elements(te.raw->'tags') AS t
          WHERE t->>'name' IS NOT NULL
        ) AS tag_names
      FROM clickup_time_entries te
      WHERE jsonb_array_length(COALESCE(te.raw->'tags', '[]'::jsonb)) > 0
        AND te.workspace_id = ${workspaceId}
        AND NOT EXISTS (
          SELECT 1 FROM time_entry_replacements r WHERE r.original_entry_id = te.time_entry_id
        )
      ORDER BY te.start_time ASC NULLS LAST
      LIMIT ${limit}
    `);
    return rows;
  }
}
