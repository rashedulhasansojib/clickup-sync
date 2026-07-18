import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Job, Worker } from "bullmq";
import { ConfigService } from "../../config/config.service";
import { PrismaService } from "../../prisma/prisma.service";
import { ClickUpClient } from "../clickup.client";
import type { CreateTaskPayload } from "../clickup.types";
import { PushRetryJobData } from "./push-retry.queue";
import { PUSH_RETRY_QUEUE_NAME } from "./redis";

/**
 * v2 Phase 2 (PR-I) — worker for `meetsy-push-retry`. Replays a single failed
 * push by reading its stored ClickUp payload from `TaskPush.payload` and
 * hitting `POST /list/{listId}/task` with the workspace's CURRENT target list.
 * Success updates the TaskPush row to `pushed`; failure lets BullMQ retry
 * (attempts=4, exponential backoff — see PushRetryQueue). When BullMQ
 * exhausts attempts we get one `failed` event with `job.attemptsMade` at the
 * configured max — that's when we write a `PushDeadLetter` row.
 *
 * IDEMPOTENCY: if the TaskPush row is already `pushed` when the worker picks
 * up a stale job, we no-op — the queue's own dedupe key (jobId) can't guard
 * against a manual UI re-push in the interim.
 *
 * NOTE: FieldOverride is intentionally NOT re-logged on retry — the original
 * push carried the request-time context (per-task listId/points/client
 * overrides) and the retry only has the stored ClickUp payload. The learning
 * signal for a permanently-failed → later-retried push is missing on purpose;
 * a resurrected push has the same audit shape as a never-failed one.
 */
@Injectable()
export class PushRetryProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushRetryProcessor.name);
  private worker!: Worker<PushRetryJobData>;
  private readonly maxAttempts = 4;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly clickup: ClickUpClient,
  ) {}

  onModuleInit(): void {
    const { host, port } = this.config.redis;
    this.worker = new Worker<PushRetryJobData>(
      PUSH_RETRY_QUEUE_NAME,
      (job) => this.process(job),
      { connection: { host, port, maxRetriesPerRequest: null } },
    );
    this.worker.on("failed", async (job, err) => {
      if (!job) return;
      this.logger.error(
        `Push retry ${job.id} failed (attempt ${job.attemptsMade}/${this.maxAttempts}): ${err.message}`,
      );
      // Terminal failure — write a dead-letter row so the failure is visible
      // beyond BullMQ's transient state. Best-effort: a DL write failure only
      // logs, since the TaskPush row already records the failed status.
      if (job.attemptsMade >= this.maxAttempts) {
        try {
          await this.deadLetter(job, err);
        } catch (deadLetterErr) {
          this.logger.error(
            `PushDeadLetter write failed for job ${job.id}: ${(deadLetterErr as Error).message}`,
          );
        }
      }
    });
    this.logger.log(`Push-retry worker listening on "${PUSH_RETRY_QUEUE_NAME}"`);
  }

  private async process(job: Job<PushRetryJobData>): Promise<void> {
    const { runId, meetsyTaskId } = job.data;

    const push = await this.prisma.taskPush.findUnique({
      where: { runId_meetsyTaskId: { runId, meetsyTaskId } },
    });
    if (!push) {
      throw new Error(`TaskPush not found for (${runId}, ${meetsyTaskId})`);
    }
    // Idempotent no-op: another path already succeeded.
    if (push.status === "pushed") {
      this.logger.log(`Skip: (${runId}, ${meetsyTaskId}) is already pushed`);
      return;
    }

    // Resolve the workspace's current target list. If push was un-configured
    // between the original push and the retry, we can't retry — fail loud.
    const config = await this.prisma.workspacePushConfig.findUnique({
      where: { workspaceId: push.workspaceId },
      select: { targetListId: true },
    });
    if (!config) {
      throw new Error(
        `Workspace ${push.workspaceId} has no push config; cannot retry`,
      );
    }

    const payload = push.payload as unknown as CreateTaskPayload;
    const created = await this.clickup.createTask(
      push.workspaceId,
      config.targetListId,
      payload,
    );

    await this.prisma.taskPush.update({
      where: { runId_meetsyTaskId: { runId, meetsyTaskId } },
      data: {
        status: "pushed",
        clickupTaskId: created.id,
        clickupUrl: created.url,
        error: null,
      },
    });
    this.logger.log(
      `Retry pushed (${runId}, ${meetsyTaskId}) → ${created.id}`,
    );
  }

  private async deadLetter(job: Job<PushRetryJobData>, err: Error): Promise<void> {
    const { runId, meetsyTaskId } = job.data;
    // Best-effort: read the payload from TaskPush (source of truth). If the row
    // is gone (deleted between attempts, unlikely) we still write the DL row
    // with an empty payload so the failure remains visible.
    const push = await this.prisma.taskPush
      .findUnique({ where: { runId_meetsyTaskId: { runId, meetsyTaskId } } })
      .catch(() => null);
    await this.prisma.pushDeadLetter.create({
      data: {
        runId,
        meetsyTaskId,
        workspaceId: push?.workspaceId ?? "",
        jobId: String(job.id),
        payload: (push?.payload ?? {}) as Prisma.InputJsonValue,
        errorMessage: err.message,
        errorStack: err.stack ?? null,
        attemptsMade: job.attemptsMade,
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
