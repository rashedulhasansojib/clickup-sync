import { Injectable, Logger } from '@nestjs/common';
import { ClickupClient } from '../clickup/clickup.client';
import { TasksService } from '../tasks/tasks.service';
import { SyncCheckpointsRepository } from './sync-checkpoints.repository';
import { QueueService } from '../queues/queue.service';
import { JOBS, QUEUES } from '../queues/queue.constants';
import { subtractDays } from '../common/utils/date-utils';
import { WorkspaceService } from '../workspaces/workspace.service';

@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);
  constructor(
    private readonly clickup: ClickupClient,
    private readonly tasks: TasksService,
    private readonly checkpoints: SyncCheckpointsRepository,
    private readonly queues: QueueService,
    private readonly workspaces: WorkspaceService,
  ) {}

  async backfillSpace(workspaceId: string, spaceId: string, lookbackDays?: number, timeEntryLookbackDays?: number) {
    const space = this.workspaces.getSpace(workspaceId, spaceId);
    const days = lookbackDays ?? space?.backfillLookbackDays ?? 7;
    await this.checkpoints.markAttempt(workspaceId, 'clickup', 'space', spaceId);

    const { tasks: rawTasks, truncated } = await this.clickup.getAllTasksBySpace(workspaceId, spaceId, {
      dateUpdatedGt: subtractDays(days).getTime(),
      includeClosed: true,
      subtasks: true,
    });

    const parentTasks = rawTasks.filter((t) => !t.parent);
    const subtasks = rawTasks.filter((t) => !!t.parent);
    await this.tasks.syncTasks(workspaceId, parentTasks);

    // Subtasks may reference a parent that wasn't updated within the lookback
    // window and so isn't in `rawTasks`. Fetch+insert those (if not already
    // stored) before the subtasks, so parentTaskId never dangles.
    const presentIds = new Set(
      rawTasks.map((t) => (t as { id?: string }).id).filter((id): id is string => !!id),
    );
    const referencedParentIds = [
      ...new Set(
        subtasks
          .map((t) => (t as { parent?: string | null }).parent)
          .filter((p): p is string => !!p && !presentIds.has(p)),
      ),
    ];
    await this.tasks.syncMissingParents(workspaceId, referencedParentIds);

    await this.tasks.syncTasks(workspaceId, subtasks);

    // The team-level tasks endpoint omits space.name — patch it from config
    if (space?.name) {
      await this.tasks.patchSpaceNames(workspaceId, spaceId, space.name);
    }

    // Enqueue time entry sync for every task that was backfilled.
    //
    // When the caller passes an explicit `timeEntryLookbackDays` (the recurring
    // reconciliation sweep does — see SyncScheduler), use it verbatim. This lets
    // the hourly sweep scan a *bounded* time-entry window (e.g. 7 days) instead
    // of re-draining the full configured per-space window every run, while still
    // recovering time entries whose webhook was missed within that window.
    //
    // Otherwise (manual backfills), the configured per-space lookback is a
    // *floor*: a short task-sync window must not shrink the time-entry window,
    // or entries logged earlier would never be picked up. But when the caller
    // explicitly asks for a *longer* window (e.g. a manual 140-day backfill),
    // respect it — otherwise old time entries on recently-updated tasks (think:
    // an expense task touched in April with hours logged back in January) are
    // permanently invisible. The upsert is idempotent so re-scanning is safe.
    const endDate = Date.now();
    const teLookbackDays = timeEntryLookbackDays ?? Math.max(days, space?.backfillLookbackDays ?? days);
    const teStartDate = subtractDays(teLookbackDays).getTime();
    const queue = this.queues.get(QUEUES.CLICKUP_TIME_ENTRIES);
    const jobOpts = this.queues.defaultJobOptions();
    for (const task of rawTasks) {
      const taskId = (task as { id?: string }).id;
      if (taskId) {
        // The time-entry worker resolves all-workspace-members as the
        // `assignee` filter when no specific assignee is provided, which
        // captures tracked time on tasks regardless of who logged it.
        await queue.add(JOBS.SYNC_TASK_TIME_ENTRIES, { workspaceId, taskId, startDate: teStartDate, endDate }, jobOpts);
      }
    }

    await this.checkpoints.markSuccess(workspaceId, 'clickup', 'space', spaceId);
    if (truncated) {
      this.logger.warn(`Backfill of ${space?.name || spaceId} hit the task pagination cap — the result is incomplete and tasks beyond the cap were not synced`);
    }
    this.logger.log(`Backfilled ${rawTasks.length} tasks + enqueued ${rawTasks.length} time-entry jobs for ${space?.name || spaceId}`);
    return { total: rawTasks.length, parents: parentTasks.length, subtasks: subtasks.length, truncated };
  }
}
