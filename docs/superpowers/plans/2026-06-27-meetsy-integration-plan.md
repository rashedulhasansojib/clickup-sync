# Meetsy ↔ Clicksy Integration — Organized Proposal (for confirmation)

**Date:** 2026-06-27
**Status:** Proposal — awaiting product-owner confirmation before spec-driven build
**Supersedes (on auth/org only):** `docs/superpowers/specs/2026-06-26-meetsy-skeleton-design.md`
**Builds on:** `docs/clicksy-meetsy-ecosystem.md`

> This organizes the product owner's vision (drop a Zoom transcript → analyze it *with ClickUp context* → generate detailed, evidence-grounded, correctly-assigned ClickUp tasks → human approves → push to ClickUp → learn from edits) into a confirmable architecture + build plan. It folds the existing `meeting-analyzer` app into this monorepo as "Meetsy". Research-backed; see §7 for the locked technical stack.

---

## 1. Why ClickUp is integrated (the point of the whole thing)

Meeting-analyzer today is **blind to the project**. It reads only the transcript + a confirmed roster. It produces good tasks, but it can't know: what's already a ticket, who historically owns a component, what the backlog looks like, what the client raised before, or who is even allowed to be assigned work.

Connecting ClickUp turns that blindness into **grounded project intelligence**:

| Signal from ClickUp | What it buys the meeting pipeline |
|---|---|
| 3 years of tasks (title/desc/comments/status/labels/dates/assignee) | Context for *better, more detailed* tasks; duplicate detection ("already ticket #842") |
| Who closed tasks touching a component | **Correct assignment** grounded in real history, not a guess |
| Current open tasks / tracked hours per person | Workload-aware assignment ("X is light this sprint") |
| Workspace members | The **candidate pool** for assignment (minus anyone excluded in settings) |
| Backlog + what the client said about it | Connect transcript discussion to existing backlog items |

Crucially, **Clicksy already mirrors all of this into Postgres** (`clickup_tasks`, `clickup_task_events`, `clickup_time_entries`) via webhooks + backfill. So Meetsy reads the **DB mirror, not the ClickUp API** — no re-fetch, no rate limits, and "what changed since last analysis?" is just a timestamp query.

---

## 2. The two products, after integration

- **Clicksy** (unchanged): deterministic ClickUp → Postgres mirror + reporting. Owns `public` schema. Stays exactly as it is.
- **Meetsy** (folded in, evolved): meeting-intelligence service. Owns `meetsy` schema. Reads `public.*` read-only. Separately deployable (`meetsy.<domain>`). Same login, same org/workspace model, same ClickUp token.

---

## 3. Two pipelines

### 3a. Onboarding / Knowledge-Base pipeline (per workspace/client — runs once, then incrementally)

When a user connects a ClickUp workspace/space to Meetsy:

```
1. Read mirrored tasks from public.clickup_tasks (the spaces Clicksy syncs for this workspace)
2. Background job (BullMQ, "meetsy-kb" queue):
     a. Bulk-analyze/summarize tasks  → gpt-5.4-mini, low effort, BATCHED (thinking-hungry but cheap at scale)
     b. Embed each task "card"        → text-embedding-3-large @1024 → meetsy.kb_chunk (pgvector)
     c. Build hybrid index (vector + tsvector)
3. Show the user a SUMMARY in the UI of what was learned (counts, components, top owners, recurring themes)
4. Ask the user for extra project/client context as PDF upload → chunk + embed → strengthens the KB
5. KB is now "warm" for this workspace. Store a per-workspace embed cursor.
```

**Incremental:** on later runs, only tasks with `updated_date`/`synced_at` past the cursor are re-analyzed/re-embedded (gated by `content_hash`). Never re-embed everything.

**Coverage caveat:** Meetsy's KB only covers the ClickUp spaces **Clicksy is configured to sync** (`WorkspaceSpace`). Connecting a new space to Meetsy may first require enabling its sync in Clicksy.

