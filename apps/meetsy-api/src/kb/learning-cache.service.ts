import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type IORedis from "ioredis";
import { ConfigService } from "../config/config.service";
import { createRedis } from "../analysis/queue/redis";
import type { LearningSnapshot } from "./learning.service";

/**
 * v2 Phase 3 (PR-M) — Redis-backed cache for `LearningService.snapshot()`.
 *
 * Before Phase 3, `snapshot()` scanned every FieldOverride row on every call
 * (twice per push, once per /learning page load — see spec §3.2). At 10k+
 * pushes that's a real cost. The cache is a thin JSON KV around IORedis:
 *
 *  - Key: `meetsy:learning:snapshot:v1:{workspaceId}`. The `v1` guards a
 *    future snapshot-shape change (new field, added metric) from reading a
 *    stale value written by an older server.
 *  - Value: `JSON.stringify(LearningSnapshot)`.
 *  - Write TTL: 1 hour. Belt-and-braces for the case where hard invalidation
 *    (see below) fails; correctness still holds because "nudges only get
 *    worse if stale, they don't break."
 *  - Hard invalidation: `invalidate(workspaceId)` DELs the key. Called from
 *    `push.service.logFieldOverride` after the DB write.
 *
 * The service is a NON-critical dependency: every method treats Redis
 * failures as a miss and logs, so a Redis outage degrades to Phase-2's
 * always-hit-the-DB behavior rather than blocking the push flow.
 */
@Injectable()
export class LearningCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LearningCacheService.name);
  private client!: IORedis;
  private readonly ttlSeconds = 60 * 60;
  private readonly keyPrefix = "meetsy:learning:snapshot:v1:";

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const { host, port } = this.config.redis;
    this.client = createRedis(host, port);
    this.logger.log("Learning snapshot cache ready");
  }

  private key(workspaceId: string): string {
    return `${this.keyPrefix}${workspaceId}`;
  }

  async read(workspaceId: string): Promise<LearningSnapshot | null> {
    try {
      const raw = await this.client.get(this.key(workspaceId));
      if (!raw) return null;
      return JSON.parse(raw) as LearningSnapshot;
    } catch (err) {
      this.logger.warn(
        `Cache read failed for workspace ${workspaceId}; falling through to DB: ${(err as Error).message}`,
      );
      return null;
    }
  }

  async write(workspaceId: string, snap: LearningSnapshot): Promise<void> {
    try {
      await this.client.set(
        this.key(workspaceId),
        JSON.stringify(snap),
        "EX",
        this.ttlSeconds,
      );
    } catch (err) {
      this.logger.warn(
        `Cache write failed for workspace ${workspaceId}: ${(err as Error).message}`,
      );
    }
  }

  async invalidate(workspaceId: string): Promise<void> {
    try {
      await this.client.del(this.key(workspaceId));
    } catch (err) {
      // Bounded-staleness posture: a failed DEL means at most `ttlSeconds` of
      // stale data. Log and move on; the next successful write will refresh.
      this.logger.warn(
        `Cache invalidation failed for workspace ${workspaceId}: ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.client?.disconnect();
  }
}
