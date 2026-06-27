import IORedis, { RedisOptions } from "ioredis";

/**
 * Shared Redis connection helpers.
 *
 * BullMQ REQUIRES `maxRetriesPerRequest: null` on its blocking connection or it
 * throws at startup — so we centralize the options here and reuse them for the
 * Queue, the Worker, and the SSE pub/sub clients.
 */
export const ANALYSIS_QUEUE_NAME = "analysis";

/** Pub/sub channel for a run's live progress events. */
export const runChannel = (runId: string): string => `run:${runId}`;

export function buildRedisOptions(host: string, port: number): RedisOptions {
  return {
    host,
    port,
    // Required by BullMQ blocking commands; safe for pub/sub too.
    maxRetriesPerRequest: null,
  };
}

export function createRedis(host: string, port: number): IORedis {
  return new IORedis(buildRedisOptions(host, port));
}