### 3b. Augmented meeting pipeline (per transcript — the existing pipeline + ClickUp context)

The existing meeting-analyzer pipeline is preserved; ClickUp context is injected at the right seams:

```
upload transcript
  → 0 normalize + roster (unchanged; deterministic VTT + low-effort roster)
  → [NEW] incremental KB top-up: any new ClickUp tasks since last analysis? embed them in background
  → 1+2 analyze        + retrieved historical context (RAG)        [gpt-5.4 medium]
  → 5 critic           + dedup against existing ClickUp tickets     [gpt-5.4 high]
  → 4 enrich           + tags/estimates from similar past tasks     [gpt-5.4-mini low]
  → [NEW] smart-assign + map to workspace members & workload, drop non-assignable people
  → 6 assemble (unchanged, pure TS)
  → tasks shown in UI, each with evidence + assignment rationale + cited ClickUp task ids
  → [HUMAN LOOP] user verifies / edits / approves
  → [NEW] push approved tasks into ClickUp  (Clicksy token; create in chosen list)
  → [NEW] learning loop: store user edits as preference signal → next runs match the pattern
```

The "money step" is the **transcript ↔ history mapping**: GPT fuses live transcript against retrieved historical tasks to generate detailed tasks in the same proven pattern (title, description, acceptance criteria, due date, evidence) — now correctly assigned and de-duplicated.

---

## 4. Target architecture (after the fold)

### Auth / org — ONE model (Clicksy's wins)
- Meetsy authenticates the **same** `clickup_sync_sid` cookie: SHA-256 hash → `public.sessions` lookup → load `public.users` + role. Shared hashing in `packages/shared`.
- Meetsy's JWT/bcrypt/own-`Org` is **retired**. RBAC = OWNER/ADMIN/MEMBER.
- One change to Clicksy: cookie `Domain=.<parent-domain>` so the cookie is sent to `meetsy.<domain>`. CSRF double-submit carried into the Next.js frontend.
- **Bonus security win:** under cookie auth, Meetsy's SSE endpoint no longer needs to be `@Public` (the JWT-can't-set-headers problem disappears).

### Data — `meetsy` schema, workspace-scoped
- Meeting / AnalysisRun / Feedback / ChatMessage **move into `meetsy`**, gain a `workspaceId`, and reference `public.users`/`public.workspaces`.
- New KB tables in `meetsy`: `kb_chunk` (vector + tsvector + metadata), `kb_document` (uploaded PDFs), `embed_cursor`, `task_push_audit`, `assignment_audit`, `user_pref_signal`.
- Boundary: **org owns users; workspace owns meetings/runs/KB.** Reuse `?workspaceId=` + default-workspace convention.
- Separate Prisma client (multiSchema `["meetsy","public"]`); `public` models are unmanaged/read-only; least-privilege `meetsy` DB role (SELECT-only on `public`).

### ClickUp write-back (the visible feature)
- Clicksy's client has **no `createTask`** today (only reads + time-entry writes) → add it.
- Per-workspace setting: **target ClickUp list** + **assignable members** (the people Meetsy may assign; everyone else is ignored — distinct from "who spoke" in the transcript roster).
- Map Meetsy Task → ClickUp payload; resolve assignee **names → member IDs** via Clicksy's `getTeamMembers`.

### Models — per-call deployment selection
- Refactor `AzureOpenAIService` (currently one deployment fixed at construction, Chat Completions only) to pick deployment **per call**, and add a **Responses-API path** for gpt-5.4-pro (Chat-Completions-incompatible).

---

## 5. Proposed build sequence (de-risked — same product, safer order)

The product *runtime* order is onboarding(RAG) → transcript → push. But RAG is the hardest piece **and** is externally blocked (needs an embedding deployment + a Postgres extension). So the *build* order front-loads value that needs neither:

