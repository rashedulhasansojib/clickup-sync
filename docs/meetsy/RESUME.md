# ▶ Meetsy — RESUME HERE (next session entry point)

> Single entry point to continue the Clicksy+Meetsy build in a fresh chat. Read this first,
> then the three docs it points to. Everything is committed on branch **`feat/meetsy-phase0`**
> (pushed to origin). Last commit at handoff: **`4d61a54`** (Phase 2a.1).

## Read these (in order), then start
1. **`docs/meetsy/BUILD-JOURNAL.md`** — the full, dated build history + every live-verification + findings. **The source of truth for "what's done."**
2. **`docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md`** — the umbrella vision + the Phase 2 breakdown (2.0 → 2a → 2a.1 → 2b → 2c).
3. The relevant **phase spec** under `docs/superpowers/specs/` (2.0 comment-sync, 2a KB, 2a.1 card are done + specced; **2b/2c specs are still to be written**).
4. Project memory `meetsy-integration-decisions.md` (auto-loaded) — locked decisions + status.

## What's DONE (all committed + LIVE-VERIFIED)
- **Phase 0** — monorepo fold (pnpm+turbo), shared Clicksy cookie auth, `meetsy` schema + least-privilege role. Cross-subdomain single login proven live.
- **Phase 1** — ClickUp write-back (review → push real assigned tasks). Proven live (real task created, assignee set, idempotent).
- **Phase 2.0** — Clicksy comment-sync (additive: `clickup_task_comments` + queue/worker + webhook + admin backfill). Proven live.
- **Phase 2a** — RAG KB: pgvector, `meetsy.KbChunk` (vector(1024) HNSW + tsv GIN), onboarding embed, hybrid RRF search, incremental. Proven live — **paraphrased queries retrieve the right task**.
- **Phase 2a.1** — "what we learned" card (SQL facts + 1 gpt-5.4-mini narrative). **Proven live on 614 REAL Nifty R&D-Apps tasks** — accurate roster/components/clients/narrative.

## ▶ DO NEXT (the user's instruction): two onboarding-robustness fixes, THEN Phase 2b

### Fix 1 — onboarding blocks on the slow time-entries backfill phase
- **Symptom:** `POST /workspaces/:id/kb/onboard` with `CLICKSY_ADMIN_URL` set hangs ~10+ min: the coverage-check triggers a Clicksy backfill, then `pollUntilDrained` waits for the **time-entries** phase (hundreds of per-task calls @ ≤100/min) that the **embed doesn't need**.
- **Where:** `apps/meetsy-api/src/kb/kb-onboarding.service.ts` (`ensureCoverage`) → `apps/meetsy-api/src/kb/clicksy-admin.client.ts` (`pollUntilDrained`, reads Clicksy `GET /admin/backfill/active`).
- **Fix:** the `/admin/backfill/active` response has a per-space **`phase`** field — `"fetching"` (tasks) vs `"time-entries"`. `pollUntilDrained` should return once every space is **past `fetching`** (tasks mirrored); let time-entries continue async in Clicksy. Embed only needs tasks.
- **Verify:** onboard a Nifty space with `CLICKSY_ADMIN_URL` set → proceeds to embed once tasks are fetched (not a 10-min hang).

### Fix 2 — a killed/crashed worker leaves the meetsy-kb job locked ~10 min
- **Symptom:** if the worker dies mid-onboard, the job (jobId = workspaceId) stays "active"/locked in Redis for `lockDuration: 10min`; a re-onboard dedupes against it and stalls until the lock expires. (Worked around in verification by `redis-cli del bull:meetsy-kb:*`.)
- **Where:** `apps/meetsy-api/src/kb/kb.processor.ts` / `kb.queue.ts` (BullMQ worker config + enqueue).
- **Fix (pick cleanest):** shorten `lockDuration` (~2–3 min) + add BullMQ stalled-recovery (`stalledInterval`, `maxStalledCount`) so a dead job is reclaimed fast; AND/OR on enqueue remove any existing job for that workspaceId (so a manual re-onboard always supersedes a stuck one). Ensure long embeds renew the lock.
- **Verify:** kill meetsy-api mid-onboard, restart, re-onboard → recovers without the 10-min wait.

