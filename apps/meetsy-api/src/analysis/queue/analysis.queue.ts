import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import type IORedis from "ioredis";
import type { ProgressEvent } from "@ma/shared";
import { ConfigService } from "../../config/config.service";
import { ANALYSIS_QUEUE_NAME, createRedis, runChannel } from "./redis";

/** Payload enqueued for each analysis run. */
export interface AnalysisJobData {
  runId: string;
  meetingId: string;
  orgId: string;
}

/**
 * Owns the BullMQ Queue and a dedicated Redis publisher connection used to
 * broadcast ProgressEvents on `run:{runId}` (consumed by the SSE endpoint).
 *
 * The Worker lives in AnalysisProcessor so the queue (producer) and worker
 * (consumer) have separate Redis connections, as BullMQ expects.
 */
@Injectable()
export class AnalysisQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalysisQueue.name);
  private queue!: Queue<AnalysisJobData>;
  private publisher!: IORedis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const { host, port } = this.config.redis;
    // BullMQ creates its own internal connections from this config object.
    this.queue = new Queue<AnalysisJobData>(ANALYSIS_QUEUE_NAME, {
      connection: { host, port, maxRetriesPerRequest: null },
    });
    this.publisher = createRedis(host, port);
    this.logger.log(`Analysis queue "${ANALYSIS_QUEUE_NAME}" ready`);
  }

  async enqueue(data: AnalysisJobData): Promise<void> {
    await this.queue.add("analyze", data, {
      jobId: data.runId, // idempotent: one job per run
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    this.logger.log(`Enqueued analysis job for run ${data.runId}`);
  }

  /** Publish a progress event to subscribers of this run's channel. */
  async publishProgress(event: ProgressEvent): Promise<void> {
    await this.publisher.publish(runChannel(event.runId), JSON.stringify(event));
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    this.publisher?.disconnect();
  }
}