| Phase | What | Needs embeddings? | Delivers |
|---|---|---|---|
| **0 — Plumbing** | Fold meeting-analyzer into monorepo; retire its auth/org; wire Clicksy's shared login + `meetsy` schema + workspace scoping. Existing pipeline runs under the new auth. | No | Single login; one org/workspace model; Meetsy boots as a sibling service |
| **1 — Write-back** | Add `createTask` to ClickUp client; per-workspace target-list + assignable-members settings; assignee resolution; "approve → push to ClickUp" button + audit. | No | **The visible win**: transcript → tasks → real ClickUp tickets |
| **2 — RAG / KB** | pgvector + hybrid search; onboarding job (bulk analyze + embed mirrored tasks); PDF upload; context injection into analyze/critic/enrich; KB summary UI. | **Yes** | Tasks grounded in 3-yr history; duplicate detection |
| **3 — Smart assign + learning** | Workload/ownership signals; auditable assignment; store user edits as preference signal feeding future runs. | Yes | Correct, workload-aware assignment that improves over time |

Each phase gets its own formal spec under `docs/superpowers/specs/` before implementation.

---

## 6. External prerequisites (product-owner action — start now for lead time)

These **block Phase 2**, not Phase 0/1:
1. **Deploy `text-embedding-3-large`** to the `niftyai` Azure endpoint (only gpt-5.4/pro/mini exist today; there is no embedding model).
2. **Confirm the shared Postgres allows `CREATE EXTENSION vector`** (managed tiers gate this).
3. **Confirm gpt-5.4-mini / -pro unit pricing** to firm up the cost model (embedding 5k tasks is <$1; the bulk LLM pass is the real lever — kept cheap on mini+low+batched).

---

## 7. Locked technical stack (from research)

