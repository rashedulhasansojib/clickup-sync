import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { DeadLetterRepository } from './dead-letter.repository';

@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger(DeadLetterService.name);

  constructor(private readonly repo: DeadLetterRepository) {}

  /**
   * Persist a job to dead-letter storage when (and only when) BullMQ has run
   * out of retries for it. Call from a processor's `@OnWorkerEvent('failed')`
   * hook — that event fires after every failed attempt, so we gate on
   * `attemptsMade >= attempts` to avoid dead-lettering jobs that will still
   * retry. Returns true when a dead-letter row was written.
   */
  async recordIfExhausted(job: Job, error: unknown): Promise<boolean> {
    const attempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < attempts) return false;

    try {
      await this.repo.create({
        workspaceId: this.workspaceId(job.data),
        queueName: job.queueName,
        jobName: job.name,
        entityId: this.entityId(job.data),
        payload: job.data,
        error,
        attemptsMade: job.attemptsMade,
      });
      this.logger.warn(
        `Dead-lettered job ${job.queueName}/${job.name} (${job.id}) after ${job.attemptsMade} attempts`,
      );
      return true;
    } catch (e) {
      // Never let dead-lettering throw out of a worker event handler.
      this.logger.error(`Failed to write dead-letter row for job ${job.id}`, e as Error);
      return false;
    }
  }

  private entityId(data: unknown): string | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const d = data as Record<string, unknown>;
    const candidate = d.taskId ?? d.timeEntryId ?? d.spaceId ?? d.assigneeId;
    return typeof candidate === 'string' ? candidate : undefined;
  }

  private workspaceId(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null;
    const w = (data as Record<string, unknown>).workspaceId;
    return typeof w === 'string' ? w : null;
  }
}
