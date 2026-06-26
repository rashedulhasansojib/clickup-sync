# Clicksy + Meetsy — Product & Architecture Overview

**Date:** 2026-06-26
**Status:** Vision + skeleton architecture (Meetsy pipeline features deferred to later specs)
**Related:** `docs/superpowers/specs/2026-06-26-meetsy-skeleton-design.md`, `docs/ARCHITECTURE.md`

---

## 0. The two products at a glance

We run **one ecosystem, two products**, on a shared foundation.

| | **Clicksy** (existing) | **Meetsy** (new) |
|---|---|---|
| What it is | ClickUp → PostgreSQL sync + reporting/analytics platform | Meeting-intelligence layer: turns client conversations into assigned, prioritized ClickUp tasks |
| Core job | Mirror ClickUp data reliably; cost & time reporting; multi-workspace dashboards | Capture → extract → enrich → suggest assignee/priority → human approve → push to ClickUp |
| Nature | Deterministic data pipeline (boring on purpose, must be reliable) | AI/LLM + RAG service (experimental, evolving) |
| Status | In production, multi-workspace | Concept; skeleton designed, pipeline to be built |
| Deploy | Independent | Independent |

**Why two separate services and not one app?** They are fundamentally
different workloads. Clicksy is a deterministic mirror of ClickUp that must stay
stable. Meetsy is an experimental AI service (transcription, LLM extraction,
vector search). Coupling them would tie a stable data pipeline to a fast-moving
AI service's release cycle and failure modes. Keeping them separate lets each
**deploy, scale, and fail independently** — while still sharing the database,
the login, the workspace model, and the ClickUp token that make Meetsy smart.

```
                         ┌─────────────────────────────────────────┐
                         │              Shared foundation            │
                         │  Postgres (one DB) · Auth/sessions ·      │
                         │  Workspaces + RBAC · ClickUp token        │
                         └───────────────▲───────────────▲──────────┘
                                         │               │
                ┌────────────────────────┘               └───────────────────────┐
                │                                                                  │
   ┌────────────┴─────────────┐                                    ┌──────────────┴────────────┐
   │  CLICKSY                  │                                    │  MEETSY                    │
   │  sync-api (root src/)     │  reads/writes public schema       │  meetsy-api (apps/)        │
   │  web   (apps/web)         │                                    │  meetsy-web (apps/)        │
   │  owns: public schema      │  ◄── meetsy reads public (SELECT)  │  owns: meetsy schema       │
   └──────────────────────────┘                                    └────────────────────────────┘
        app.<domain>                                                     meetsy.<domain>
```

---

# PART A — CLICKSY (existing product)

## A.1 What Clicksy is

Clicksy is a NestJS backend that **replaces legacy n8n workflows** with a typed,
code-based service. It synchronizes ClickUp data into PostgreSQL for reporting,
analytics, and Grafana dashboards, and serves a React admin/reporting UI.

## A.2 Core capabilities

- **ClickUp sync:** task webhooks (`taskCreated/Updated/Deleted/TimeTrackedUpdated`),
  scheduled + backfill sync by ClickUp Space, parent/subtask normalization,
  soft deletes.
- **Tracked-time + cost:** normalizes ClickUp tracked time into decimal hours;
  calculates cost using **effective-dated assignee rates** (`valid_from`/`valid_to`).
- **Multi-workspace:** one login connects several ClickUp workspaces, each an
  isolated dashboard; data scoped by `workspace_id`; per-workspace webhook
  secret; shared or per-workspace ClickUp token.
- **Reporting surfaces:** cycle-time, time-in-status, hour-spike detection +
  email alerts, client budgets/forecasting, cost-by-assignee, overview trends.
- **Operations:** dead-letter storage + inspector, time-entry replacement with
  audit trail, admin audit log, manual sync/backfill/reconcile endpoints,
  webhook registration.
- **Security:** per-user auth (scrypt, DB-backed cookie sessions), RBAC
  (Owner/Admin/Member), webhook HMAC signature verification, admin API key
  machine credential.

## A.3 Tech stack

