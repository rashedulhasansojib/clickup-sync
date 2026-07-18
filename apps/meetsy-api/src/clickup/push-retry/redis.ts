/**
 * v2 Phase 2 (PR-I) — BullMQ queue name for retrying failed pushes. Kept in a
 * dedicated module (mirroring `analysis/queue/redis.ts`) so the queue name is
 * a single source of truth for producer + worker + tests.
 */
export const PUSH_RETRY_QUEUE_NAME = "meetsy-push-retry";
