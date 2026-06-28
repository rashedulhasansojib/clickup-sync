# ▶ Meetsy — RESUME HERE (next session entry point)

> Single entry point to continue the Clicksy+Meetsy build in a fresh chat. Read this first,
> then the three docs it points to. Everything is committed on branch **`feat/meetsy-phase0`**
> (pushed to origin). Last code commit: **`05d8fe2`** (Phase 2c.2 — field prediction + dedup, live-verified).

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
- **Phase 2a.1** — "what we learned" card (SQL facts + 1 gpt-5.4-mini narrative). **Proven live on REAL Nifty R&D-Apps tasks** — accurate roster/components/clients/narrative.
- **Onboarding-robustness fixes** (the 2a.1 follow-ups; commit `c1f4426`) — **DONE + LIVE-VERIFIED.** See the journal's last section for the full live trace. Summary:
  - **Fix 1** — `pollUntilDrained`→**`pollUntilTasksFetched`** counts only `phase:'fetching'` spaces, so onboarding embeds once tasks are mirrored and never blocks on the time-entries phase. *Live: onboarding hit `ready` in 75s while 1711 time-entry jobs were still undrained (old code ≈17+min). KB grew 614→1198 chunks.*
  - **Fix 2** — `lockDuration` 10min→120s + `stalledInterval`/`maxStalledCount:1`; **authoritative `failed` handler** (a stalled-out job is moved to `failed` without re-entering `process()`, so it must set `error` there or `kbSyncState` sticks on `"onboarding"` forever); **`enqueue()` supersedes a retained completed/failed job** (stable `jobId=workspaceId` otherwise makes re-onboard a silent no-op). *Live: crash mid-embed recovered from the committed cursor in ~111s; re-onboard ran with no `redis-cli del`.*

- **Phase 2b** — doc upload + honest improvement metric (commit `ffcc295`) — **DONE + LIVE-VERIFIED on real Nifty data.** SOP/PDF upload → `meetsy-kb-docs` worker (parse via `pdf-parse`/text → `chunkText` → embed into `KbChunk` sourceType=document) → metric → doc↔task links; `POST/GET/DELETE /workspaces/:id/kb/documents`. Metric = **novelty** (pgvector-only headline; today read `medianNovelty` — `pctNovel` cutoff wants tuning on multi-chunk docs) + **answerability-lift** (held-out transcript questions when present, else task-derived+provisional; blind identical gpt-5.4-mini judge before/after). *Live: PDF+md upload, novelty discriminates (0.243 vs 0.399), doc linked to the real "Energy Audit Web Portal" task, and the **positive answerability path proven** — a vendor-payment transcript + the vendor-policy PDF gave `provisional=false, newlyAnswerable=2 (N→Y)`.* 128 tests. Docs are intentionally NOT in `/kb/search` yet (2c surfaces them).

- **Phase 2c.1** — KB context injection (commit `3802f6a`) — **DONE + LIVE-VERIFIED on real Nifty data.** `KbSearchService` gained a `sourceTypes` filter + `retrieveContext()` (provenance); `criticPass`/`enrichTasks` take an optional `context` arg (default byte-identical, test-locked); the processor injects summary-keyed context into critic+enrich and surfaces provenance on `result.kbContext`; fire-and-forget incremental remap. *Live: an energy-reporting transcript run retrieved the 8 right "[Energy Reporting]" tasks, visible in `result.kbContext`.* **Fast-follow:** inject context into `analyzeMeeting` too (deferred).

- **Phase 2c.2** — field prediction + dedup (commit `05d8fe2`) — **DONE + LIVE-VERIFIED.** Per extracted task: card-shaped kNN over `clickup_task` chunks with a **cosine FLOOR** (so abstain is real, not base-rate echo); client/sprint/assignee = similarity-weighted modal prior **clamped by a gpt-5.4-mini call** (the echo-breaker — confidence rides on the distribution); due = **p80** cycle-time; abstain on thin history. Dedup bands **empirically recalibrated to flag ≥0.72 / suggest ≥0.64** (true near-dup peaks ~0.73 due to sparse-query/rich-card asymmetry). Attached to `result.fieldPredictions[id]` / `result.duplicates[id]`. *Live: AIT minority→AIT (not majority echo); OOD→abstain; energy→Energy Reporting high-conf; re-extracted task→FLAG.* `ClickupTask.estimation` added to the read-model.

