# Meetsy Phase 0 — Monorepo Fold + Unified Auth/Org + `meetsy` Schema (Design Spec)

**Date:** 2026-06-27
**Status:** Draft — awaiting product-owner approval before implementation
**Phase:** 0 of 4 (see `docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md`)
**Supersedes (auth/org framing):** `docs/superpowers/specs/2026-06-26-meetsy-skeleton-design.md`

---

## Summary

Fold the existing `meeting-analyzer` app into this repo as **Meetsy** — a separately-deployable sibling to Clicksy that shares one login, one org/workspace model, one Postgres, and the ClickUp token. Phase 0 is **plumbing only**: after it, Meetsy's existing transcript pipeline runs unchanged *under Clicksy's authentication*, against a `meetsy` schema, scoped by workspace. No ClickUp write-back (Phase 1), no RAG (Phase 2).

**Phase 0 is "done" when:**
1. The repo is one **pnpm + Turborepo** monorepo containing Clicksy (root `src/`, `apps/web`) **unchanged in source**, plus `apps/meetsy-api` and `apps/meetsy-web`, plus `packages/shared`.
2. `meetsy-api` and `meetsy-web` boot independently on their own ports.
3. A user logs in **once** on Clicksy and is authenticated on Meetsy via the **same `clickup_sync_sid` cookie** — no separate Meetsy login exists.
4. Meetsy's `Meeting`/`AnalysisRun`/`Feedback`/`ChatMessage` live in the **`meetsy` schema**, carry `workspaceId`, and reference `public.users`/`public.workspaces`. Meetsy reads `public.*` **read-only** via a least-privilege DB role.
5. The existing transcript → roster → analyze → results → feedback → chat flow works end-to-end under the new auth + schema.
6. `AzureOpenAIService` is refactored to select a **deployment per call** and to hold a **separate embedding-endpoint client** (wired but unused until Phase 2).

## Goals / Non-goals

