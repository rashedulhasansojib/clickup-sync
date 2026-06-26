# Meetsy — Separate-Service Skeleton Design

**Date:** 2026-06-26
**Status:** Approved (skeleton scope)
**Author:** brainstormed with product owner

## Summary

Meetsy is a new, separately-deployable service that turns client meeting
transcripts into draft ClickUp tasks with suggested assignees and priorities
(full concept: `clicksy-concept.md`, originally pitched as "Clicksy"; renamed
to **Meetsy** here because "Clicksy" is the existing product brand).

This spec covers **only the skeleton** — the wiring that lets Meetsy exist as a
genuinely separate service while sharing what is shareable with the existing
ClickUp sync app. The actual intelligence pipeline (extraction, RAG, smart
assignment, dashboards, chat) is **explicitly out of scope** and will be
designed in later specs.

The skeleton is "done" when:

1. Two new apps (`meetsy-api`, `meetsy-web`) boot independently.
2. They authenticate a user via the **same session cookie** the sync app
   issues (single login).
3. `meetsy-api` reads the sync app's ClickUp data **read-only** from its own
   Prisma client, and can write to its own `meetsy` schema.
4. `meetsy-api` can reach the ClickUp API using the active workspace's existing
   token (a trivial "create a test task" or "read task" call proves it).
5. Everything is scoped by the existing `workspace_id` model.

## Goals / Non-goals

**Goals**
- Establish Meetsy as a separate backend + frontend that can scale, deploy, and
  fail independently of the sync app.
- Share the database instance, the auth/session model, the RBAC roles, the
  workspace model, and the ClickUp token — without coupling Meetsy's release
  cycle to the sync app's internals.
- Keep the existing sync backend (`src/`) essentially **untouched**. The only
  required change is a single cookie-`Domain` tweak so the session cookie is
  shared across subdomains (see Auth section); any shared-package extraction is
  additive and optional.

**Non-goals (deferred to later specs)**
- Transcript extraction pipeline / LLM drafting.
- RAG knowledge base / `pgvector` embeddings / duplicate detection.
- Smart assignment & priority scoring.
- Meetsy dashboards, ask-your-project chat, project-intelligence features.
- Live Zoom integration / transcription.

## Decisions (locked with product owner)

| Decision | Choice | Rationale |
|---|---|---|
| First scope | Skeleton / plumbing only | Validate the seams before building features |
| Service name | **Meetsy** | Sibling to "Clicksy"; meeting-capture identity; ends in `-sy` |
| Data sharing | Shared Postgres, **separate `meetsy` schema** | No network hop for 3yr history queries; clean ownership boundary |
| Prisma | **Separate Prisma client** (multiSchema, unmanaged read models) | Meetsy migrations can never alter sync tables; full isolation |
| Auth/identity | **Reuse** sync app session + RBAC + workspaces | Single login; one team; same `workspace_id` scoping |
| ClickUp access | Reuse the **workspace token** from `public.workspaces` | Token is per-user in ClickUp, already stored per-workspace |
| Frontend | **Separate** `apps/meetsy-web` | Own bundle/deploy; can be branded/sold separately later |
| Routing | **Subdomain** (`meetsy.<domain>`) | Clean separation; cookie shared on parent domain |

## Monorepo layout

The repo is already an npm-workspaces monorepo (`workspaces: ["apps/*"]`). Add a
`packages/*` glob and two new apps. The root sync backend (`src/`) is unchanged.

```
clickup-sync-nestjs/
├── src/                      ← sync backend (UNCHANGED, stays at root)
├── prisma/                   ← sync schema (public) — UNCHANGED
├── apps/
│   ├── web/                  ← sync frontend (unchanged)
│   ├── meetsy-api/           ← NEW: Meetsy NestJS backend
│   │   ├── prisma/           ← Meetsy's own schema.prisma (meetsy + public)
│   │   └── src/
│   └── meetsy-web/           ← NEW: Meetsy React app (own bundle/deploy)
└── packages/                 ← NEW workspace glob "packages/*"
    └── shared/               ← session-cookie hashing/validation + shared TS types
```

`package.json` `workspaces` becomes `["apps/*", "packages/*"]`.

`packages/shared` deliberately holds the **minimum**: the session-token hashing
(SHA-256) and cookie-name constants used to validate sessions, plus a few shared
TS types. The sync backend MAY later be refactored to consume it too, but that
refactor is optional and not required for the skeleton.

## Database boundary

- **One** Postgres instance (existing Docker pg18), one logical database
  (`clickup_sync`).
- Sync app continues to own the `public` schema. Meetsy owns a new `meetsy`
  schema for its own tables (transcripts, extracted items, task drafts, and
  later `pgvector` embeddings — reserved, not built now).
- **Least-privilege DB role:** create a dedicated `meetsy` Postgres role with:
  - `USAGE, CREATE` on schema `meetsy` (full control of its own tables/migrations),
  - `USAGE` on schema `public` + `SELECT` on the specific sync tables Meetsy
    reads (`clickup_tasks`, `clickup_time_entries`, `workspaces`, `users`,
    `sessions`). **No** INSERT/UPDATE/DELETE on `public`.
  - This makes "read-only" enforced by the database, not just by convention.
