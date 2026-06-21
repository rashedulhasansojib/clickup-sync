import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES, clickupWorkerOptions } from '../queues/queue.constants';
import { TimeEntriesService } from '../time-entries/time-entries.service';
import { JobLogsRepository } from '../jobs/job-logs.repository';
import { DeadLetterService } from '../jobs/dead-letter.service';

@Injectable()
@Processor(QUEUES.CLICKUP_TIME_ENTRIES, clickupWorkerOptions())
export class TimeEntrySyncProcessor extends WorkerHost {
  constructor(
    private readonly timeEntries: TimeEntriesService,
    private readonly jobLogs: JobLogsRepository,
    private readonly deadLetters: DeadLetterService,
  ) { super(); }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    await this.deadLetters.recordIfExhausted(job, err);
  }

  async process(job: Job<{ workspaceId: string; taskId: string; assigneeIds?: string[]; startDate?: number; endDate?: number }>) {
    const { workspaceId, taskId } = job.data;
    const log = await this.jobLogs.started({ workspaceId, jobId: job.id?.toString(), queueName: QUEUES.CLICKUP_TIME_ENTRIES, jobName: job.name, entityType: 'task', entityId: taskId });
    try {
      const result = await this.timeEntries.syncTaskTimeEntries(workspaceId, taskId, job.data.assigneeIds, job.data.startDate, job.data.endDate);
      await this.jobLogs.finished(log.id, { timeEntriesSynced: result });
      return result;
    } catch (e) {
      await this.jobLogs.failed(log.id, e);
      throw e;
    }
  }
}
