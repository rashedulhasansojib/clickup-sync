import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { JOBS, QUEUES, clickupWorkerOptions } from '../queues/queue.constants';
import { TasksService } from '../tasks/tasks.service';
import { JobLogsRepository } from '../jobs/job-logs.repository';
import { DeadLetterService } from '../jobs/dead-letter.service';
import { TimeEntriesRepository } from '../time-entries/time-entries.repository';
import { TaskReconciliationService } from '../time-entries/task-reconciliation.service';

@Injectable()
@Processor(QUEUES.CLICKUP_TASKS, clickupWorkerOptions())
export class TaskSyncProcessor extends WorkerHost {
  constructor(
    private readonly tasks: TasksService,
    private readonly jobLogs: JobLogsRepository,
    private readonly deadLetters: DeadLetterService,
    private readonly timeEntries: TimeEntriesRepository,
    private readonly reconciliation: TaskReconciliationService,
  ) { super(); }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    await this.deadLetters.recordIfExhausted(job, err);
  }

  async process(job: Job<{ workspaceId: string; taskId: string }>) {
    const { workspaceId, taskId } = job.data;
    const log = await this.jobLogs.started({ workspaceId, jobId: job.id?.toString(), queueName: QUEUES.CLICKUP_TASKS, jobName: job.name, entityType: 'task', entityId: taskId });
    try {
      let result;
      if (job.name === JOBS.DELETE_CLICKUP_TASK) {
        // A deleted task's tracked time must go too — ClickUp removes the
        // entries with the task but emits no per-entry delete event. Delete
        // them first; the task row survives (soft delete) so the FK holds.
        await this.timeEntries.deleteByTaskId(taskId);
        result = await this.tasks.softDeleteTask(taskId, workspaceId);
      } else if (job.name === JOBS.RECONCILE_CLICKUP_TASK) {
        const { startDate, endDate } = job.data as unknown as { startDate: number; endDate: number };
        result = await this.reconciliation.reconcileTask(workspaceId, taskId, startDate, endDate);
      } else {
        result = await this.tasks.syncTask(workspaceId, taskId);
      }
      await this.jobLogs.finished(log.id, { tasksSynced: 1 });
      return result;
    } catch (e) {
      await this.jobLogs.failed(log.id, e);
      throw e;
    }
  }
}
