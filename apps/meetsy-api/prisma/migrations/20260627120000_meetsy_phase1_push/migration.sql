-- Meetsy Phase 1 — ClickUp write-back tables.
--
-- Hand-authored (see 0001_init_meetsy_schema for why): emits DDL for the
-- `meetsy` schema ONLY. NO `CREATE SCHEMA` — the schema is provisioned by the
-- operator via prisma/grants.sql; the least-privilege `meetsy` role has CREATE
-- on the schema but not the database, so a CREATE SCHEMA here fails with
-- "permission denied for database". Migrations create only tables/types within
-- the pre-existing `meetsy` schema. The `public.*` read-models are unmanaged and
-- must NEVER be created/altered here.

-- CreateEnum
CREATE TYPE "meetsy"."PushStatus" AS ENUM ('pushed', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "meetsy"."WorkspacePushConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetListId" TEXT NOT NULL,
    "targetListName" TEXT,
    "assignableMembers" JSONB NOT NULL,
    "defaultStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "WorkspacePushConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetsy"."TaskPush" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "meetsyTaskId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clickupTaskId" TEXT,
    "clickupUrl" TEXT,
    "status" "meetsy"."PushStatus" NOT NULL,
    "error" TEXT,
    "payload" JSONB NOT NULL,
    "pushedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskPush_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspacePushConfig_workspaceId_key" ON "meetsy"."WorkspacePushConfig"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskPush_runId_meetsyTaskId_key" ON "meetsy"."TaskPush"("runId", "meetsyTaskId");

-- CreateIndex
CREATE INDEX "TaskPush_workspaceId_idx" ON "meetsy"."TaskPush"("workspaceId");