- The skeleton ships **one** Meetsy migration that just creates the `meetsy`
  schema (and a trivial marker table, e.g. `meetsy._meetsy_health`). Real tables
  arrive with feature specs.

### Prisma strategy (separate client, multiSchema)

`apps/meetsy-api/prisma/schema.prisma`:

- `datasource db` → same `DATABASE_URL` host/db, but Meetsy uses the `meetsy`
  role credentials (`MEETSY_DATABASE_URL`).
- `generator client` → output to Meetsy's own `node_modules/.prisma` (separate
  from the sync client; no collision).
- `schemas = ["meetsy", "public"]` (multiSchema preview/GA per Prisma 7).
- **Managed models** live in `@@schema("meetsy")`.
- **Unmanaged read models** mirror the sync tables Meetsy needs, each annotated
  `@@schema("public")` and treated as read-only by convention + DB grant.
  Meetsy migrations must never include changes to these — enforced by running
  Meetsy's `prisma migrate` against the restricted `meetsy` role (which cannot
  alter `public`, so an accidental change fails loudly).

Trade-off accepted: the unmanaged `public` models are hand-maintained to stay in
sync with the source schema. Mitigation: keep the mirrored model set minimal
(only what Meetsy reads) and add a CI check later that diffs them against the
sync schema. The alternative (reusing the sync app's generated client via a
shared `packages/db`) was rejected because it couples Meetsy to the sync app's
migration cycle.

## Auth — single login, shared session

- The sync app issues a DB-backed, SHA-256-hashed session token in an HTTP-only
  cookie (see `src/auth/*`).
- `meetsy-api` validates the **same cookie**: hash the presented token with the
  shared helper in `packages/shared`, look up the row in `public.sessions`
  (read-only), confirm not expired, load `public.users` + role.
- Implemented as a Nest `AuthGuard` in `meetsy-api` that mirrors the sync app's
  guard contract (global guard + roles). RBAC roles (Owner/Admin/Member) reused
  as-is.
- Workspace scoping reuses the existing `?workspaceId=` convention and the same
  `workspaces` rows; absent → default workspace (`is_default`), preserving
  single-workspace behavior.
- `meetsy-web` is a separate bundle served on a subdomain of the **same parent
  domain**, so the session cookie is sent automatically. Cookie `Domain` must be
  set to the parent domain (e.g. `.example.com`) for cross-subdomain sharing —
  this is the one change that may touch the sync app's cookie config.

## ClickUp access

- For the eventual task-push and any reads, `meetsy-api` reads the active
  workspace's encrypted token from `public.workspaces.clickup_api_token_enc`
  (it has SELECT) and decrypts it with the same encryption key
  (`shared` env secret), falling back to the shared `CLICKUP_API_TOKEN` env like
  the sync app does.
- **Skeleton:** a minimal ClickUp client lives inside `meetsy-api` (just enough
  to prove connectivity — e.g. `GET /task/{id}` or a guarded create). The mature
  `src/clickup` client is **not** extracted yet; convergence into
  `packages/clickup` is a later decision once Meetsy's real needs are known.

## Deployment & routing

- `docker-compose`: add a `meetsy-api` service on its own internal port
  (e.g. **3010**); `meetsy-web` built to static assets.
- Caddy routes by host (subdomain):
  - `app.<domain>` (or apex) → sync web + sync api as today.
  - `meetsy.<domain>` → `meetsy-web`; `meetsy.<domain>/api/*` → `meetsy-api`.
- Shared infra: same Postgres (Meetsy role), same Redis instance if/when Meetsy
  needs queues (separate queue name prefixes to avoid collision).
- Env: `MEETSY_DATABASE_URL`, reuse of `CLICKUP_API_TOKEN`, the shared encryption
  key, and the session cookie secret/name (via `packages/shared` constants).

## Testing (skeleton)

- `meetsy-api` unit test: auth guard accepts a valid session row, rejects
  expired/forged tokens (uses the shared hashing helper).
- `meetsy-api` integration test: boots, connects with the `meetsy` role, can
  `SELECT` from `public.clickup_tasks`, can write to `meetsy._meetsy_health`,
  and is **denied** an INSERT into `public` (proves least-privilege).
- A smoke test that `meetsy-api` can reach ClickUp with the resolved workspace
  token (mocked in CI; live-verified manually once).
- `meetsy-web`: builds; an authenticated route loads behind the shared session.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Unmanaged `public` Prisma models drift from sync schema | Keep the mirrored set minimal; add a CI diff check against the sync schema later |
| Cross-subdomain cookie requires parent-domain cookie config | Single, contained change to the sync app's cookie `Domain`; documented |
| Two ClickUp clients diverge | Accept duplication for skeleton; converge to `packages/clickup` only if it earns its keep |
| Meetsy role accidentally granted write on `public` | Provision role via a checked-in SQL grant script; integration test asserts the denial |
| Shared encryption key handling across two services | Same secret-storage discipline as sync app; never logged; loaded from env |

## Open questions for later specs

- Exact `meetsy` schema tables for the extraction pipeline + drafts.
- Vector store: `pgvector` in `meetsy` schema (preferred — no new infra) vs
  external — decide when RAG is specced.
- Whether to extract `packages/clickup` and `packages/auth` from the sync app
  once Meetsy's needs are concrete.
