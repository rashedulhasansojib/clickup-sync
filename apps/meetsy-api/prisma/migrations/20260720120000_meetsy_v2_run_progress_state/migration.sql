-- Meetsy v2 — Durable run-progress state + cancellation.
--
-- Hand-authored (see 0001_init_meetsy_schema): emits DDL for the `meetsy`
-- schema ONLY. NO `CREATE SCHEMA`, NO public DDL. Apply as the `meetsy` role.
--
-- Solves three UX bugs on the /runs/:id review page (spec `2026-07-20-meetsy-v2-sse-progress-polish`):
--   1. Hard reload during a run showed every step "pending" until the next
--      Redis event fired — nothing persisted. `currentStage` + `progress`
--      + `stageStartedAt` are written by the processor before each `emit()`
--      so `GET /runs/:id` can hydrate the stepper immediately.
--   2. Users had no way to abort a wrong upload mid-run. `cancelRequestedAt`
--      is set by `POST /runs/:id/cancel`; the processor checks between stages
--      and terminates with the new `cancelled` status.
--   3. Users had no sense of duration. `startedAt` / `finishedAt` /
--      `stageDurations` let the stepper show per-stage timers and a rolling
--      "typical duration" hint (median across the last N completed runs).
--
-- All columns are nullable / have safe defaults so existing rows migrate
-- without a backfill. The `cancelled` enum value is additive.

-- AlterEnum
ALTER TYPE "meetsy"."RunStatus" ADD VALUE 'cancelled';

-- AlterTable
ALTER TABLE "meetsy"."AnalysisRun"
    ADD COLUMN "current_stage" TEXT,
    ADD COLUMN "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN "stage_started_at" TIMESTAMP(3),
    ADD COLUMN "started_at" TIMESTAMP(3),
    ADD COLUMN "finished_at" TIMESTAMP(3),
    ADD COLUMN "stage_durations" JSONB,
    ADD COLUMN "cancel_requested_at" TIMESTAMP(3);
