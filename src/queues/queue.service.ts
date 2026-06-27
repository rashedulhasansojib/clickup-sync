import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUES } from './queue.constants';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue(QUEUES.CLICKUP_WEBHOOKS) private readonly webhooks: Queue,
    @InjectQueue(QUEUES.CLICKUP_TASKS) private readonly tasks: Queue,
    @InjectQueue(QUEUES.CLICKUP_TIME_ENTRIES) private readonly timeEntries: Queue,
    @InjectQueue(QUEUES.CLICKUP_BACKFILLS) private readonly backfills: Queue,
    @InjectQueue(QUEUES.MAINTENANCE) private readonly maintenance: Queue,
    @InjectQueue(QUEUES.CLICKUP_ASSIGNEE_REPLACEMENT) private readonly assigneeReplacement: Queue,
    @InjectQueue(QUEUES.CLICKUP_COMMENTS) private readonly comments: Queue,
    private readonly settings: SettingsService,
  ) {}

  get(name: string): Queue {
    const map: Record<string, Queue> = {
      [QUEUES.CLICKUP_WEBHOOKS]: this.webhooks,
      [QUEUES.CLICKUP_TASKS]: this.tasks,
      [QUEUES.CLICKUP_TIME_ENTRIES]: this.timeEntries,
      [QUEUES.CLICKUP_BACKFILLS]: this.backfills,
      [QUEUES.MAINTENANCE]: this.maintenance,
      [QUEUES.CLICKUP_ASSIGNEE_REPLACEMENT]: this.assigneeReplacement,
      [QUEUES.CLICKUP_COMMENTS]: this.comments,
    };
    const queue = map[name];
    if (!queue) throw new Error(`Unknown queue: ${name}`);
    return queue;
  }

  defaultJobOptions() {
    return {
      attempts: Number(process.env.JOB_ATTEMPTS || 5),
      backoff: { type: 'exponential' as const, delay: Number(process.env.JOB_BACKOFF_DELAY_MS || 30000) },
      removeOnComplete: 1000,
      // Bound Redis growth: the durable failure record lives in DeadLetterJob, so
      // keeping failed jobs in Redis forever (the old `false`) was pure leak. Age
      // is in SECONDS; 14 days is well past the retry window (≈8 min for 5
      // attempts), so a transiently-failing job is never evicted mid-retry, while
      // a permanently-failed `replace:<id>` job stops dedup-blocking re-enqueues
      // after the window.
      removeOnFail: { age: 14 * 24 * 60 * 60 },
    };
  }

  webhookJobOptions() {
    return { ...this.defaultJobOptions(), attempts: this.settings.getPreferences().failure.webhookRetryAttempts };
  }
}
