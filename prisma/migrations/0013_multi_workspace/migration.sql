-- Multi-workspace support: introduce per-workspace ClickUp connections so one
-- org can connect several ClickUp workspaces, each rendered as its own isolated
-- dashboard. Adds a `workspaces` + `workspace_spaces` table, stamps a
-- `workspace_id` FK on every ClickUp data table, seeds the existing data into a
-- default "Nifty" workspace (team 3450636), and retires the per-connection
-- columns from the singleton `app_settings` row (they move onto `workspaces`).
--
-- The FK column is added nullable, backfilled to the seed workspace, then set
-- NOT NULL — so existing rows never violate the constraint.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. New tables
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clickup_team_id" TEXT NOT NULL,
    "clickup_api_token_enc" TEXT,
    "webhook_secret_enc" TEXT,
    "webhook_endpoint" TEXT,
    "webhook_events" TEXT,
    "webhook_id" TEXT,
    "spike_hours_cap" INTEGER NOT NULL DEFAULT 12,
    "preferences" JSONB,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspaces_org_id_idx" ON "workspaces"("org_id");

-- CreateTable
CREATE TABLE "workspace_spaces" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "backfill_lookback_days" INTEGER NOT NULL DEFAULT 30,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_spaces_workspace_id_space_id_key" ON "workspace_spaces"("workspace_id", "space_id");

-- CreateIndex
CREATE INDEX "workspace_spaces_workspace_id_idx" ON "workspace_spaces"("workspace_id");

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_spaces" ADD CONSTRAINT "workspace_spaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Seed the default "Nifty" workspace from the existing singleton app_settings
--    row (team 3450636 owns all existing data). Fixed id 'ws_seed' so the
--    backfill below can reference it; is_default = true so code resolves the
--    default workspace by flag, not by id.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO "workspaces" (
    "id", "org_id", "name", "clickup_team_id",
    "clickup_api_token_enc", "webhook_secret_enc", "webhook_endpoint",
    "webhook_events", "webhook_id", "spike_hours_cap", "preferences",
    "is_default", "status", "created_at", "updated_at", "updated_by"
)
SELECT
    'ws_seed',
    'org_seed',
    'Nifty',
    COALESCE(s."clickup_team_id", '3450636'),
    s."clickup_api_token_enc",
    s."webhook_secret_enc",
    s."webhook_endpoint",
    s."webhook_events",
    NULL,
    COALESCE(s."spike_hours_cap", 12),
    CASE WHEN s."preferences" ? 'sync'
         THEN jsonb_build_object('sync', s."preferences" -> 'sync')
         ELSE NULL END,
    true,
    'ACTIVE',
    NOW(),
    NOW(),
    NULL
FROM (SELECT 1) AS dummy
LEFT JOIN "app_settings" s ON s."id" = 'singleton'
ON CONFLICT ("id") DO NOTHING;

-- Derive the seed workspace's spaces from real synced data (no hardcoded space
-- IDs): one row per distinct space found in clickup_tasks.
INSERT INTO "workspace_spaces" (
    "id", "workspace_id", "space_id", "name",
    "backfill_lookback_days", "enabled", "created_at", "updated_at"
)
SELECT
    gen_random_uuid()::text,
    'ws_seed',
    t."space_id",
    COALESCE(MAX(t."space_name"), t."space_id"),
    30,
    true,
    NOW(),
    NOW()
FROM "clickup_tasks" t
WHERE t."space_id" IS NOT NULL
GROUP BY t."space_id"
ON CONFLICT ("workspace_id", "space_id") DO NOTHING;