Node ≥22 · NestJS 11 · Prisma 7 (+ `prisma.config.ts`) · PostgreSQL · Redis ·
BullMQ · Swagger at `/docs` · React (Vite) frontend in `apps/web`.

## A.4 Where Clicksy lives in the repo (today)

- Backend: repo root `src/` (the NestJS app).
- Frontend: `apps/web/`.
- Schema: `prisma/schema.prisma` → owns the **`public`** Postgres schema.
- Monorepo: npm workspaces (`workspaces: ["apps/*"]`).

---

# PART B — MEETSY (full concept)

> Meetsy turns client Zoom meetings into structured, assigned, prioritized
> ClickUp tasks — and grows into a full intelligent PM layer grounded in the
> team's roles, workload, and three years of project history.
>
> *(This is the complete product concept. The integration architecture in Part C
> covers only the **skeleton** to be built first; the features below are the
> roadmap.)*

## B.1 Problem

- Client meetings (in English, over Zoom) surface bugs, fixes, and improvement
  requests.
- These get manually translated into ClickUp tasks, assigned, and prioritized by
  hand — slow, error-prone, and lossy.
- Items get forgotten, duplicated, or assigned to the wrong person.
- Three years of valuable signal (who solved what, how it was prioritized, how
  long it took) sits unused in closed ClickUp tasks.

## B.2 Goal

Automatically convert meeting discussion into draft ClickUp tasks, each with a
**suggested assignee and priority**, using historical patterns and current
workload — with a human approving before anything is pushed.

**The differentiator:** most tools stop at "transcript → summary." Meetsy closes
the loop into **smart assignment grounded in real history**, then layers on full
project intelligence on top.

## B.3 Core pipeline

### Stage 1 — Capture & Extract
- Input: Zoom transcript (or recording → transcription model such as Whisper).
- An LLM extracts discrete items: bugs, feature requests, improvements,
  decisions, open questions.
- Each item gets: type, one-line summary, affected component, confidence score.
- Low-confidence items are flagged for human review rather than auto-created.

### Stage 2 — Enrich with Knowledge Base (RAG)
- Each extracted item is matched against the unified knowledge base (B.4).
- Surfaces duplicates ("reported in March, ticket #842"), links related work,
  pulls in technical context.
- Produces richer task descriptions so engineers don't start cold.

### Stage 3 — Smart Assignment & Priority
The heart of the system. An LLM **proposes**, a scoring layer **constrains** — so
it stays auditable, not a black box.

Scoring signals:
- **Role / skill match** — who historically closed tasks touching this component
  or label.
- **Workload** — current open / in-progress tasks per person in the active
  sprint (live from ClickUp).
