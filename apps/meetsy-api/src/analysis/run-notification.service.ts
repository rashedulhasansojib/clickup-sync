import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type IORedis from "ioredis";
import { Observable } from "rxjs";
import { ConfigService } from "../config/config.service";
import { createRedis } from "./queue/redis";

/**
 * Workspace-scoped run notification channel — mirrors `LearningStreamService`
 * (`kb/learning-stream.service.ts`). The per-run SSE stream at
 * `GET /runs/:id/stream` only fires while a client is on the run page; this
 * channel lets a user who navigated away (or is on `/home` / `/meetings`) still
 * see a Sonner toast the moment their run completes, fails, or is cancelled.
 *
 * No late-subscriber catch-up: events are transient by design (same rationale
 * as the learning stream). A client that missed a toast can always re-derive
 * state from `GET /workspaces/:id/runs`.
 */
export interface RunNotificationEvent {
  workspaceId: string;
  runId: string;
  meetingTitle: string;
  kind: "completed" | "failed" | "cancelled";
  /** Only present when `kind === "failed"`. Short human-readable reason. */
  message?: string;
  at: number;
}

export const runsChannel = (workspaceId: string): string =>
  `meetsy-runs:${workspaceId}`;

@Injectable()
export class RunNotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunNotificationService.name);
  private publisher!: IORedis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const { host, port } = this.config.redis;
    this.publisher = createRedis(host, port);
    this.logger.log("Run notification publisher ready");
  }

  /**
   * Fire-and-forget publish called by the processor on any terminal state.
   * Best-effort — a Redis miss only loses a cross-page toast; the run row
   * itself is authoritative and any refresh will show the correct state.
   */
  async publish(event: Omit<RunNotificationEvent, "at">): Promise<void> {
    const payload: RunNotificationEvent = { ...event, at: Date.now() };
    try {
      await this.publisher.publish(runsChannel(event.workspaceId), JSON.stringify(payload));
    } catch (err) {
      this.logger.warn(
        `Run notification publish failed for workspace ${event.workspaceId}: ${(err as Error).message}`,
      );
    }
  }

  /** Observable feed for the SSE endpoint. */
  subscribe(workspaceId: string): Observable<{ data: RunNotificationEvent }> {
    return new Observable<{ data: RunNotificationEvent }>((subscriber) => {
      const { host, port } = this.config.redis;
      const redis = createRedis(host, port);
      redis.on("message", (_channel, payload) => {
        try {
          const event = JSON.parse(payload) as RunNotificationEvent;
          subscriber.next({ data: event });
        } catch {
          this.logger.warn(
            `Dropping malformed run notification on ${runsChannel(workspaceId)}`,
          );
        }
      });
      void redis.subscribe(runsChannel(workspaceId)).catch((err) => {
        subscriber.error(err);
      });
      return () => redis.disconnect();
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.publisher?.disconnect();
  }
}