## ▶ DO NEXT: Phase 2c.3 — HITL push extension (the last 2c slice)
Spec (APPROVED) §4. Build:
- **Config:** extend `WorkspacePushConfig` (meetsy) with the **client dropdown** field id + options (`[{optionId(UUID),name}]`), selectable **sprint lists** (`[{listId,name}]`), and a **points-enabled** flag; populate via a "refresh ClickUp field options" admin action (fetch `type_config.options` + lists from ClickUp).
- **Mapper:** `src/clickup/task-mapper.service.ts` `map()` adds `custom_fields: [{id, value: optionUUID}]` for client, top-level `points`, and routes the create to the chosen **sprint list** (push already targets a list id).
- **Review/push:** surface the 2c.2 predictions (abstain-aware) + dupe flags in the review UI; `POST /runs/:id/push` accepts confirmed `sprintListId`/`clientOptionId`/`points` per task and writes a new **`meetsy.FieldOverride`** row (predicted vs confirmed) — the Phase-3 learning signal (written, not yet read).
- **SAFETY (hard):** live-verify pushes go ONLY to a **throwaway list on test team `90181854711`** (Chishty). **Never** write Nifty prod `3450636`. Keep `TaskPush` idempotency; no ClickUp write without explicit confirmation.
- Grounding mapped: `src/clickup/` (`WorkspacePushConfig`, `TaskMapperService.map`, `PushService`, `push-config.service.ts`).

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
- **Verify on real data:** mirror a Nifty space's TASKS via Clicksy `POST /api/admin/backfill {spaceId, lookbackDays}` (fast); onboard meetsy KB; `GET /workspaces/:id/kb/search` + `/kb/summary`. Tasks are fast; time-entries/comments are the slow per-task parts (now skipped by Fix 1).
- **Booting the two apps (proven recipe):** meetsy-api — `cd apps/meetsy-api && PATH=/opt/homebrew/bin:$PATH npx dotenv -e <env> -- node dist/main` (entry `dist/main`, port 4000; needs `MEETSY_DATABASE_URL`, `REDIS_PORT=56379`, `AZURE_*`, `ADMIN_API_KEY`; set `CLICKSY_ADMIN_URL=http://localhost:3000/api` only when exercising the backfill path). Clicksy — root has **no** `dotenv-cli`, so `set -a; . <env>; set +a; PATH=/opt/homebrew/bin:$PATH node dist/src/main.js` (entry `dist/src/main.js`, port 3000; needs `DATABASE_URL=postgresql://clickup:clickup@localhost:55432/clickup_sync`, `REDIS_URL=redis://localhost:56379`, `CLICKUP_API_TOKEN`=Nifty token, matching `ADMIN_API_KEY`). PG superuser is **`clickup`** (not `postgres`). Auth meetsy/Clicksy admin calls with header `x-admin-key: <ADMIN_API_KEY>` (→ synthetic Owner). ws_nifty (team 3450636, space 3589129 R&D) has **no stored token** → Clicksy uses the `CLICKUP_API_TOKEN` env fallback. Stop Clicksy after verifying so its per-task time-entry jobs stop hitting the production API.

## Hard rules carried forward
- Clicksy stays additive (its only Phase-0 src change was the cookie `Domain`; comment-sync is additive). Meetsy is READ-ONLY on `public` (DB-enforced). Never write `public` from meetsy.
- Spec-driven: write the phase spec → get approval → build (sub-agent-driven) → live-verify → commit + push + update this journal/RESUME.
- Field prediction is a WEAK prior (present as range+evidence, abstain when thin) — never confident point-prediction. KB "improvement" is answerability-lift + novelty, never blended.
