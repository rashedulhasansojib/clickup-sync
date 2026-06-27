import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import type IORedis from "ioredis";
import { ConfigService } from "../config/config.service";
import { createRedis } from "../analysis/queue/redis";
import type { KbRange } from "./kb.dto";

export const KB_QUEUE_NAME = "meetsy-kb";

/** Pub/sub channel for a workspace's live KB onboarding progress. */
export const kbChannel = (workspaceId: string): string => `kb:${workspaceId}`;

/** Payload enqueued for each onboarding/refresh run. */
export interface KbJobData {
  workspaceId: string;
  /** The requested window — used on first run when no cursor exists yet. */
  range: KbRange;
}

/** Live progress broadcast over Redis pub/sub (consumed by the status SSE). */
export interface KbProgressEvent {
  workspaceId: string;
  /** idle | onboarding | ready | error */
  status: string;
  embedded: number;
  total: number;
  message: string;
  at: number;
}

/**
 * Owns the BullMQ Queue (producer) + a dedicated Redis publisher for progress.
 * The Worker lives in KbProcessor so producer and consumer hold separate
 * connections, as BullMQ expects. Mirrors AnalysisQueue.
 */
@Injectable()
export class KbQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbQueue.name);
  private queue!: Queue<KbJobData>;
  private publisher!: IORedis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const { host, port } = this.config.redis;
    this.queue = new Queue<KbJobData>(KB_QUEUE_NAME, {
      connection: { host, port, maxRetriesPerRequest: null },
    });
    this.publisher = createRedis(host, port);
    this.logger.log(`KB queue "${KB_QUEUE_NAME}" ready`);
  }

  /**
   * Enqueue an onboarding run. `jobId: workspaceId` makes it idempotent — a
   * re-POST while a run is in flight does not spawn a duplicate.
   */
  async enqueue(data: KbJobData): Promise<void> {
    await this.queue.add("onboard", data, {
      jobId: data.workspaceId,
      removeOnComplete: 50,
      removeOnFail: 50,
      attempts: 1,
    });
    this.logger.log(`Enqueued KB onboarding for workspace ${data.workspaceId}`);
  }

  async publishProgress(event: KbProgressEvent): Promise<void> {
    await this.publisher.publish(kbChannel(event.workspaceId), JSON.stringify(event));
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    this.publisher?.disconnect();
  }
}