- **Priority** — inferred from client language ("blocking," "critical," "nice to
  have") plus business rules.
- **Past patterns** — typical assignee for this task type.

Output: a ranked suggestion with a short reason, e.g.
*"Suggested: Priya — owns the auth module, 3 of last 4 auth tickets, currently
light this sprint."*

### Stage 4 — Human-in-the-Loop Push
- Review screen showing all proposed tasks with editable assignee / priority /
  sprint.
- One-click bulk creation into ClickUp via API.

## B.4 Knowledge Base integration

Treat existing sources as layers of one unified, retrievable index.

| Layer | Source | What it powers |
|---|---|---|
| Documentation | Specs, architecture docs, READMEs, API docs | Task context & accurate descriptions |
| Historical tasks | 3 years of closed ClickUp tasks + comments | Assignment signal, duplicate detection |
| Past transcripts | Earlier client calls | Recurring complaints, prior decisions |
| Code / repo | Module ownership, commit history | Who owns which component |

**How (RAG pattern):**
1. **Ingest & chunk** — split each source into chunks with metadata (source
   type, date, component, author, ClickUp ID, labels).
2. **Embed & store** — embed chunks, store vectors in a vector DB
   (**pgvector inside the shared Postgres, in Meetsy's `meetsy` schema** — see
   Part C; or Pinecone/Weaviate/Qdrant if a managed store is later preferred).
   Keep metadata for filtering.
3. **Retrieve at the right moments** — query the KB during enrichment, duplicate
   detection, and assignment scoring.

**Keeping it fresh:** incremental sync only. New ClickUp tasks and transcripts
get embedded automatically via webhook or scheduled job — process deltas, never
re-embed everything. (Meetsy can subscribe to the same ClickUp data Clicksy
already mirrors, so it embeds from the shared DB rather than re-fetching.)

## B.5 Expanded feature set

Beyond the core pipeline, these turn Meetsy into a full SmartPM.

### Project intelligence
- **Sprint health prediction** — flag tasks likely to slip based on how similar
  past tasks ran. ("This sprint is 30% over typical capacity.")
- **Workload balancing** — spot overload and suggest redistribution before it
  bottlenecks.
- **Estimation assistant** — auto-suggest effort/time estimates by matching new
  tasks to comparable closed ones.
- **Risk radar** — surface stale tasks, blocked items, and stalled dependencies.

### Client-facing value
- **Auto meeting summary + action recap** — clean post-call summary to send the
  client.
- **Client status reports** — auto-draft weekly progress updates from ClickUp
  state.
- **Commitment tracker** — what was promised in meetings vs. what's actually been
  delivered.

### Knowledge & search
- **Ask-your-project chat** — natural-language Q&A over docs, tasks, and
  transcripts. ("When did we last touch the payment module, and who?")
- **Decision log** — auto-capture and index decisions made in meetings.
- **Onboarding assistant** — new members query the KB to learn a module's
  history.

### Workflow automation
- **Follow-up detection** — catch unresolved questions and create reminders.
- **Duplicate & dependency linking** — auto-link related tasks across sprints.
- **Smart notifications** — per-person digest of "what changed and what needs you
  today" instead of noisy alerts.

### Insight & reporting
- **Velocity & trend analytics** — throughput, recurring bug categories,
  components generating the most rework.
- **Recurring-issue detection** — "the client raised login problems in 4 of the
  last 6 meetings" → signals deeper tech debt.
- **Personal dashboards** — each engineer sees their tasks with context and a
  suggested order of work.

## B.6 Meetsy tech stack

| Need | Option |
|---|---|
| Task read/write | ClickUp API (reuses Clicksy's stored workspace token) |
| Historical data | Shared Postgres (Clicksy's `public` schema, read-only) |
| Transcription | Zoom cloud transcript, or Whisper on the recording |
| Extraction & drafting | LLM (Claude / GPT) |
| Knowledge retrieval | pgvector in `meetsy` schema + embedding model |
| Priority & assignment | Lightweight rules/scoring layer (auditable) |
| Review UI & dashboards | `meetsy-web` (own React app) |

## B.7 Roadmap

### MVP — prove value first
- Paste a transcript → extract, deduplicate, draft tasks with assignee
  suggestions → manual approve → push to ClickUp.
- Add **auto meeting summary/recap** — fast, visible client-facing win.
- Skip live Zoom integration and any learning model.
- Goal: validate that extraction + suggestion quality is genuinely useful.

### Phase 2 — intelligence layer
- Automatic Zoom ingestion.
- Full knowledge base / RAG over docs and past tasks.
- Live workload pull from ClickUp.
- **Ask-your-project chat** (turns the KB into a daily-use feature).
- Estimation assistant, duplicate & dependency linking.

### Phase 3 — full SmartPM
- Feedback loop: track human overrides, tune assignment weights.
- Sprint health prediction, workload balancing, risk radar.
- Client status reports, commitment tracker, recurring-issue detection.
- Analytics and personal dashboards.

### Phase 0 — skeleton (build first, see Part C)
Before any of the above: stand up `meetsy-api` + `meetsy-web` as separate
services that share the DB, auth, and workspace model. Prove the seams, then
build the MVP on top.

## B.8 Risks & mitigations

| Risk | Mitigation |
|---|---|
| Transcript errors (accents, cross-talk) poison extraction | Human review gate is non-negotiable early on |
| Auto-assignment feels intrusive to engineers | Frame as *suggestions*; keep override friction low |
| Duplicate detection is hard (false merges) | Surface as suggestion to human, never auto-merge; tune threshold |
| Stale/contradictory docs cause confident wrong context | Date-tag chunks; weight retrieval by recency |
| Privacy / consent on recording client calls | Confirm consent and data-handling policy upfront |

## B.9 Success metrics

- % of client-mentioned items correctly captured.
- % of suggestions accepted without edit.
- Time from meeting end to tasks in sprint.
- Reduction in duplicate / missed tasks.
- Estimation accuracy vs. actuals (Phase 2+).
- Sprint slip rate before vs. after (Phase 3).

---

# PART C — HOW THE TWO WORK TOGETHER (ARCHITECTURE)

## C.1 Principle: separate services, shared foundation

- **Clicksy** stays exactly as it is — backend at root `src/`, frontend in
  `apps/web`, owner of the `public` schema. **Not restructured.**
- **Meetsy** is *additive*: two new apps plus a small shared package. It owns its
  own `meetsy` schema and reads Clicksy's data read-only.
- The only change to Clicksy is a single session-cookie `Domain` tweak so login
  is shared across subdomains.

## C.2 Folder structure (monorepo)

```
clickup-sync-nestjs/                ← repo root
├── src/                            ← CLICKSY backend (UNCHANGED)
├── prisma/                         ← Clicksy schema → owns `public`  (UNCHANGED)
├── apps/
│   ├── web/                        ← CLICKSY frontend (UNCHANGED)
│   ├── meetsy-api/                 ← NEW · Meetsy NestJS backend
│   │   ├── prisma/
│   │   │   └── schema.prisma       ← Meetsy schema (multiSchema: meetsy + public)
│   │   └── src/
│   │       ├── auth/               ← validates shared session cookie
│   │       ├── clickup/            ← minimal ClickUp client (skeleton)
│   │       ├── workspaces/         ← reads shared workspaces
│   │       └── main.ts             ← boots on its own port (e.g. 3010)
│   └── meetsy-web/                 ← NEW · Meetsy React app (own bundle/deploy)
│       └── src/
├── packages/                       ← NEW workspace glob "packages/*"
│   └── shared/                     ← session hashing + shared TS types
│       └── src/
├── docs/
│   ├── clicksy-meetsy-ecosystem.md ← THIS FILE
│   └── superpowers/specs/2026-06-26-meetsy-skeleton-design.md
├── docker-compose.yml              ← + meetsy-api service
├── Caddyfile                       ← + meetsy.<domain> routing
└── package.json                    ← workspaces: ["apps/*", "packages/*"]
```

## C.3 Runtime topology

```
                         Internet (HTTPS)
                               │
                         ┌─────┴─────┐
                         │   Caddy   │   reverse proxy / TLS
                         └─────┬─────┘
        app.<domain> ─────────┤
        meetsy.<domain> ──────┤
                              │
   ┌──────────────┬──────────┴───────────┬───────────────────┐
   │              │                       │                   │
┌──┴───┐    ┌─────┴─────┐          ┌──────┴─────┐      ┌──────┴──────┐
│ web  │    │ sync-api  │          │ meetsy-web │      │ meetsy-api  │
│(apps)│    │  (src/)   │          │   (apps)   │      │   (apps)    │
└──────┘    └─────┬─────┘          └────────────┘      └──────┬──────┘
                  │                                            │
                  │  public schema (RW)            meetsy(RW) + public(RO)
                  └───────────────┬────────────────────────────┘
                                  │
                          ┌───────┴────────┐        ┌──────────┐
                          │   PostgreSQL   │        │  Redis   │
                          │  clickup_sync  │        │ (shared) │
                          │  public │meetsy│        └──────────┘
                          └────────────────┘
```

## C.4 Data flow (skeleton)

1. User logs in once on Clicksy (`app.<domain>`) → session cookie set on the
   **parent domain** (`.<domain>`).
2. User opens Meetsy (`meetsy.<domain>`) → browser sends the same cookie.
3. `meetsy-api` hashes the cookie token (shared helper), looks up
   `public.sessions` (read-only), loads the user + role + active workspace.
4. `meetsy-api` reads Clicksy's ClickUp data (`clickup_tasks`,
   `clickup_time_entries`, `workspaces`) **read-only** for context, and
   reads/writes its own `meetsy` schema for transcripts/drafts/embeddings.
5. To push approved tasks, `meetsy-api` reads the workspace's encrypted ClickUp
   token from `public.workspaces`, decrypts with the shared key, and calls the
   ClickUp API directly.

---

# PART D — WHAT IS SHARED, AND HOW

| Shared resource | How it's shared | Isolation mechanism |
|---|---|---|
| **PostgreSQL instance + database** | One DB (`clickup_sync`). Clicksy owns `public`; Meetsy owns `meetsy`. | Separate schemas; Meetsy uses a dedicated DB role |
| **Clicksy's ClickUp data** | Meetsy reads `public.*` tables directly (no network hop) | `SELECT`-only grant for the `meetsy` role on named tables |
| **Auth / sessions** | Meetsy validates the same `public.sessions` cookie | Read-only on `sessions`/`users`; hashing logic in `packages/shared` |
| **Workspaces + RBAC** | Same `workspaces` rows, same `?workspaceId=` convention, same roles | Read-only; Meetsy never mutates workspace config |
| **ClickUp API token** | Meetsy reads the encrypted per-workspace token, decrypts with shared key | Token never logged; same secret-storage discipline |
| **Redis** | Same instance if/when Meetsy needs queues | Separate BullMQ queue-name prefixes |
| **Login domain** | Session cookie on parent domain → shared across subdomains | HTTP-only, Secure; one cookie-`Domain` change in Clicksy |
| **Shared code** | `packages/shared` (session hashing, constants, TS types) | Minimal surface; additive; no forced Clicksy refactor |

## D.1 Database boundary in detail

- **Single Postgres, single database, two schemas.** `public` (Clicksy) and
  `meetsy` (Meetsy).
- **Least-privilege role:** a dedicated `meetsy` Postgres role gets
  `USAGE, CREATE` on `meetsy` and `USAGE` + `SELECT` on the specific `public`
  tables Meetsy reads. **No write** on `public`. This makes "read-only" enforced
  by the database, not just convention — an accidental write fails loudly.
- **Separate Prisma client.** `apps/meetsy-api` has its own `schema.prisma` with
  `schemas = ["meetsy", "public"]`. It *manages migrations only for* `meetsy`.
  It mirrors the `public` tables it reads as **unmanaged read-only models**.
  Meetsy migrations can never alter Clicksy's tables.

## D.2 Auth sharing in detail

- Clicksy issues a DB-backed, SHA-256-hashed session token in an HTTP-only
  cookie.
- The hashing + cookie constants live in `packages/shared`, imported by both
  backends so they hash identically.
- `meetsy-api` has its own Nest `AuthGuard` + `RolesGuard` that look up the
  hashed token in `public.sessions`, confirm not expired, and load the principal.
- One required Clicksy change: set the session cookie `Domain` to the parent
  domain (`.<domain>`) so it's sent to `meetsy.<domain>`.

## D.3 What is NOT shared (deliberate boundaries)

- **Migrations:** each service migrates only its own schema.
- **ClickUp client code:** the skeleton duplicates a minimal client in
  `meetsy-api` rather than extracting Clicksy's mature `src/clickup` — avoids
  destabilizing Clicksy. Convergence into `packages/clickup` is a later call.
- **Deployments / processes / ports:** fully independent containers.
- **Frontends:** `meetsy-web` is its own bundle and deploy (can be branded or
  sold separately later).
- **Business logic:** Clicksy does not call Meetsy and does not depend on it;
  Meetsy is a consumer of Clicksy's data, never the reverse.

---

# PART E — BUILD SEQUENCE

| Phase | What | Spec |
|---|---|---|
| **0 — Skeleton** | Two apps boot, shared login, read-only DB access, ClickUp reachable | `docs/superpowers/specs/2026-06-26-meetsy-skeleton-design.md` |
| **1 — MVP** | Transcript → extract → dedupe → draft tasks → approve → push; + meeting recap | TBD |
| **2 — Intelligence** | Zoom ingestion, RAG/pgvector KB, live workload, ask-your-project chat | TBD |
| **3 — Full SmartPM** | Feedback loop, sprint health, risk radar, client reports, analytics | TBD |

Each phase gets its own spec → implementation plan → build cycle. This document
is the umbrella vision; the skeleton spec is the first buildable unit.
