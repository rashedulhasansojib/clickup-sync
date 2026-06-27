-- Meetsy Phase 2b — uploaded context documents + doc↔task links.
--
-- HAND-AUTHORED (see 0001_init_meetsy_schema / 20260628120000_meetsy_phase2a_kb
-- for why we never `migrate dev`). Emits DDL for the `meetsy` schema ONLY. It
-- does NOT `CREATE SCHEMA`/`CREATE EXTENSION` and does NOT touch the unmanaged
-- `public.*` read-models. Document chunks reuse the existing meetsy.KbChunk table
-- (sourceType='document'); no change to KbChunk is needed. Do NOT apply here —
-- the orchestrator applies + live-verifies.

-- CreateTable
CREATE TABLE "meetsy"."KbDocument" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    -- sha256 of the raw uploaded bytes — re-upload of identical bytes is a no-op.
    "sha256" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "pageCount" INTEGER,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    -- Extracted plain text (kept so a model/dim bump can re-chunk without the file).
    "extractedText" TEXT,
    -- pending | parsing | embedding | ready | error
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    -- Honest improvement metric (novelty + answerability-lift), never blended.
    "metric" JSONB,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KbDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetsy"."KbDocTaskLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    -- Plain soft-ref to public.clickup_tasks.task_id (no cross-schema FK).
    "taskId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KbDocTaskLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KbDocument_workspaceId_sha256_key" ON "meetsy"."KbDocument"("workspaceId", "sha256");

-- CreateIndex
CREATE INDEX "KbDocument_workspaceId_idx" ON "meetsy"."KbDocument"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "KbDocTaskLink_documentId_taskId_key" ON "meetsy"."KbDocTaskLink"("documentId", "taskId");

-- CreateIndex
CREATE INDEX "KbDocTaskLink_workspaceId_taskId_idx" ON "meetsy"."KbDocTaskLink"("workspaceId", "taskId");

-- AddForeignKey (within the meetsy schema only)
ALTER TABLE "meetsy"."KbDocTaskLink" ADD CONSTRAINT "KbDocTaskLink_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "meetsy"."KbDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