**Goals**
- One toolchain (pnpm+turbo), one auth model (Clicksy's cookie session), one org/workspace model, one Postgres (two schemas), one Prisma version (7).
- Keep **Clicksy source untouched**; meeting-analyzer absorbs all churn.
- Preserve the meeting pipeline's behavior exactly (no quality regression).

**Non-goals (later phases)**
- ClickUp write-back / `createTask` (Phase 1).
- RAG / pgvector / embeddings ingestion / context injection (Phase 2).
- Smart assignment, workload signals, learning loop (Phase 3).
- Migrating any *existing* meeting-analyzer production data (Phase 0 treats Meetsy data as greenfield in the new schema; if real data exists it's a separate one-off migration, out of scope here).

---

## 1. Monorepo fold (pnpm + Turborepo at root)

**Target layout:**
```
clickup-sync/                      ← repo root (becomes pnpm+turbo workspace)
├── src/                           ← CLICKSY backend (UNCHANGED source)
├── prisma/                        ← Clicksy schema → owns `public` (UNCHANGED)
├── apps/
│   ├── web/                       ← CLICKSY frontend, React+Vite (UNCHANGED source)
│   ├── meetsy-api/                ← meeting-analyzer's apps/api, relocated
│   │   └── prisma/schema.prisma   ← Meetsy schema (multiSchema: meetsy + public)
│   └── meetsy-web/                ← meeting-analyzer's apps/web (Next.js 15), relocated
├── packages/
│   └── shared/                    ← NEW: session hashing + cookie constants + shared TS types
│                                     (meeting-analyzer's @ma/shared Zod contracts also land here or as a sibling package)
├── turbo.json                     ← NEW
├── pnpm-workspace.yaml            ← NEW: packages: ["apps/*", "packages/*", "."]  (root = Clicksy backend)
└── package.json                   ← root; Clicksy backend deps; workspaces via pnpm
```

**Toolchain conversion (confirmed: pnpm+turbo at root):**
- Add `pnpm-workspace.yaml`, `turbo.json`. Generate a single `pnpm-lock.yaml`; remove Clicksy's `package-lock.json`.
- Clicksy's root `package.json` scripts are preserved (still `nest build`, `start:dev`, etc.), just invoked through pnpm/turbo.
- meeting-analyzer's `@ma/shared` package is brought in. Decision: rename to a repo-consistent scope (e.g. `@meetsy/shared`) or keep `@ma/shared` — **keep `@ma/shared` to minimize churn in meetsy code**; add the new cross-service `packages/shared` (auth/session) as a separate package (e.g. `@clicksy/shared`).
- This bends "Clicksy untouched" only at the lockfile/CI/script-runner level — **no Clicksy `src/` changes** beyond the single cookie-Domain tweak in §2.

**Risk:** pnpm's strict node-resolution may surface peer-dep issues Clicksy's npm install tolerated. Mitigation: run `pnpm install` + `pnpm -r build`/`test` early; pin/add `.npmrc` `shamefully-hoist` only if a dep truly needs it.

---

## 2. Auth — retire Meetsy's JWT, adopt Clicksy's cookie session

**What is retired from meeting-analyzer:** `apps/meetsy-api/src/auth/*` JWT strategy, bcrypt password handling, refresh-token rotation, its own `Org`/`User`, and the web app's localStorage-token client (`apps/meetsy-web/lib/auth.ts`, the Bearer header + refresh logic in `lib/api.ts`). Meetsy no longer issues tokens or has a login/register screen.

**What Meetsy adopts:** Clicksy's session contract —
- Cookie name **`clickup_sync_sid`**, value = 64-hex token; DB stores **SHA-256** hash in `public.sessions.token_hash` (`src/auth/token.service.ts`, `src/common/utils/hash.ts`).
- The hashing + cookie-name constant move into **`packages/shared`** (`@clicksy/shared`), imported by *both* Clicksy and `meetsy-api` so they hash identically. (Clicksy may later be refactored to import it too; not required for Phase 0 — Phase 0 just duplicates the constant value safely.)

**`meetsy-api` AuthGuard (mirrors Clicksy's `src/auth/auth.guard.ts`):**
1. Read `clickup_sync_sid` cookie → `sha256(token)` → `SELECT … FROM public.sessions WHERE token_hash = $1`.
2. Validate `expires_at > now()` and idle window `(last_seen_at ?? created_at) > now() - IDLE_DAYS`.
3. Load `public.users` (status ACTIVE) → principal `{ userId, orgId, role, email }`.
4. CSRF: for mutating verbs require `x-csrf-token` header == `csrf` cookie (double-submit), same as Clicksy.
5. Register globally as `APP_GUARD` + a `RolesGuard` honoring `@Roles(OWNER|ADMIN|MEMBER)`. `@Public()` only for `/health`.
- **Admin machine credential:** mirror Clicksy's `x-admin-key` → synthetic Owner branch if Meetsy needs machine calls (optional in Phase 0).

**The one Clicksy change (cookie Domain):** set the session-cookie `Domain` to the parent domain so the cookie is sent to `meetsy.<domain>`. Add an env `COOKIE_DOMAIN` (e.g. `.example.com`), applied in `src/auth/auth.controller.ts` cookie options (and the CSRF cookie). Local dev (localhost subdomain-less) leaves it unset. **This is the only edit to Clicksy source.**

**Security win:** because Meetsy now authenticates via cookie (sent automatically by the browser, including `EventSource`), the meeting-analyzer SSE endpoint **no longer needs `@Public`** — it becomes a normal authenticated, org/workspace-scoped route. The cuid-guessing tradeoff documented in meeting-analyzer's ARCHITECTURE §10 goes away.

**`meetsy-web` (Next.js) changes:**
- Drop localStorage tokens; all `fetch` use `credentials: 'include'`. No `Authorization` header.
- Read the non-httpOnly `csrf` cookie and send `x-csrf-token` on mutations.
- No login/register pages; an unauthenticated user is redirected to Clicksy's login (`app.<domain>/login?redirect=meetsy.<domain>/…`).
- `NEXT_PUBLIC_API_URL` continues to be build-time baked; in prod `https://meetsy.<domain>/api`.

---

## 3. Data — `meetsy` schema, separate Prisma client, workspace scoping

**Schema ownership:** Clicksy keeps `public`. Meetsy creates and owns **`meetsy`**.

**Models moved into `meetsy`** (from meeting-analyzer's `apps/api/prisma/schema.prisma`), each gaining `workspaceId`:
- `Meeting`, `AnalysisRun`, `Feedback`, `ChatMessage` → `@@schema("meetsy")`, add `workspaceId String` + `@@index([workspaceId])`.
- Their `orgId` stays (org owns users); `userId`/`workspaceId` reference `public.users`/`public.workspaces`.
- Meetsy's own `Org`/`User` enums/models are **dropped** — identity comes from `public`.

**Scoping boundary:** **org owns users; workspace owns meetings/runs/KB.** Adopt Clicksy's `?workspaceId=` convention with default-workspace fallback (`is_default`). Every Meetsy query filters by `workspaceId` (and `orgId` for defense-in-depth).

**Prisma strategy (separate client, multiSchema — Prisma 7):**
- `apps/meetsy-api/prisma/schema.prisma`: `datasource` uses `MEETSY_DATABASE_URL` (the `meetsy` role); `schemas = ["meetsy","public"]`; generator outputs to Meetsy's own client path (no collision with Clicksy's Prisma 7 client).
- **Managed models:** the moved Meetsy tables, `@@schema("meetsy")`.
- **Unmanaged read-only models:** mirror only what Meetsy reads from `public` — `users`, `sessions`, `workspaces`, and (Phase 2) `clickup_tasks`, `clickup_task_events`, `clickup_time_entries` — annotated `@@schema("public")`, treated read-only by convention **and** DB grant. Meetsy migrations must never alter them.
- Upgrade meeting-analyzer **Prisma 5 → 7** (multiSchema GA in 7; matches Clicksy).

**Least-privilege DB role (checked-in SQL grant script):**
```sql
CREATE ROLE meetsy LOGIN PASSWORD '...';
CREATE SCHEMA IF NOT EXISTS meetsy AUTHORIZATION meetsy;
GRANT USAGE, CREATE ON SCHEMA meetsy TO meetsy;
GRANT USAGE ON SCHEMA public TO meetsy;
GRANT SELECT ON public.users, public.sessions, public.workspaces TO meetsy;  -- + clickup_* in Phase 2
-- NO insert/update/delete on public. Read-only is DB-enforced.
```
- Integration test asserts an `INSERT` into `public` is **denied** (proves least-privilege).

**Cross-schema FK caveat:** a real FK from `meetsy.meeting.workspaceId` → `public.workspaces.id` requires a `REFERENCES` grant on the read-only role (which otherwise can't reference). **Decision: use a *soft* reference** (plain `String` column, no DB-level FK) + application-level existence check. Avoids granting anything beyond SELECT and keeps the read-only boundary clean. (Revisit if integrity issues appear.)

---

## 4. Azure service refactor (per-call deployment + separate embedding client)

Today `AzureOpenAIService` fixes one deployment at construction and only speaks Chat Completions. Refactor to:
- **Per-call deployment selection:** `structured<T>({ …, deployment?: 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.4-pro' })`, defaulting to the configured chat deployment. Pipeline stages pass their chosen model (per the plan's model table).
- **Separate embedding client:** a distinct `AzureOpenAI` instance for the **embeddings endpoint** (`AZURE_EMBED_ENDPOINT=niftyocr…`, `AZURE_EMBED_API_KEY`, `AZURE_EMBED_DEPLOYMENT=text-embedding-3-large`, `AZURE_EMBED_API_VERSION`). Wired and unit-smoke-tested in Phase 0; **not used by the pipeline until Phase 2.** (Embeddings live on a *different Azure resource* than chat — different endpoint + key.)
- **Responses-API path (interface only in Phase 0):** define the seam for `gpt-5.4-pro` (Responses API, `text.format` json_schema, `max_output_tokens`) but leave it unimplemented/throwing-with-TODO until a phase needs it. Keeps Chat-Completions as the single code path for 5.4/5.4-mini.
- Preserve `runWithUsage()` ALS token accounting and per-call `reasoning_effort` behavior unchanged.

---

## 5. Deployment & routing

- **Caddy:** add `meetsy.{$DOMAIN}` → `meetsy-web`; `meetsy.{$DOMAIN}/api/*` (strip `/api`, `flush_interval -1` for SSE) → `meetsy-api`. Clicksy host routing unchanged.
- **docker-compose:** add `meetsy-api` (own port, e.g. **3010**) and `meetsy-web` services; **shared** Postgres + Redis (Meetsy uses the `meetsy` DB role; Redis queues get a `meetsy:` prefix to avoid collision with Clicksy's BullMQ queues).
- **Postgres image:** Phase 0 does **not** need pgvector. Note for Phase 2: swap `postgres:18-alpine` → `pgvector/pgvector:pg18`.
- **Env consolidation:** `MEETSY_DATABASE_URL`, shared `APP_ENCRYPTION_KEY` (same value as Clicksy — needed Phase 1 to decrypt the ClickUp token), `COOKIE_DOMAIN`, the `AZURE_*` chat vars (reused), and the new `AZURE_EMBED_*` vars. Update `.env.example`.

---

## 6. Testing (Phase 0)

- **Auth guard unit:** valid session row → accept; expired/forged token → reject (uses the shared SHA-256 helper); CSRF mismatch → reject.
- **DB least-privilege integration:** `meetsy` role can `SELECT public.users` and write `meetsy.*`, and is **denied** `INSERT public.*`.
- **Pipeline regression:** the existing transcript → roster → run → result → feedback → chat flow passes end-to-end under cookie auth + `meetsy` schema (reuse meeting-analyzer's existing tests, re-pointed).
- **Azure smoke:** chat `structured()` works against `gpt-5.4`; a per-call `deployment` override routes correctly (mock in CI; one live manual check). Embedding client connects (live manual check once the key is provided).
- **Cross-subdomain cookie:** documented manual check that a Clicksy login authenticates a Meetsy request.

---

## 7. Documentation discipline (baked in)

- This spec + the umbrella plan are the source of truth for Phase 0.
- Create and maintain **`docs/meetsy/BUILD-JOURNAL.md`** — append-only: what was built each step, decisions made, current state, gotchas. Updated as part of every implementation PR, not after the fact.
- Add a **pointer in `CLAUDE.md`** (new "Meetsy" section): *"Before building any Meetsy feature, read `docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md`, the relevant phase spec under `docs/superpowers/specs/`, and `docs/meetsy/BUILD-JOURNAL.md`. Keep the journal current."*

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| pnpm conversion breaks Clicksy's npm-tolerant deps | Convert + `pnpm -r build/test` first thing; `.npmrc` hoist only if forced |
| Two services hash sessions differently → silent auth failures | Single shared `sha256`+cookie-name constant in `packages/shared`; unit test parity |
| Cross-subdomain cookie misconfig in dev | Document `COOKIE_DOMAIN` unset for localhost; test on a real subdomain in staging |
| Unmanaged `public` Prisma models drift from Clicksy schema | Keep mirrored set minimal; add a CI diff check vs `prisma/schema.prisma` later |
| Prisma 5→7 upgrade churn in meetsy-api | Isolated to meetsy-api; covered by its existing test suite |
| Redis queue-name collision Clicksy↔Meetsy | `meetsy:` BullMQ prefix |
| Meetsy role accidentally granted write on `public` | Checked-in grant script + integration test asserting denial |

---

## 9. Open questions (resolve during implementation, not blocking approval)

- `@ma/shared` vs renaming to `@meetsy/shared` (lean: keep `@ma/shared`).
- Whether to extract Clicksy's session logic into `packages/shared` now vs duplicate the constant (lean: duplicate constant in Phase 0, extract later).
- Exact dev story for cross-subdomain cookies on localhost (lean: a `*.localtest.me` or hosts-file subdomain for manual testing).
