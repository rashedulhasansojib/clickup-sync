-- Meetsy v2 Phase 7 — Roster memory (per-workspace learned participant → member map).
--
-- Hand-authored (see 0001_init_meetsy_schema): emits DDL for the `meetsy` schema
-- ONLY. NO `CREATE SCHEMA`, NO public DDL. The least-privilege `meetsy` role has
-- CREATE on schema but not the database. Apply as the `meetsy` role.

-- CreateEnum
CREATE TYPE "meetsy"."AliasSource" AS ENUM ('user_confirmed', 'user_corrected', 'user_blocklisted', 'admin_seeded');

-- CreateTable
CREATE TABLE "meetsy"."participant_aliases" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "alias_raw" TEXT NOT NULL,
    "clickup_user_id" TEXT,
    "source" "meetsy"."AliasSource" NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 1,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "participant_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — the workspace+alias uniqueness is the KB lookup key.
CREATE UNIQUE INDEX "participant_aliases_workspace_id_alias_key" ON "meetsy"."participant_aliases"("workspace_id", "alias");

-- CreateIndex
CREATE INDEX "participant_aliases_workspace_id_idx" ON "meetsy"."participant_aliases"("workspace_id");
