import { Injectable, Logger } from "@nestjs/common";
import { Observable } from "rxjs";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "../config/config.service";
import { createRedis } from "../analysis/queue/redis";
import { ClicksyAdminClient } from "./clicksy-admin.client";
import { KbProgressEvent, KbQueue, kbChannel } from "./kb.queue";
import { hasCoverageGap, lookbackDaysForRange, type KbRange } from "./kb.dto";

/** The queue name Clicksy logs space backfills under (Clicksy QUEUES constant). */
const CLICKSY_BACKFILL_QUEUE = "clickup-backfills";

export interface KbStatusView {
  status: string;
  embeddedCount: number;
  total: number;
  lastRunAt: string | null;
}

/**
 * Orchestrates KB onboarding's HTTP-facing entry + the (slow) coverage step.
 *
 * onboard() responds fast: it marks the workspace `onboarding` and enqueues the
 * job. The WORKER then calls ensureCoverage() (which may trigger a Clicksy
 * backfill + poll for minutes) before embedding — keeping the heavy/slow work
 * off the request path, mirroring AnalysisService.confirmRoster() → worker.
 */
@Injectable()
export class KbOnboardingService {
  private readonly logger = new Logger(KbOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clicksy: ClicksyAdminClient,
    private readonly queue: KbQueue,
    private readonly config: ConfigService,
  ) {}

  /** POST /workspaces/:id/kb/onboard — mark onboarding + enqueue (fast). */
  async onboard(workspaceId: string, range: KbRange): Promise<KbStatusView> {
    await this.prisma.kbSyncState.upsert({
      where: { workspaceId },
      create: { workspaceId, status: "onboarding", lastRunAt: new Date() },
      update: { status: "onboarding", lastRunAt: new Date() },
    });
    await this.queue.enqueue({ workspaceId, range });
    return this.status(workspaceId);
  }

  /** GET /workspaces/:id/kb/status. */
  async status(workspaceId: string): Promise<KbStatusView> {
    const [state, total] = await Promise.all([
      this.prisma.kbSyncState.findUnique({ where: { workspaceId } }),
      this.prisma.clickupTask.count({ where: { workspaceId, isDeleted: false } }),
    ]);
    return {
      status: state?.status ?? "idle",
      embeddedCount: state?.embeddedCount ?? 0,
      total,
      lastRunAt: state?.lastRunAt ? state.lastRunAt.toISOString() : null,
    };
  }

  /**
   * GET /workspaces/:id/kb/status/stream — optional SSE of onboarding progress.
   * Subscribes to the worker's Redis progress channel; completes when the run
   * reaches a terminal state. Mirrors AnalysisService.streamRun (lean variant).
   */
  streamProgress(workspaceId: string): Observable<{ data: KbProgressEvent }> {
    return new Observable<{ data: KbProgressEvent }>((subscriber) => {
      const { host, port } = this.config.redis;
      const redis = createRedis(host, port);
      redis.on("message", (_channel, payload) => {
        try {
          const event = JSON.parse(payload) as KbProgressEvent;
          subscriber.next({ data: event });
          if (event.status === "ready" || event.status === "error") subscriber.complete();
        } catch {
          this.logger.warn(`Dropping malformed KB progress event on ${kbChannel(workspaceId)}`);
        }
      });
      void redis.subscribe(kbChannel(workspaceId)).then(async () => {
        // Late-subscriber catch-up: if already terminal, emit + complete.
        const state = await this.prisma.kbSyncState.findUnique({ where: { workspaceId } });
        if (state && (state.status === "ready" || state.status === "error")) {
          subscriber.next({
            data: {
              workspaceId,
              status: state.status,
              embedded: state.embeddedCount,
              total: state.embeddedCount,
              message: `Onboarding ${state.status}`,
              at: Date.now(),
            },
          });
          subscriber.complete();
        }
      });
      return () => redis.disconnect();
    });
  }

  /**
   * Coverage check (worker-side): for each of the workspace's spaces, if Clicksy
   * has mirrored a narrower window than requested, trigger a task + comment
   * backfill, then poll until they drain. Degrades to a no-op when Clicksy admin
   * is unconfigured/unreachable so onboarding embeds whatever IS mirrored.
   */
  async ensureCoverage(workspaceId: string, range: KbRange): Promise<void> {
    const requestedDays = lookbackDaysForRange(range);
    const spaces = await this.prisma.workspaceSpace.findMany({
      where: { workspaceId, enabled: true },
      select: { spaceId: true },
    });
    if (spaces.length === 0) {
      this.logger.log(`No spaces configured for workspace ${workspaceId}; skipping coverage check`);
      return;
    }
    if (!this.clicksy.isConfigured) {
      this.logger.warn(
        `Clicksy admin not configured (CLICKSY_ADMIN_URL / ADMIN_API_KEY); embedding already-mirrored data only`,
      );
      return;
    }

    const gappy: string[] = [];
    for (const { spaceId } of spaces) {
      const mirroredDays = await this.mirroredDaysForSpace(workspaceId, spaceId);
      if (hasCoverageGap(requestedDays, mirroredDays)) gappy.push(spaceId);
    }
    if (gappy.length === 0) {
      this.logger.log(`Workspace ${workspaceId} already covers the requested ${requestedDays}d window`);
      return;
    }

    this.logger.log(`Triggering Clicksy backfill for ${gappy.length} space(s): ${gappy.join(", ")}`);
    let triggered = false;
    // Clicksy's backfill caps lookbackDays at 3650; the "all" range (36_500) and any
    // value above the cap must be clamped or Clicksy rejects with 400. The KB's own
    // embed window is unaffected (it embeds whatever ends up mirrored).
    const backfillDays = Math.min(requestedDays, 3650);
    for (const spaceId of gappy) {
      const t = await this.clicksy.triggerTaskBackfill(workspaceId, spaceId, backfillDays);
      const c = await this.clicksy.triggerCommentBackfill(workspaceId, spaceId);
      triggered = triggered || t || c;
    }
    // Wait only until tasks are mirrored; let time-entry sync continue async in
    // Clicksy (the embed doesn't need it). See pollUntilTasksFetched.
    if (triggered) await this.clicksy.pollUntilTasksFetched(workspaceId);
  }

  /**
   * Widest backfill lookback (days) Clicksy has COMPLETED for a space — read from
   * its `sync_job_logs` (queue `clickup-backfills`, entity `space`). 0 if none.
   * The DB shape is live-verified by the orchestrator; the gap decision math
   * (`hasCoverageGap`) is unit-tested.
   */
  private async mirroredDaysForSpace(workspaceId: string, spaceId: string): Promise<number> {
    const rows = await this.prisma.syncJobLog.findMany({
      where: {
        workspaceId,
        queueName: CLICKSY_BACKFILL_QUEUE,
        entityType: "space",
        entityId: spaceId,
        status: "completed",
      },
      select: { payload: true },
    });
    let max = 0;
    for (const r of rows) {
      const days = (r.payload as { lookbackDays?: unknown } | null)?.lookbackDays;
      if (typeof days === "number" && days > max) max = days;
    }
    return max;
  }
}
