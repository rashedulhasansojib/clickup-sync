-- Meetsy KB onboarding — per-onboarding SCOPE selection.
--
-- HAND-AUTHORED. Emits DDL for the `meetsy` schema ONLY (two nullable columns on
-- KbSyncState). Additive, no backfill: pre-existing rows read back NULL for both,
-- which the app normalizes to "no range/scope recorded" (so the first re-onboard
-- after this migration resets the scan cursor once — intended). NEVER touch
-- `public`. Do NOT apply here — the orchestrator applies.

-- AlterTable
ALTER TABLE "meetsy"."KbSyncState" ADD COLUMN "range" TEXT;
ALTER TABLE "meetsy"."KbSyncState" ADD COLUMN "scope" JSONB;
