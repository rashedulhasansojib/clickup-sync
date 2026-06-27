import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES, clickupCommentsWorkerOptions } from '../queues/queue.constants';
import { CommentsService } from '../comments/comments.service';
import { JobLogsRepository } from '../jobs/job-logs.repository';
import { DeadLetterService } from '../jobs/dead-letter.service';

@Injectable()
@Processor(QUEUES.CLICKUP_COMMENTS, clickupCommentsWorkerOptions())
export class CommentSyncProcessor extends WorkerHost {
  constructor(
    private readonly comments: CommentsService,
    private readonly jobLogs: JobLogsRepository,
    private readonly deadLetters: DeadLetterService,
  ) { super(); }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    await this.deadLetters.recordIfExhausted(job, err);
  }

  async process(job: Job<{ workspaceId: string; taskId: string }>) {
    const { workspaceId, taskId } = job.data;
    const log = await this.jobLogs.started({ workspaceId, jobId: job.id?.toString(), queueName: QUEUES.CLICKUP_COMMENTS, jobName: job.name, entityType: 'task', entityId: taskId });
    try {
      const result = await this.comments.syncTaskComments(workspaceId, taskId);
      await this.jobLogs.finished(log.id, {});
      return result;
    } catch (e) {
      await this.jobLogs.failed(log.id, e);
      throw e;
    }
  }
}
