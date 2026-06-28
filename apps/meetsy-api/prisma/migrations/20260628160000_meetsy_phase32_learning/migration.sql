-- Meetsy Phase 3.2 — learning loop: record the shown nudge on FieldOverride.
--
-- HAND-AUTHORED. Emits DDL for the `meetsy` schema ONLY (one nullable column).
-- The `adjustments` JSON records what the loop showed at push time + acceptance,
-- so (a) nudge-acceptance is measured separately from raw-model override rate and
-- (b) only organic (no-nudge) corrections count toward the gate. Do NOT apply
-- here — the orchestrator applies.

-- AlterTable
ALTER TABLE "meetsy"."FieldOverride" ADD COLUMN "adjustments" JSONB;
