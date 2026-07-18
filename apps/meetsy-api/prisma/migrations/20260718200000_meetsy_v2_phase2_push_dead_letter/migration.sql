-- Meetsy v2 Phase 2 (PR-I) — permanently-failed push jobs.
--
-- HAND-AUTHORED. Emits DDL for the `meetsy` schema ONLY (one new table).
-- Do NOT alter `public` — Meetsy has no write privileges there. The
-- orchestrator applies migrations; do NOT apply here.
--
-- Design notes (see docs/superpowers/specs/2026-07-18-meetsy-v2-phase2-evidence-review-design.md §3.2):
--   * PushDeadLetter: append-only. Written by the meetsy-push-retry BullMQ
--     worker when a job exhausts BullMQ `attempts` (default 4 in the worker).
--     The matching TaskPush row stays at status="failed" — dead-lettered ≠
--     lost. Resolution via POST /workspaces/:id/push/dead-letter/:id/resolve.
--   * (runId, meetsyTaskId) is NOT unique here — a workspace may have several
--     dead-letters over time for the same task if operators re-retry after
--     addressing the root cause. Uniqueness at push-level lives in TaskPush.
--   * Column names are the meetsy-schema convention (camelCase, no @map),
--     matching TaskPush + FieldOverride.

-- CreateTable
CREATE TABLE "meetsy"."PushDeadLetter" (
    "id"           TEXT NOT NULL,
    "runId"        TEXT NOT NULL,
    "meetsyTaskId" TEXT NOT NULL,
    "workspaceId"  TEXT NOT NULL,
    "jobId"        TEXT NOT NULL,
    "payload"      JSONB NOT NULL,
    "errorMessage" TEXT,
    "errorStack"   TEXT,
    "attemptsMade" INTEGER NOT NULL DEFAULT 0,
    "failedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retriedAt"    TIMESTAMP(3),
    "resolvedAt"   TIMESTAMP(3),
    "resolvedBy"   TEXT,

    CONSTRAINT "PushDeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — workspace-scoped list ("show me all unresolved dead-letters").
CREATE INDEX "PushDeadLetter_workspaceId_idx" ON "meetsy"."PushDeadLetter"("workspaceId");

-- CreateIndex — per-run lookup (POST /runs/:id/push/retry surfaces dead-letters).
CREATE INDEX "PushDeadLetter_runId_idx" ON "meetsy"."PushDeadLetter"("runId");
