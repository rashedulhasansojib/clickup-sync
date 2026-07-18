import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import { ConfigService } from "../../config/config.service";
import { PUSH_RETRY_QUEUE_NAME } from "./redis";

/**
 * v2 Phase 2 (PR-I) — a single failed-push retry job carries just enough
 * context to look up the TaskPush row and re-run its create call. The full
 * payload lives on TaskPush.payload; the worker reads it there rather than
 * shipping it around in the job body (idempotent: the source of truth is the
 * DB row, not the queue).
 */
export interface PushRetryJobData {
  runId: string;
  meetsyTaskId: string;
  orgId: string;
}

/**
 * v2 Phase 2 (PR-I) — producer for the `meetsy-push-retry` BullMQ queue. The
 * worker lives in `PushRetryProcessor` (separate Redis connection, as BullMQ
 * expects). Mirrors AnalysisQueue's shape.
 *
 * Job id INTENTIONALLY includes a per-enqueue nonce (`${runId}:${meetsyTaskId}:${nonce}`)
 * so a second retry request after the first exhausted BullMQ attempts still
 * enqueues; the DB row on TaskPush is the idempotency key (already-pushed
 * rows are no-ops in the worker).
 */
@Injectable()
export class PushRetryQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushRetryQueue.name);
  private queue!: Queue<PushRetryJobData>;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const { host, port } = this.config.redis;
    this.queue = new Queue<PushRetryJobData>(PUSH_RETRY_QUEUE_NAME, {
      connection: { host, port, maxRetriesPerRequest: null },
    });
    this.logger.log(`Push-retry queue "${PUSH_RETRY_QUEUE_NAME}" ready`);
  }

  /**
   * Enqueue a retry for a single failed push. The nonce keeps repeated retry
   * requests distinct — a stable jobId would let BullMQ dedupe a legitimate
   * second attempt against a completed one.
   */
  async enqueue(data: PushRetryJobData): Promise<string> {
    const nonce = Date.now().toString(36);
    const jobId = `${data.runId}:${data.meetsyTaskId}:${nonce}`;
    await this.queue.add("retry", data, {
      jobId,
      attempts: 4,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    this.logger.log(`Enqueued push retry ${jobId}`);
    return jobId;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
