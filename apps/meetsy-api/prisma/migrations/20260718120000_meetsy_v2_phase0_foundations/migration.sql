-- Meetsy v2 Phase 0 — foundations: per-workspace ML tunables + run snapshot +
-- newest-first index on AnalysisRun for the runs-list endpoint.
--
-- HAND-AUTHORED. Emits DDL for the `meetsy` schema ONLY (two new tables + one
-- new index on an existing table). Do NOT alter `public` — Meetsy has no write
-- privileges there. The orchestrator applies migrations; do NOT apply here.
--
-- Design notes (see docs/superpowers/specs/2026-07-18-meetsy-v2-phase0-foundations-design.md):
--   * WorkspaceMlConfig: one row per workspace, PK = workspaceId. `tunables`
--     and `models` are Zod-validated JSONB (shapes in @ma/shared/ml-config).
--     Read today via MlConfigService (falls back to defaults when absent);
--     written by Phase 5's /tuning UI (future).
--   * AnalysisRunSnapshot: 1:1 with AnalysisRun via runId FK (cascade delete).
--     Written on run completion so Phase 5 preview can replay the exact
--     parameters used. Append-only.
--   * The new (workspace_id, created_at DESC) index on AnalysisRun powers the
--     paginated GET /workspaces/:id/runs endpoint.

-- CreateTable
CREATE TABLE "meetsy"."WorkspaceMlConfig" (
    "workspace_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "tunables" JSONB NOT NULL,
    "models" JSONB NOT NULL,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceMlConfig_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateIndex
CREATE INDEX "WorkspaceMlConfig_org_id_idx" ON "meetsy"."WorkspaceMlConfig"("org_id");

-- CreateTable
CREATE TABLE "meetsy"."AnalysisRunSnapshot" (
    "run_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tunables" JSONB NOT NULL,
    "models" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisRunSnapshot_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE INDEX "AnalysisRunSnapshot_workspace_id_idx" ON "meetsy"."AnalysisRunSnapshot"("workspace_id");

-- AddForeignKey
ALTER TABLE "meetsy"."AnalysisRunSnapshot"
    ADD CONSTRAINT "AnalysisRunSnapshot_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "meetsy"."AnalysisRun"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex — powers GET /workspaces/:id/runs (paginated, newest first).
-- NOTE: `createdAt` is camelCase in AnalysisRun (no @map), unlike the new tables
-- above whose Prisma models @map every column to snake_case.
CREATE INDEX "AnalysisRun_workspaceId_createdAt_idx"
    ON "meetsy"."AnalysisRun"("workspace_id", "createdAt");
