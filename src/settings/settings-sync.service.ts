import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import type { Redis, Cluster } from 'ioredis';
import { QueueService } from '../queues/queue.service';
import { SettingsService } from './settings.service';

/** Redis pub/sub channel carrying "the `app_settings` row changed — reload". */
export const SETTINGS_CHANGED_CHANNEL = 'clicksy:settings:changed';

/**
 * Cross-process invalidation for the `SettingsService` cache.
 *
 * `SettingsService` keeps `app_settings` in an in-memory cache so the hot-path
 * consumers (ClickUp client headers, the webhook signature guard) can stay
 * synchronous. It refreshes at boot and after **its own process's** writes —
 * which is silently wrong the moment two processes are running.
 *
 * The failure this exists to prevent: `WebhookHealthService` runs only in the
 * worker (`ScheduleModule` is gated on `isWorker()`). When ClickUp suspends the
 * webhook it escalates to delete+recreate, minting a NEW signing secret and
 * refreshing the worker's cache. The web process — which is the one that
 * actually verifies signatures — kept serving the old secret, so every ClickUp
 * delivery failed HMAC and got a 401. Because the guard runs before the
 * controller, nothing reached `clickup_webhook_events` OR `clickup_webhook_seen`,
 * making the outage invisible in the data. ClickUp then suspended the webhook,
 * auto-heal rotated again, and the loop could only be broken by restarting web.
 * Production ran ~4 days with zero real-time webhooks this way (2026-08-21 →
 * 2026-08-25).
 *
 * Every writer publishes; every process (including the publisher's peers)
 * reloads. Self-published messages are skipped because the writer already
 * refreshed synchronously.
 *
 * Degradation: if Redis is unreachable we log loudly and carry on with
 * boot-time settings rather than failing startup — a stale cache is bad, but a
 * web process that refuses to boot is worse. The subscriber reconnects on its
 * own (ioredis) and re-subscribes via the `ready` handler.
 */
@Injectable()
export class SettingsSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettingsSyncService.name);
  /** Identifies this process so it can ignore the message it published itself. */
  private readonly instanceId = crypto.randomUUID();
  private subscriber: Redis | Cluster | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly queues: QueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Registered before the Redis wiring so a publish still happens (and is a
    // no-op) even if the subscribe below fails.
    this.settings.registerChangePublisher(() => {
      void this.publish();
    });

    try {
      const client = await this.queues.redis();
      // A connection in subscriber mode cannot run ordinary commands, so the
      // shared BullMQ connection must NOT be reused here — duplicate it.
      const sub = client.duplicate();
      this.subscriber = sub;
      sub.on('message', (_channel: string, message: string) => this.onMessage(message));
      sub.on('error', (err: Error) => this.logger.error(`Settings-sync subscriber error: ${err.message}`));
      // ioredis re-emits `ready` after a reconnect; re-subscribing is idempotent
      // and stops a dropped connection from silently ending invalidation.
      sub.on('ready', () => {
        void sub
          .subscribe(SETTINGS_CHANGED_CHANNEL)
          .catch((err: Error) => this.logger.error(`Failed to re-subscribe after reconnect: ${err.message}`));
      });
      await sub.subscribe(SETTINGS_CHANGED_CHANNEL);
      this.logger.log(`Settings cache invalidation active on ${SETTINGS_CHANGED_CHANNEL} (instance ${this.instanceId})`);
    } catch (err) {
      this.logger.error(
        `Could not subscribe to ${SETTINGS_CHANGED_CHANNEL} — this process will NOT see settings changed by another ` +
          `process (a rotated webhook secret will 401 every delivery until restart). ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.subscriber) return;
    try {
      await this.subscriber.unsubscribe(SETTINGS_CHANGED_CHANNEL);
      await this.subscriber.quit();
    } catch {
      // Shutdown path — a Redis that's already gone must not block exit.
    }
  }

  private onMessage(message: string): void {
    let from: string | undefined;
    try {
      from = (JSON.parse(message) as { from?: string }).from;
    } catch {
      // Unparseable payload: refresh anyway. A spurious DB read is far cheaper
      // than missing a real rotation.
    }
    if (from && from === this.instanceId) return; // we already refreshed
    this.settings
      .refresh()
      .then(() => this.logger.log('Settings cache reloaded after a change published by another process'))
      .catch((err: Error) => this.logger.error(`Settings refresh after invalidation failed: ${err.message}`));
  }

  private async publish(): Promise<void> {
    try {
      const client = await this.queues.redis();
      await client.publish(SETTINGS_CHANGED_CHANNEL, JSON.stringify({ from: this.instanceId }));
    } catch (err) {
      this.logger.error(
        `Failed to publish a settings change — other processes will keep a stale cache until restart. ${(err as Error).message}`,
      );
    }
  }
}