-- Preserve any per-space "disabled" flags from the old preferences.spaces map.
UPDATE "workspace_spaces" ws
SET "enabled" = false
WHERE ws."workspace_id" = 'ws_seed'
  AND EXISTS (
    SELECT 1 FROM "app_settings" s
    WHERE s."id" = 'singleton'
      AND (s."preferences" -> 'spaces' -> ws."space_id" ->> 'enabled') = 'false'
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Add workspace_id to every ClickUp data table:
--    add nullable → backfill to 'ws_seed' → set NOT NULL → add FK.
-- ─────────────────────────────────────────────────────────────────────────────

-- clickup_tasks
ALTER TABLE "clickup_tasks" ADD COLUMN "workspace_id" TEXT;
UPDATE "clickup_tasks" SET "workspace_id" = 'ws_seed' WHERE "workspace_id" IS NULL;
ALTER TABLE "clickup_tasks" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "clickup_tasks" ADD CONSTRAINT "clickup_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "clickup_tasks_workspace_id_space_id_idx" ON "clickup_tasks"("workspace_id", "space_id");

-- clickup_time_entries
ALTER TABLE "clickup_time_entries" ADD COLUMN "workspace_id" TEXT;
UPDATE "clickup_time_entries" SET "workspace_id" = 'ws_seed' WHERE "workspace_id" IS NULL;
ALTER TABLE "clickup_time_entries" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "clickup_time_entries" ADD CONSTRAINT "clickup_time_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "clickup_time_entries_workspace_id_start_time_idx" ON "clickup_time_entries"("workspace_id", "start_time");

-- clickup_webhook_events
ALTER TABLE "clickup_webhook_events" ADD COLUMN "workspace_id" TEXT;
UPDATE "clickup_webhook_events" SET "workspace_id" = 'ws_seed' WHERE "workspace_id" IS NULL;
ALTER TABLE "clickup_webhook_events" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "clickup_webhook_events" ADD CONSTRAINT "clickup_webhook_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "clickup_webhook_events_workspace_id_received_at_idx" ON "clickup_webhook_events"("workspace_id", "received_at");

-- clickup_webhook_seen
ALTER TABLE "clickup_webhook_seen" ADD COLUMN "workspace_id" TEXT;
UPDATE "clickup_webhook_seen" SET "workspace_id" = 'ws_seed' WHERE "workspace_id" IS NULL;
ALTER TABLE "clickup_webhook_seen" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "clickup_webhook_seen" ADD CONSTRAINT "clickup_webhook_seen_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- sync_checkpoints
ALTER TABLE "sync_checkpoints" ADD COLUMN "workspace_id" TEXT;
UPDATE "sync_checkpoints" SET "workspace_id" = 'ws_seed' WHERE "workspace_id" IS NULL;
ALTER TABLE "sync_checkpoints" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "sync_checkpoints" ADD CONSTRAINT "sync_checkpoints_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sync_checkpoints" DROP CONSTRAINT "sync_checkpoints_source_scope_type_scope_id_key";
ALTER TABLE "sync_checkpoints" ADD CONSTRAINT "sync_checkpoints_workspace_id_source_scope_type_scope_id_key" UNIQUE ("workspace_id", "source", "scope_type", "scope_id");

-- sync_job_logs (workspace_id stays NULLABLE — global/maintenance jobs span all workspaces)
ALTER TABLE "sync_job_logs" ADD COLUMN "workspace_id" TEXT;
UPDATE "sync_job_logs" SET "workspace_id" = 'ws_seed' WHERE "workspace_id" IS NULL;
ALTER TABLE "sync_job_logs" ADD CONSTRAINT "sync_job_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "sync_job_logs_workspace_id_created_at_idx" ON "sync_job_logs"("workspace_id", "created_at");

-- dead_letter_jobs (workspace_id stays NULLABLE — global/maintenance jobs span all workspaces)
ALTER TABLE "dead_letter_jobs" ADD COLUMN "workspace_id" TEXT;
UPDATE "dead_letter_jobs" SET "workspace_id" = 'ws_seed' WHERE "workspace_id" IS NULL;
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "dead_letter_jobs_workspace_id_failed_at_idx" ON "dead_letter_jobs"("workspace_id", "failed_at");

-- time_entry_replacements
ALTER TABLE "time_entry_replacements" ADD COLUMN "workspace_id" TEXT;
UPDATE "time_entry_replacements" SET "workspace_id" = 'ws_seed' WHERE "workspace_id" IS NULL;
ALTER TABLE "time_entry_replacements" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "time_entry_replacements" ADD CONSTRAINT "time_entry_replacements_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- clickup_task_events
ALTER TABLE "clickup_task_events" ADD COLUMN "workspace_id" TEXT;
UPDATE "clickup_task_events" SET "workspace_id" = 'ws_seed' WHERE "workspace_id" IS NULL;
ALTER TABLE "clickup_task_events" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "clickup_task_events" ADD CONSTRAINT "clickup_task_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "clickup_task_events_workspace_id_occurred_at_idx" ON "clickup_task_events"("workspace_id", "occurred_at");

-- spike_notifications (re-scope the unique key by workspace)
ALTER TABLE "spike_notifications" ADD COLUMN "workspace_id" TEXT;
UPDATE "spike_notifications" SET "workspace_id" = 'ws_seed' WHERE "workspace_id" IS NULL;
ALTER TABLE "spike_notifications" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "spike_notifications" ADD CONSTRAINT "spike_notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX "spike_notifications_clickup_user_id_spike_date_key";
CREATE UNIQUE INDEX "spike_notifications_workspace_id_clickup_user_id_spike_date_key" ON "spike_notifications"("workspace_id", "clickup_user_id", "spike_date");

-- spike_resolutions (re-scope the unique key by workspace)
ALTER TABLE "spike_resolutions" ADD COLUMN "workspace_id" TEXT;
UPDATE "spike_resolutions" SET "workspace_id" = 'ws_seed' WHERE "workspace_id" IS NULL;
ALTER TABLE "spike_resolutions" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "spike_resolutions" ADD CONSTRAINT "spike_resolutions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX "spike_resolutions_clickup_user_id_spike_date_key";
CREATE UNIQUE INDEX "spike_resolutions_workspace_id_clickup_user_id_spike_date_key" ON "spike_resolutions"("workspace_id", "clickup_user_id", "spike_date");

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Retire the per-connection columns from the singleton app_settings row.
--    Connection settings now live on `workspaces`. The remaining preferences
--    keep only the app-global subtrees (notifications / cost / failure); the
--    per-workspace sync + spaces subtrees move to the workspace.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE "app_settings"
SET "preferences" = ("preferences" - 'sync' - 'spaces')
WHERE "id" = 'singleton' AND "preferences" IS NOT NULL;

ALTER TABLE "app_settings"
    DROP COLUMN "clickup_api_token_enc",
    DROP COLUMN "webhook_secret_enc",
    DROP COLUMN "clickup_team_id",
    DROP COLUMN "webhook_endpoint",
    DROP COLUMN "webhook_events",
    DROP COLUMN "spike_hours_cap";
