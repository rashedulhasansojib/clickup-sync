import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type IORedis from "ioredis";
import { Observable } from "rxjs";
import { ConfigService } from "../config/config.service";
import { createRedis } from "../analysis/queue/redis";
import type { LearnField } from "./learning.service";
import { MIN_CORRECTIONS, NEAR_GATE_THRESHOLD } from "./learning-aggregate";

/**
 * v2 Phase 3 (PR-N) — Redis pub/sub for workspace-scoped near-gate + gate-passed
 * events. When `push.service.logFieldOverride` increments a pattern's organic
 * count to `NEAR_GATE_THRESHOLD` (2 of 3) or to `MIN_CORRECTIONS` (the gate),
 * we publish here; the `/learning/stream` SSE endpoint forwards to the UI so
 * Sonner can toast "one more correction and this pattern will start nudging."
 *
 * Mirrors `kbChannel`/`streamProgress` (`kb.queue.ts:11` + `kb-onboarding.service.ts:206`)
 * — dedicated publisher connection, per-subscription subscriber connection,
 * teardown on client disconnect. No late-subscriber catch-up: events are
 * transient by design — a client that missed one will re-derive the pattern's
 * state from the summary on the next `/learning` page load.
 */
export interface LearningEvent {
  workspaceId: string;
  field: LearnField;
  predicted: string;
  confirmed: string;
  /** The count AFTER the write that triggered this event. */
  count: number;
  at: number;
  kind: "near-gate" | "gate-passed";
}

export const learningChannel = (workspaceId: string): string =>
  `meetsy-learning:${workspaceId}`;

/** Post-write threshold decision. Kept pure so `push.service` can call the
 * publisher only when the write actually crossed a threshold. Returns `null`
 * when the pattern isn't newly-interesting (count outside {near, gate}).
 *
 * v2 Phase 5 — `minCorrections` is optional; defaults to the module constant
 * so existing tests + callers keep working. The near-gate threshold is derived
 * as `minCorrections - 1` (matches `LearningService.gate(...)`). */
export function classifyThreshold(
  count: number,
  minCorrections: number = MIN_CORRECTIONS,
): LearningEvent["kind"] | null {
  const near = Math.max(minCorrections - 1, 0);
  if (count === near) return "near-gate";
  if (count === minCorrections) return "gate-passed";
  return null;
}

@Injectable()
export class LearningStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LearningStreamService.name);
  private publisher!: IORedis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const { host, port } = this.config.redis;
    this.publisher = createRedis(host, port);
    this.logger.log("Learning stream publisher ready");
  }

  /** Fire-and-forget publish. Best-effort; a Redis miss only loses a toast. */
  async publish(event: LearningEvent): Promise<void> {
    try {
      await this.publisher.publish(learningChannel(event.workspaceId), JSON.stringify(event));
    } catch (err) {
      this.logger.warn(
        `Learning event publish failed for workspace ${event.workspaceId}: ${(err as Error).message}`,
      );
    }
  }

  /** Observable feed of events for a workspace; consumed by the SSE endpoint. */
  subscribe(workspaceId: string): Observable<{ data: LearningEvent }> {
    return new Observable<{ data: LearningEvent }>((subscriber) => {
      const { host, port } = this.config.redis;
      const redis = createRedis(host, port);
      redis.on("message", (_channel, payload) => {
        try {
          const event = JSON.parse(payload) as LearningEvent;
          subscriber.next({ data: event });
        } catch {
          this.logger.warn(
            `Dropping malformed learning event on ${learningChannel(workspaceId)}`,
          );
        }
      });
      void redis.subscribe(learningChannel(workspaceId)).catch((err) => {
        subscriber.error(err);
      });
      // Teardown on client disconnect (Nest's @Sse handler unsubscribes).
      return () => redis.disconnect();
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.publisher?.disconnect();
  }
}
