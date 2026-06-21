import { Injectable, Logger } from '@nestjs/common';
import { ClickupClient } from '../clickup/clickup.client';
import { TasksService } from '../tasks/tasks.service';
import { TimeEntriesService } from './time-entries.service';
import { TimeEntriesRepository } from './time-entries.repository';

export interface ReconcileTaskResult {
  taskId: string;
  deleted: boolean;
  timeEntriesSynced?: number;
}

/**
 * Reconciles a single stored task against ClickUp, covering the gaps the
 * scheduled backfill misses: whole-task deletes (a task removed in ClickUp that
 * lingers locally as `is_deleted=false`) AND entry-level deletes on tasks that
 * weren't recently "updated".
 */
@Injectable()
export class TaskReconciliationService {
  private readonly logger = new Logger(TaskReconciliationService.name);
  constructor(
    private readonly clickup: ClickupClient,
    private readonly tasks: TasksService,
    private readonly timeEntries: TimeEntriesService,
    private readonly timeEntriesRepo: TimeEntriesRepository,
  ) {}

  async reconcileTask(workspaceId: string, taskId: string, startMs: number, endMs: number): Promise<ReconcileTaskResult> {
    let task: unknown;
    try {
      task = await this.clickup.getTask(workspaceId, taskId);
    } catch (err: any) {
      // ONLY a 404 means the task is gone. Anything else (401 cross-workspace,
      // 403, 5xx, network) is an access/transient failure — rethrow so the job
      // retries / dead-letters instead of destroying data on a false signal.
      if (err?.response?.status === 404) {
        await this.timeEntriesRepo.deleteByTaskId(taskId);
        await this.tasks.softDeleteTask(taskId, workspaceId);
        this.logger.log(`Task ${taskId} deleted in ClickUp (404) — soft-deleted locally and removed its time entries`);
        return { taskId, deleted: true };
      }
      throw err;
    }

    // Still exists: refresh the task from the payload we already fetched (no
    // second API call) and reconcile its time entries (the prune inside
    // syncTaskTimeEntries removes entries deleted in ClickUp).
    await this.tasks.syncTasks(workspaceId, [task]);
    const timeEntriesSynced = await this.timeEntries.syncTaskTimeEntries(workspaceId, taskId, undefined, startMs, endMs);
    return { taskId, deleted: false, timeEntriesSynced };
  }
}
