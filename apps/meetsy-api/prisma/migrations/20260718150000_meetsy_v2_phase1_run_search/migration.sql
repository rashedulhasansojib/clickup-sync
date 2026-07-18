-- Meetsy v2 Phase 1 — full-text search over meeting transcripts.
--
-- HAND-AUTHORED. Emits DDL for the `meetsy` schema ONLY. Do NOT apply here —
-- the orchestrator applies migrations. See migration_lock.toml sibling files
-- for the same discipline (meetsy migrations never touch `public`).
--
-- Design notes (docs/superpowers/specs/2026-07-18-meetsy-v2-phase1-ia-home-history-design.md §4):
--   * `tsv` is a Postgres 12+ generated column: recomputed inline on every
--     INSERT/UPDATE. No trigger, no backfill step — existing rows get the
--     tsvector as soon as the ALTER runs.
--   * Weights: title=A (highest), transcript=C. `ts_rank_cd` respects these.
--   * Prisma can't model `tsvector`. The column is DB-only; the search
--     endpoint uses $queryRawUnsafe for the WHERE clause and joins back to
--     AnalysisRun for the RunListView shape. Same treatment as KbChunk.tsv.
--   * A schema-hint comment lives on `Meeting` in schema.prisma pointing here.

ALTER TABLE "meetsy"."Meeting"
  ADD COLUMN "tsv" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("transcript", '')), 'C')
  ) STORED;

CREATE INDEX "Meeting_tsv_idx" ON "meetsy"."Meeting" USING GIN ("tsv");
