import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { PushRetryQueue } from "./push-retry.queue";

export interface PushRetryResult {
  enqueued: string[];
  skipped: Array<{ meetsyTaskId: string; reason: string }>;
}

/**
 * v2 Phase 2 (PR-I) — the domain layer behind `POST /runs/:id/push/retry`.
 * Given a run and an optional filter of task ids, find every `failed`
 * `TaskPush` row and enqueue a retry job for each. Rows that don't exist or
 * aren't failed are reported in `skipped` (never silently dropped).
 *
 * Idempotency of the retry itself lives in `PushRetryProcessor` (already-pushed
 * rows are no-ops); this service is just the fan-out.
 */
@Injectable()
export class PushRetryService {
  private readonly logger = new Logger(PushRetryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PushRetryQueue,
  ) {}

  async retryFailed(
    orgId: string,
    runId: string,
    taskIds?: string[],
  ): Promise<PushRetryResult> {
    const run = await this.prisma.analysisRun.findUnique({
      where: { id: runId },
    });
    if (!run || run.orgId !== orgId) {
      throw new NotFoundException(`Run ${runId} not found`);
    }

    // Load candidate pushes. When taskIds is empty/absent, retry every failed
    // row for the run; otherwise intersect.
    const filter = taskIds && taskIds.length > 0 ? { in: taskIds } : undefined;
    const pushes = await this.prisma.taskPush.findMany({
      where: { runId, ...(filter ? { meetsyTaskId: filter } : {}) },
    });

    const enqueued: string[] = [];
    const skipped: PushRetryResult["skipped"] = [];

    // Report every filter miss (id in taskIds but no TaskPush row) up front so
    // the caller sees which ids fell through.
    if (taskIds && taskIds.length > 0) {
      const found = new Set(pushes.map((p) => p.meetsyTaskId));
      for (const id of taskIds) {
        if (!found.has(id)) skipped.push({ meetsyTaskId: id, reason: "not_found" });
      }
    }

    for (const push of pushes) {
      if (push.status !== "failed") {
        skipped.push({
          meetsyTaskId: push.meetsyTaskId,
          reason: `not_failed:${push.status}`,
        });
        continue;
      }
      try {
        const jobId = await this.queue.enqueue({
          runId,
          meetsyTaskId: push.meetsyTaskId,
          orgId,
        });
        enqueued.push(jobId);
      } catch (err) {
        skipped.push({
          meetsyTaskId: push.meetsyTaskId,
          reason: `enqueue_failed:${(err as Error).message}`,
        });
      }
    }

    this.logger.log(
      `Retry request for run ${runId}: ${enqueued.length} enqueued, ${skipped.length} skipped`,
    );
    return { enqueued, skipped };
  }
}
