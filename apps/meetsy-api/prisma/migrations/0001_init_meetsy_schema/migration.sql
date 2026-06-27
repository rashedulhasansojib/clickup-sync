-- Meetsy init migration.
--
-- UNAPPLIED / hand-authored: created without a live DB (Prisma multiSchema
-- preview on Prisma 5.22 + no Docker in this step). Apply later with
-- `prisma migrate deploy` AFTER `prisma/grants.sql` has provisioned the meetsy
-- role + schema. This emits DDL for the `meetsy` schema ONLY — the `public.*`
-- models in schema.prisma are unmanaged read-only mirrors of Clicksy's tables
-- and must NEVER be created/altered by Meetsy.
--
-- NOTE: never run `prisma migrate dev` for this project — with the public
-- read-models present Prisma would try to manage (create/alter) them. Always
-- hand-author migrations or use `migrate dev --create-only` and strip any
-- public DDL before applying.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "meetsy";

-- CreateEnum
CREATE TYPE "meetsy"."RunStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "meetsy"."TaskVote" AS ENUM ('up', 'down');

-- CreateEnum
CREATE TYPE "meetsy"."ChatRole" AS ENUM ('user', 'assistant');

-- CreateTable
CREATE TABLE "meetsy"."Meeting" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "transcript" TEXT NOT NULL,
    "normalizedTranscript" TEXT,
    "meetingDate" TIMESTAMP(3),
    "roster" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetsy"."AnalysisRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "status" "meetsy"."RunStatus" NOT NULL DEFAULT 'queued',
    "result" JSONB,
    "error" TEXT,
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "llmCalls" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetsy"."Feedback" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "vote" "meetsy"."TaskVote" NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetsy"."ChatMessage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "role" "meetsy"."ChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Meeting_orgId_idx" ON "meetsy"."Meeting"("orgId");

-- CreateIndex
CREATE INDEX "Meeting_workspace_id_idx" ON "meetsy"."Meeting"("workspace_id");

-- CreateIndex
CREATE INDEX "AnalysisRun_orgId_idx" ON "meetsy"."AnalysisRun"("orgId");

-- CreateIndex
CREATE INDEX "AnalysisRun_workspace_id_idx" ON "meetsy"."AnalysisRun"("workspace_id");

-- CreateIndex
CREATE INDEX "AnalysisRun_meetingId_idx" ON "meetsy"."AnalysisRun"("meetingId");

-- CreateIndex
CREATE INDEX "Feedback_runId_idx" ON "meetsy"."Feedback"("runId");

-- CreateIndex
CREATE INDEX "Feedback_orgId_idx" ON "meetsy"."Feedback"("orgId");

-- CreateIndex
CREATE INDEX "ChatMessage_runId_idx" ON "meetsy"."ChatMessage"("runId");

-- AddForeignKey
ALTER TABLE "meetsy"."AnalysisRun" ADD CONSTRAINT "AnalysisRun_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetsy"."Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetsy"."Feedback" ADD CONSTRAINT "Feedback_runId_fkey" FOREIGN KEY ("runId") REFERENCES "meetsy"."AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetsy"."ChatMessage" ADD CONSTRAINT "ChatMessage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "meetsy"."AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
