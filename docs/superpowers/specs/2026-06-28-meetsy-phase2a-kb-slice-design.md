# Meetsy Phase 2a — Minimal Knowledge-Base Slice (Design Spec)

**Date:** 2026-06-28
**Status:** Draft — awaiting product-owner approval
**Phase:** Meetsy 2a (after 2.0 Clicksy comment-sync ✅; before 2a.1 summary / 2b docs / 2c pipeline)
**Plan:** `docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md`
**Depends on:** Phase 0/1 ✅, Clicksy comment-sync ✅; the verified embedding endpoint (`niftyocr` / `text-embedding-3-large`, `dimensions=1024`)

---

## Summary

Stand up the **per-workspace RAG knowledge base**: enable `pgvector`, create the `meetsy` KB
tables, and build the onboarding job that **embeds a workspace's ClickUp tasks (with comments) into
a hybrid-searchable index**. This is the **minimal end-to-end slice** — connect → ensure the tasks
are mirrored (trigger Clicksy backfill if needed) → embed task "cards" → **hybrid retrieval
(vector + keyword via RRF)** — with incremental refresh. It deliberately **excludes** the
"what we learned" summary card (2a.1), PDF docs + improvement metric (2b), and pipeline
integration / field-prediction / dedup (2c), so 2a stays shippable and verifiable on its own.

**Done when:** for a workspace, an onboarding job embeds its mirrored ClickUp tasks into
`meetsy.kb_chunk`; a `GET …/kb/search?q=` returns relevant tasks via hybrid (vector+keyword) RRF,
workspace-scoped; re-running is incremental (content-hash; only new/changed tasks re-embed);
comments enrich a task's card **once** when its comment sync completes (debounced on
`commentsSyncedAt`). **Plumbing is verifiable on the "Chishty" team; KB *quality* needs the real
"Nifty" history (gated on a token with Nifty access).**

## Goals / Non-goals

**Goals**
- `pgvector` enabled; `meetsy.kb_chunk` (vector + tsvector + filter metadata) + `kb_sync_state`.
- Onboarding background job: coverage-check → (optional) trigger Clicksy task+comment backfill → embed task cards.
- Hybrid retrieval (pgvector cosine + Postgres FTS, fused by **RRF k=60**), workspace-filtered, with the filtered-HNSW recall mitigation.
- Incremental, cheap re-runs (content-hash + per-workspace cursor; model+version stamped).

**Non-goals (separate units)**
- "What we learned" summary card → **2a.1**.
- SOP/PDF ingestion + novelty/answerability "improvement" metric → **2b**.
- Injecting KB context into the meeting pipeline, field prediction, duplicate detection, HITL → **2c**.
- Transcript/document `source_type`s — schema reserves them; 2a only embeds `clickup_task`.

## Prerequisites (call out / user actions)
- **pgvector image swap** (this spec does it): dev `postgres:18-alpine` → `pgvector/pgvector:pg18`; prod likewise (or `azure.extensions` allowlist if managed).
- **Embedding creds required at runtime** (`AZURE_EMBED_ENDPOINT`/`_API_KEY`) — verified working; the Phase-0 `AzureEmbeddingService` is already wired (lazy). 2a is the first consumer.
- **Phase-2 SELECT grants** for the `meetsy` role (this spec adds them): `clickup_tasks`, `clickup_task_events`, `clickup_time_entries`, `clickup_task_comments`.
- **VALUE verification needs a ClickUp token with "Nifty" (`3450636`) space access** — plumbing verifies on "Chishty"; quality does not.

---

