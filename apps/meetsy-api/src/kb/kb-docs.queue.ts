import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import { ConfigService } from "../config/config.service";

export const KB_DOCS_QUEUE_NAME = "meetsy-kb-docs";

/** Payload for a single document parse→embed→metric job. */
export interface KbDocsJobData {
  workspaceId: string;
  documentId: string;
  /** Raw uploaded bytes, base64. Extracted to text by the worker, then discarded. */
  buffer: string;
  mimeType: string;
}

/**
 * Producer for the `meetsy-kb-docs` queue (the Worker lives in KbDocsProcessor).
 * Mirrors KbQueue — including the Phase-2b-fix enqueue behaviour: the stable
 * `jobId = documentId` would otherwise let a retained completed/failed job block
 * a re-run, so a finished job is superseded before re-adding.
 */
@Injectable()
export class KbDocsQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbDocsQueue.name);
  private queue!: Queue<KbDocsJobData>;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const { host, port } = this.config.redis;
    this.queue = new Queue<KbDocsJobData>(KB_DOCS_QUEUE_NAME, {
      connection: { host, port, maxRetriesPerRequest: null },
    });
    this.logger.log(`KB-docs queue "${KB_DOCS_QUEUE_NAME}" ready`);
  }

  async enqueue(data: KbDocsJobData): Promise<void> {
    const existing = await this.queue.getJob(data.documentId);
    if (existing) {
      const state = await existing.getState().catch(() => "unknown");
      if (state === "completed" || state === "failed") {
        await existing.remove().catch((err: unknown) => {
          this.logger.warn(`Could not remove prior ${state} doc job ${data.documentId}: ${(err as Error).message}`);
        });
      }
    }
    await this.queue.add("ingest", data, {
      jobId: data.documentId,
      removeOnComplete: 50,
      removeOnFail: 50,
      attempts: 1,
    });
    this.logger.log(`Enqueued KB-docs ingest for document ${data.documentId}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
