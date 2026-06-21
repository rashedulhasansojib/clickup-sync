import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES, clickupWorkerOptions } from '../queues/queue.constants';
import { BackfillService } from '../sync/backfill.service';
import { JobLogsRepository } from '../jobs/job-logs.repository';
import { DeadLetterService } from '../jobs/dead-letter.service';

@Injectable()
@Processor(QUEUES.CLICKUP_BACKFILLS, clickupWorkerOptions())
export class BackfillProcessor extends WorkerHost {
  constructor(
    private readonly backfills: BackfillService,
    private readonly jobLogs: JobLogsRepository,
    private readonly deadLetters: DeadLetterService,
  ) { super(); }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    await this.deadLetters.recordIfExhausted(job, err);
  }

  async process(job: Job<{ workspaceId: string; spaceId: string; lookbackDays?: number; timeEntryLookbackDays?: number }>) {
    const { workspaceId, spaceId, lookbackDays } = job.data;
    // Record the requested lookback so reports can show the longest backfill
    // window run per space (see ReportsService.syncHealth).
    const log = await this.jobLogs.started({ workspaceId, jobId: job.id?.toString(), queueName: QUEUES.CLICKUP_BACKFILLS, jobName: job.name, entityType: 'space', entityId: spaceId, payload: lookbackDays != null ? { lookbackDays } : undefined });
    try {
      const result = await this.backfills.backfillSpace(workspaceId, spaceId, job.data.lookbackDays, job.data.timeEntryLookbackDays);
      // `tasksSynced` is used by /admin/backfill/active to compute progress bar
      // totals for the time-entry drain phase that follows. Without it the
      // dashboard can only show "X remaining" instead of "X / N done".
      await this.jobLogs.finished(log.id, { tasksSynced: result.total });
      return result;
    } catch (e) {
      await this.jobLogs.failed(log.id, e);
      throw e;
    }
  }
}
