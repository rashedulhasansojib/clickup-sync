-- Meetsy Phase 2a — minimal knowledge-base slice (pgvector + hybrid search).
--
-- HAND-FINISHED (see 0001_init_meetsy_schema for why we never `migrate dev`):
-- Prisma emits the KbChunk/KbSyncState tables, but it cannot express the pgvector
-- `embedding` column, the generated `tsv` column, or the HNSW/GIN indexes — those
-- are added by hand below. Emits DDL for the `meetsy` schema ONLY.
--
-- PREREQUISITES (operator, run as superuser BEFORE this migration — see
-- prisma/grants.sql):
--   1. `CREATE EXTENSION IF NOT EXISTS vector;`   (the pgvector type/operators)
--   2. the meetsy role's search_path includes `public` (where the extension
--      installs), so the bare `<=>` operator resolves at query time.
-- This migration does NOT `CREATE EXTENSION` (the least-privilege meetsy role
-- can't) and does NOT `CREATE SCHEMA`. Vector type + opclass are schema-qualified
-- (`public.vector` / `public.vector_cosine_ops`) so the column/index resolve
-- regardless of the role's search_path. Do NOT apply here — the orchestrator
-- applies + live-verifies (incl. the pgvector image swap).

-- CreateEnum
CREATE TYPE "meetsy"."KbSourceType" AS ENUM ('clickup_task', 'transcript', 'document');

-- CreateTable
CREATE TABLE "meetsy"."KbChunk" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceType" "meetsy"."KbSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    -- pgvector embedding (hand-added; not modeled by Prisma's table emit).
    "embedding" public.vector(1024),
    "status" TEXT,
    "assignee" TEXT,
    "component" TEXT,
    "client" TEXT,
    "department" TEXT,
    "taskUpdatedAt" TIMESTAMP(3),
    "embeddingModel" TEXT,
    "embeddingDims" INTEGER NOT NULL,
    "embeddingVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    -- Generated tsvector for the keyword half of hybrid search (hand-added; no
    -- Prisma field). Recomputes automatically whenever `content` changes.
    "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("content", ''))) STORED,

    CONSTRAINT "KbChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetsy"."KbSyncState" (
    "workspaceId" TEXT NOT NULL,
    "lastTaskCursor" TIMESTAMP(3),
    "embeddedCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastRunAt" TIMESTAMP(3),

    CONSTRAINT "KbSyncState_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "KbChunk_workspaceId_sourceType_sourceId_chunkIndex_key" ON "meetsy"."KbChunk"("workspaceId", "sourceType", "sourceId", "chunkIndex");

-- CreateIndex
CREATE INDEX "KbChunk_workspaceId_sourceType_idx" ON "meetsy"."KbChunk"("workspaceId", "sourceType");

-- CreateIndex (vector — HNSW for cosine ANN; opclass schema-qualified).
CREATE INDEX "KbChunk_embedding_hnsw_idx" ON "meetsy"."KbChunk" USING hnsw ("embedding" public.vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- CreateIndex (keyword — GIN on the generated tsvector).
CREATE INDEX "KbChunk_tsv_gin_idx" ON "meetsy"."KbChunk" USING gin ("tsv");
