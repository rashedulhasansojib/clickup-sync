-- Meetsy Phase 2a.1 — "what we learned" summary card cache.
--
-- HAND-AUTHORED (see 0001_init_meetsy_schema / 20260628120000_meetsy_phase2a_kb
-- for why we never `migrate dev`). Emits DDL for the `meetsy` schema ONLY — one
-- CREATE TABLE for the per-workspace cached summary. It does NOT `CREATE SCHEMA`
-- and does NOT touch the unmanaged `public.*` read-models (the new Prisma fields
-- on ClickupTaskEvent/ClickupTimeEntry mirror columns Clicksy already owns; Meetsy
-- migrations must never ALTER those). Do NOT apply here — the orchestrator applies
-- + live-verifies.

-- CreateTable
CREATE TABLE "meetsy"."KbSummary" (
    "workspaceId" TEXT NOT NULL,
    -- Exact aggregate-SQL facts (KbFacts JSON). Source of truth for the card.
    "facts" JSONB NOT NULL,
    -- The single gpt-5.4-mini narrative paragraph; NULL when Azure is unavailable.
    "narrative" TEXT,
    -- Embedded chunk count at generation time — the staleness regenerate gate.
    "taskCountAtGen" INTEGER NOT NULL DEFAULT 0,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KbSummary_pkey" PRIMARY KEY ("workspaceId")
);
