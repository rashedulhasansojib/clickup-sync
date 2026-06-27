-- ClickUp task comment sync (purely additive). Mirrors the no-FK append-log
-- pattern of clickup_task_events: a plain indexed task_id with NO foreign key,
-- so a taskCommentPosted webhook that arrives before the task is mirrored still
-- inserts. parent_comment_id is reserved (nullable) for future threaded replies.

-- AlterTable: comment-completeness markers on clickup_tasks
ALTER TABLE "clickup_tasks" ADD COLUMN "comments_synced_at" TIMESTAMP(3);
ALTER TABLE "clickup_tasks" ADD COLUMN "comment_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "clickup_task_comments" (
    "comment_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "parent_comment_id" TEXT,
    "comment_text" TEXT,
    "user_id" TEXT,
    "user_name" TEXT,
    "user_email" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "assignee_id" TEXT,
    "assignee_name" TEXT,
    "reply_count" INTEGER NOT NULL DEFAULT 0,
    "reactions" JSONB,
    "comment_date" TIMESTAMP(3),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sync_count" INTEGER NOT NULL DEFAULT 0,
    "raw" JSONB,

    CONSTRAINT "clickup_task_comments_pkey" PRIMARY KEY ("comment_id")
);

-- CreateIndex
CREATE INDEX "clickup_task_comments_task_id_idx" ON "clickup_task_comments"("task_id");
CREATE INDEX "clickup_task_comments_workspace_id_comment_date_idx" ON "clickup_task_comments"("workspace_id", "comment_date");