### Then — Phase 2b (write the spec first, then build)
PDF/SOP upload → parse/chunk/embed into the KB → **honest improvement metric** + doc↔task linking. **Research already done** (in the journal/plan): ship **answerability-lift** (questions derived from transcripts, before/after answerable count) as the headline + **corpus novelty** (per-chunk cosine vs existing) as support; NEVER a single blended "X% better"; "no improvement" is a valid honest result. At first onboarding (no transcripts) use a labeled-provisional task-derived baseline. Then Phase 2c = pipeline integration (KB context injection, field prediction [weak prior + range + evidence, abstain when thin], dedup, HITL sprint/client/points).

## Tokens/creds the new session needs (the scratchpad does NOT carry over)
Ask the user to re-provide (or read from `../meeting-analyzer/.env` for Azure):
- **Nifty ClickUp token** (Ahmad's, team `3450636`) — for real-data verification. Read-only; user rotates after.
- **Azure embeddings** — `niftyocr.openai.azure.com` / `text-embedding-3-large` / api-version `2023-05-15` (`dimensions=1024` honored). (`AZURE_EMBED_*`.)
- **Azure chat** — `niftyai...` / `gpt-5.4` (+ `gpt-5.4-mini` deployment) — for the narrative/extraction. In `../meeting-analyzer/.env` as `AZURE_OPENAI_*`.
- A throwaway `ADMIN_API_KEY` (any ≥32 chars) for Clicksy↔Meetsy admin calls.

## Local verification stack + gotchas (learned the hard way)
- **Node ≥22.12 required** (Prisma 7 gate). Default nvm here is v22.0.0 → fails. Use Homebrew `/opt/homebrew/bin` (v25.9.0): prefix pnpm/node with `PATH="/opt/homebrew/bin:$PATH"`.
- **pgvector:** the dev Postgres image must be `pgvector/pgvector:pg18` (NOT `postgres:18-alpine`). Use a throwaway compose override that ALSO remaps host ports (the user has other projects on 5432/5433/6379 — `inhunt`, `meeting-analyzer`): map postgres→**55432**, redis→**56379**, e.g. `ports: !override ["55432:5432"]`.
- **Operator flow (meetsy migrations):** run `apps/meetsy-api/prisma/grants.sql` (as superuser; `sed "s/'CHANGE_ME'/'meetsy'/"`) FIRST — it does `CREATE EXTENSION vector`, creates the `meetsy` role + schema + `_prisma_migrations`, sets `search_path`, and grants SELECT on the clickup_* mirror tables. Migrations contain NO `CREATE SCHEMA`/`CREATE EXTENSION` (the least-priv role can't). `MEETSY_DATABASE_URL=postgresql://meetsy:meetsy@localhost:55432/clickup_sync?schema=meetsy`.
- **Running the stack:** Clicksy entry is `dist/src/main.js` (NOT `dist/main.js` — `prisma.config.ts` in tsconfig widens rootDir; pre-existing). meetsy-api entry `apps/meetsy-api/dist/main.js`. Both NestJS; routes under `/api` (Clicksy) / bare (meetsy-api). Clicksy **caches workspace_spaces at boot** — insert workspace/space rows BEFORE booting Clicksy (or it reads "Valid: (none)" for admin backfill). Use `docker exec -i` for multi-statement psql (without `-i`, stdin isn't attached and inserts silently no-op).
- **ClickUp rate limit = 100/min** shared across the token. Use `x-admin-key` for admin endpoints (machine cred → Owner). meetsy-api admin/Owner endpoints accept `x-admin-key` too.
- **Verify on real data:** mirror a Nifty space's TASKS via Clicksy `POST /api/admin/backfill {spaceId, lookbackDays}` (fast); onboard meetsy KB; `GET /workspaces/:id/kb/search` + `/kb/summary`. Tasks are fast; time-entries/comments are the slow per-task parts (that's Fix 1).

## Hard rules carried forward
- Clicksy stays additive (its only Phase-0 src change was the cookie `Domain`; comment-sync is additive). Meetsy is READ-ONLY on `public` (DB-enforced). Never write `public` from meetsy.
- Spec-driven: write the phase spec → get approval → build (sub-agent-driven) → live-verify → commit + push + update this journal/RESUME.
- Field prediction is a WEAK prior (present as range+evidence, abstain when thin) — never confident point-prediction. KB "improvement" is answerability-lift + novelty, never blended.