## 1. pgvector enablement
- **Image:** swap to `pgvector/pgvector:pg18` in `docker-compose.yml` + `docker-compose.prod.yml` (Phase-0 left a TODO note on the postgres service). Same PG18, just bundles the extension.
- **Extension (operator step, in `grants.sql` or a setup script run as superuser):** `CREATE EXTENSION IF NOT EXISTS vector;` Confirm `vector(1024)` indexable with HNSW (the `dimensions=1024` choice stays under pgvector's 2000-dim HNSW cap — that's why we truncate via the embedding API's `dimensions` param, not 3072).
- **Grants:** add to `apps/meetsy-api/prisma/grants.sql` the Phase-2 reads:
  `GRANT SELECT ON public.clickup_tasks, public.clickup_task_events, public.clickup_time_entries TO meetsy;`
  (`clickup_task_comments` already granted in 2.0). The `vector` type is globally usable; no extra grant.

## 2. `meetsy` KB schema (managed by Meetsy migrations)

`meetsy.kb_chunk` — one row per embedded chunk (2a: one "card" per task, `chunk_index=0`):
- `id`, `workspaceId`, `sourceType` (enum `clickup_task` | reserved `transcript`/`document`),
  `sourceId` (the ClickUp `task_id`), `chunkIndex` (default 0).
- `content` (the embedded card text), `contentHash` (sha256 of `content` — incremental gate).
- `embedding Unsupported("vector(1024)")?` — Prisma `Unsupported`; the **migration hand-adds** the
  `vector(1024)` column + the **HNSW index** (`USING hnsw (embedding vector_cosine_ops)`,
  `m=16, ef_construction=64`).
- `tsv` — a Postgres `tsvector` (migration adds it as a **generated column** from `content` +
  a **GIN index**) for the keyword half of hybrid.
- **Filter metadata** (for workspace + later facet filters): `status`, `assignee`, `component`
  (label/list/folder), `client`, `department`, `taskUpdatedAt`.
- `embeddingModel`, `embeddingDims`, `embeddingVersion` (controlled re-embed on model change).
- `@@unique([workspaceId, sourceType, sourceId, chunkIndex])`, `@@index([workspaceId, sourceType])`, `@@schema("meetsy")`.

`meetsy.kb_sync_state` — per-workspace cursor/status: `workspaceId @id`, `lastTaskCursor`
(high-water on ClickUp `date_updated`), `embeddedCount`, `status` (`idle|onboarding|ready|error`),
`lastRunAt`.

**Public read models (unmanaged, read-only):** add `ClickupTask`, `ClickupTaskComment`
(+ `ClickupTaskEvent`, `ClickupTimeEntry` for later) to the meetsy Prisma `@@schema("public")`
mirrors. Meetsy never writes/migrates `public`.

**Migration** follows the Phase-0 operator flow (no `CREATE SCHEMA`; `meetsy._prisma_migrations`
pre-provisioned). Because of the `Unsupported` vector column + HNSW/tsvector/GIN, the migration is
**hand-finished** (Prisma emits the table; we add the `vector` column, the generated `tsv`, and the
two indexes by hand) — same hand-authored pattern as the existing meetsy migrations.

## 3. The task "card" (what gets embedded)
A deterministic builder turns a `clickup_tasks` row (+ its `clickup_task_comments`) into one compact
text card: `title` + `description` + key fields (status, priority, assignee, labels, list/folder,
client, department, sprint, dates) + concatenated comment text (when present). Keep it tight
(< ~1.5k tokens; if a comment thread is huge, truncate oldest). `contentHash = sha256(card)`.

**Comment-ordering (the advisor's cost trap):** build the card from **description first**; a task's
**comments are folded in once `clickup_tasks.commentsSyncedAt` is set** (2.0's completeness marker).
Because the card includes comments only after completion, a task re-embeds **once** when comments
arrive (its `contentHash` changes once), not per paginated comment page.

## 4. Onboarding flow + job

```
POST /workspaces/:id/kb/onboard { range: "3m|6m|12m|24m|36m|all" }
  → resolve lookbackDays from the preset
  → coverage check: read public.sync_job_logs for the workspace's spaces;
      if the mirrored window < requested, call Clicksy admin (x-admin-key):
        POST {CLICKSY_ADMIN_URL}/admin/backfill { spaceId, lookbackDays }   (tasks)
        POST {CLICKSY_ADMIN_URL}/admin/comments/backfill { spaceId }        (comments, throttled)
      poll GET {CLICKSY_ADMIN_URL}/admin/backfill/active until drained
  → enqueue meetsy-kb job (BullMQ, new "meetsy-kb" queue; meetsy-api already has BullMQ/Redis)
```
**The `meetsy-kb` worker** (idempotent, checkpointed, progress via the existing SSE/pub-sub pattern):
1. Read `public.clickup_tasks` for the workspace's spaces where `updated_date > kb_sync_state.lastTaskCursor` (first run: the whole requested window).
2. For each: build card → `contentHash`; **skip if unchanged**; else embed (batched, up to ~256/req via `AzureEmbeddingService.embed(..., {dimensions:1024})`) → **upsert** `kb_chunk` (transactional with the row's hash) + stamp `embeddingModel/dims/version`.
3. Advance `lastTaskCursor` **transactionally** only past rows actually embedded (crash-safe).
4. Emit progress (`embedded N / total`); set `kb_sync_state.status = ready` on completion.

**Cross-service auth:** Meetsy calls Clicksy admin with the shared `ADMIN_API_KEY` over a configured
`CLICKSY_ADMIN_URL` (new meetsy env). (Internal call; same machine credential the comment-sync used.)

## 5. Hybrid retrieval (the core KB capability 2c will use)
`kbSearch(workspaceId, query, k)`:
1. Embed the query (`dimensions=1024`).
2. **Vector branch:** `ORDER BY embedding <=> $queryvec` (cosine), `WHERE workspace_id=$1 AND source_type=...`, top ~50. Enable **`SET LOCAL hnsw.iterative_scan = relaxed_order`** so the `workspace_id` filter doesn't silently drop recall on the shared HNSW index.
3. **Keyword branch:** `WHERE tsv @@ websearch_to_tsquery('english',$q) AND workspace_id=$1`, `ORDER BY ts_rank_cd`, top ~50.
4. **Fuse via Reciprocal Rank Fusion (k=60):** `score = Σ 1/(60 + rank)`; order by fused score; return top-k chunks + their task metadata + the source `task_id`/url.
All via `$queryRaw` (pgvector ops aren't in Prisma's query builder). Exposed as
`GET /workspaces/:id/kb/search?q=&k=` (any auth; workspace-scoped) — used now for **verification**,
and by 2c later.

## 6. Incremental refresh (pre-meeting top-up, reused by 2c)
The same `meetsy-kb` worker, run as a delta: `updated_date > lastTaskCursor` **AND** `contentHash`
changed → re-embed only those (typically a handful) → upsert → advance cursor. No full re-embed, no
HNSW rebuild (pgvector supports incremental upsert). `embeddingVersion` makes a future model bump a
controlled backfill, not silent drift. 2c calls this right before transcript mapping.

## 7. Endpoints (meetsy-api; workspace-scoped, session-authed)
- `POST /workspaces/:id/kb/onboard { range }` (Owner/Admin) — start onboarding.
- `GET /workspaces/:id/kb/status` — `{ status, embeddedCount, total, lastRunAt }` (+ SSE progress).
- `GET /workspaces/:id/kb/search?q=&k=` — hybrid search (verification + 2c reuse).

## 8. Env additions (meetsy-api)
`CLICKSY_ADMIN_URL` (Clicksy internal base, e.g. `http://localhost:3000/api` dev / the service DNS in compose), reuse `ADMIN_API_KEY` (shared), and the existing (now-required) `AZURE_EMBED_*`. Document in `.env.example`.

## 9. Testing
- **Unit:** card builder (deterministic; comments folded only when `commentsSyncedAt` set); `contentHash` skip logic; RRF fusion (given two ranked lists → expected order); cursor advance is transactional; embedding batching shape (mock `AzureEmbeddingService`).
- **Integration (live, on "Chishty" — plumbing):** apply the migration; `CREATE EXTENSION vector`; onboard the workspace (the lone test task + its 2 comments) → `kb_chunk` row exists with a 1024-d embedding + `tsv`; `kb/search?q=` returns it; re-run → no re-embed (hash unchanged); edit the task → exactly one re-embed. Coverage-check → Clicksy backfill trigger round-trips (Meetsy → Clicksy admin → mirrored).
- **VALUE (deferred, needs Nifty token):** retrieval quality on real history — relevant tasks rank for paraphrased queries (the whole point; cannot be shown on the ~empty Chishty team).

## 10. Risks & mitigations
| Risk | Mitigation |
|---|---|
| Filtered HNSW drops recall (workspace predicate) | `hnsw.iterative_scan = relaxed_order` (pgvector 0.8); partial index / partition per big workspace later |
| Prisma can't model vector/HNSW/tsvector | Hand-finish the migration (column + 2 indexes); query via `$queryRaw`; `Unsupported("vector(1024)")` for the column |
| Comment arrival → repeated re-embeds | Fold comments only at `commentsSyncedAt` → one re-embed per task |
| Crash mid-onboard advances cursor past un-embedded rows | Embed-write + cursor advance transactional; checkpoint per batch |
| Embedding model/dim drift | Stamp `embeddingModel/dims/version`; bump = controlled backfill |
| Cross-service backfill trigger coupling | Simple authenticated HTTP with the shared admin key; Meetsy degrades to "embed what's mirrored" if Clicksy admin is unreachable |
| pgvector not allowed on managed prod PG | Self-hosted → image swap (in our control); managed → `azure.extensions` allowlist (verify) |
| **Green build on empty "Chishty" ≠ KB works** | Spec states value-verification is gated on the Nifty token; don't conflate |

## 11. Open questions (resolve in implementation)
- Chunk-per-task vs split very long tasks — start one card/task; split only if a task exceeds the token budget.
- HNSW `ef_search` default (recall/latency) — start 40–100, tune on real data.
- Whether onboarding auto-triggers Clicksy backfill or asks the user first when a big fetch is implied (lean: show the coverage gap + estimated fetch, let Owner/Admin confirm before a large/slow comment backfill).
