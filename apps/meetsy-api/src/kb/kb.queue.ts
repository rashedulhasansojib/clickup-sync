import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import type IORedis from "ioredis";
import { ConfigService } from "../config/config.service";
import { createRedis } from "../analysis/queue/redis";
import type { KbRange, KbScope } from "./kb.dto";

export const KB_QUEUE_NAME = "meetsy-kb";

/** Pub/sub channel for a workspace's live KB onboarding progress. */
export const kbChannel = (workspaceId: string): string => `kb:${workspaceId}`;

/** Payload enqueued for each onboarding/refresh run. */
export interface KbJobData {
  workspaceId: string;
  /** The requested window — used on first run when no cursor exists yet. */
  range: KbRange;
  /** Optional per-onboarding scope filter (absent = all synced spaces, no sub-filter). */
  scope?: KbScope;
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
   *
   * But that stable jobId also means a RETAINED completed/failed job (kept by
   * removeOn*) blocks a later re-onboard: BullMQ dedupes jobId across ALL states,
   * so add() would silently return the old finished job. So first remove any
   * existing FINISHED job for this workspace, letting a fresh run proceed. An
   * in-flight (active/waiting/delayed) job is left alone — that's the genuine
   * idempotency case (and an active/locked job can't be removed anyway; a
   * crashed one is reclaimed by BullMQ's stalled recovery, see KbProcessor).
   */
  async enqueue(data: KbJobData): Promise<void> {
    const existing = await this.queue.getJob(data.workspaceId);
    if (existing) {
      const state = await existing.getState().catch(() => "unknown");
      if (state === "completed" || state === "failed") {
        await existing.remove().catch((err: unknown) => {
          this.logger.warn(`Could not remove prior ${state} KB job ${data.workspaceId}: ${(err as Error).message}`);
        });
      }
    }
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