- **Vector store:** plain **pgvector 0.8 HNSW** (`m=16, ef_construction=64`) in `meetsy` — not pgvectorscale (its win is >5M vectors; we're at tens of thousands).
- **Embeddings:** **text-embedding-3-large @ `dimensions=1024`** stored as `vector(1024)` (dodges pgvector's 2000-dim HNSW cap via Matryoshka truncation; still beats ada-002).
- **Hybrid search:** `tsvector`/`ts_rank` + pgvector cosine fused by **Reciprocal Rank Fusion (k=60)** — zero new extensions.
- **Per-stage models:** bulk historical pass = **5.4-mini / low / batched**; transcript↔history mapping = **5.4 / medium / one call per meeting**; hard escalation = **5.4-pro / high / Responses API** (rare).
- **Background jobs:** reuse the existing BullMQ + Redis-pub/sub + SSE pattern; new `meetsy-kb` queue; idempotent, cursor-driven.

---

## 8. Decisions — CONFIRMED (2026-06-27)

1. **Package manager** — ✅ **Adopt pnpm + Turborepo at the root.** Clicksy's lockfile/scripts convert; no Clicksy source changes.
2. **Build resequencing** (§5) — ✅ **Write-back (Phase 1) before RAG (Phase 2).** Product runtime order is unchanged; only the build order is resequenced.
3. **Prisma** — upgrade Meetsy 5 → 7 (multiSchema is GA in 7) to share one Prisma version. (Recommendation; no objection expected.)

## 9. Documentation discipline (product-owner request — baked into every phase)

- All Meetsy work is spec-driven: a spec in `docs/superpowers/specs/` → an implementation plan → build.
- Maintain a **Meetsy build journal** (what was built, why, current state) so future agents have continuity.
- Add a **CLAUDE.md pointer** instructing any agent building Meetsy features to first read this plan, the relevant spec, and the journal — so future work stays accurate to the goal and the established patterns.

---

## Phase 2 — detailed plan (2026-06-27 update, post-research)

Phase 2 = the RAG/KB + onboarding. Research done (RAG stack, KB-improvement metrics, field
prediction, ClickUp comments/custom-fields/sprints, Clicksy backfill). Restructured into discrete,
shippable units (advisor-guided):

| Unit | What | Verifiable now? |
|---|---|---|
| **2.0 — Clicksy comment-sync** (`docs/superpowers/specs/2026-06-27-clicksy-comment-sync-design.md`) | Pure-Clicksy: `clickup_task_comments` table + queue + worker + `getTaskComments` + comment webhooks + prioritized conservative limiter + opt-in backfill + admin trigger + Meetsy SELECT grant. **First substantive Clicksy feature.** Built/verified FIRST. | **Yes** — plumbing testable on team "Chishty" with the working token, independent of pgvector/Meetsy/Nifty |
| **2a — Minimal KB slice** | pgvector enablement (`postgres:18-alpine`→`pgvector/pgvector:pg18`); `meetsy` KB schema (`kb_chunk` w/ `vector(1024)` via `dimensions=1024`, tsvector, metadata, content_hash, embedding_model+version); onboarding: connect → date-range preset → coverage-check → trigger Clicksy task backfill → embed task cards (descriptions first; comments enrich via **debounced single re-embed** keyed on `commentsSyncedAt`) → hybrid retrieval (RRF). Background job + progress. | Plumbing yes (on Chishty); **VALUE (quality) needs Nifty data** |
| **2a.1 — "What we learned" card** (separable) | Aggregate-SQL facts (roster+ownership, components, throughput, blockers) + ONE gpt-5.4-mini narrative pass. | Needs real history (Nifty) |
| **2b — Docs + honest improvement metric** | SOP/PDF upload → parse/chunk/embed → **novelty** + **answerability-lift** (transcript-derived questions; provisional task-derived baseline at first onboarding) → honest card incl. "no improvement"; doc↔task auto-linking. | Needs real data |
| **2c — Pipeline integration** | Pre-meeting incremental remap (cursor + content-hash, upsert-only, no full re-index); KB context injection into analyze/critic/enrich; **field prediction** (kNN prior + LLM adjudication **clamped to neighbor range**; due as p50/p80 from existing cycle-time reports; **abstain when thin**; evidence shown); **duplicate detection** (flag ≥0.90, suggest 0.82–0.90, never auto-merge); **HITL extension** of the Phase-1 push: **sprint = target list**, **client = dropdown custom field (set by option UUID)**, **points** (top-level `points`), all editable; **overrides logged** as the Phase-3 learning signal. | Needs real data + the live sprint/client structure |

**Locked technical facts (research):** ClickUp comment webhooks exist (`taskCommentPosted/Updated`); comment fetch is cursor-paginated (25/page, no "since" filter); **rate limit 100/min** (verified live on the prod token) → comment backfill must be throttled+prioritized. Sprints have **no REST API** — a task is "in sprint X" by living in that sprint's **list** (so Phase-1's list picker already covers it); **client = dropdown custom field** (set via `POST /task/{id}/field/{id}` with the option **UUID**); **sprint points = top-level `points`** on create. Field prediction is a **weak prior** (literature: ~0.34 corr, no sig RAG lift) → present as range+evidence+human-confirm, never confident point-prediction.

### ⚠️ CRITICAL user action (gates Phase-2 VALUE verification — start now)
The ClickUp token provided can read team "Chishty" (`90181854711`, ~empty) but returns **0 spaces for production "Nifty" (`3450636`)** — it has no space access there. So Phase-2 units can be **built and plumbing-verified** on Chishty, but their **value** (summary quality, field-prediction neighbors, dedup) **cannot be verified without a token that can read the real Nifty history**. This is the Phase-2 analog of "no embedding deployment provisioned." **Needed: a ClickUp token with space access to the Nifty workspace** (or share the relevant space with the current token). Until then, do not read a green build on empty data as "Phase 2 works."

### Build order
**2.0 (comment-sync, now) → 2a (KB slice) → 2a.1 (summary) → 2b (docs/metric) → 2c (pipeline).** Each gets its own spec when it starts (per the spec-driven discipline). pgvector image swap is the hard prerequisite for 2a+.
