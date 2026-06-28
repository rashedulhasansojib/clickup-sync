-- Meetsy Phase 2c.3 — HITL push extension (client/sprint/points config + override log).
--
-- HAND-AUTHORED (see 0001_init_meetsy_schema). Emits DDL for the `meetsy` schema
-- ONLY. Adds nullable HITL columns to WorkspacePushConfig + the FieldOverride
-- table. Does NOT touch public.*. Do NOT apply here — the orchestrator applies.

-- AlterTable
ALTER TABLE "meetsy"."WorkspacePushConfig"
  ADD COLUMN "clientFieldId" TEXT,
  ADD COLUMN "clientFieldName" TEXT,
  ADD COLUMN "clientOptions" JSONB,
  ADD COLUMN "sprintLists" JSONB,
  ADD COLUMN "pointsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "meetsy"."FieldOverride" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "meetsyTaskId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "predicted" JSONB,
    "confirmed" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FieldOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FieldOverride_workspaceId_idx" ON "meetsy"."FieldOverride"("workspaceId");
CREATE INDEX "FieldOverride_runId_idx" ON "meetsy"."FieldOverride"("runId");
