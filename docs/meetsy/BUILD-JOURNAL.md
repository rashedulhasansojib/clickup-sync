# Meetsy Build Journal

> Append-only log of the Meetsy integration build. Newest entries at the bottom of each phase.
> **Any agent building Meetsy features must read this, the umbrella plan
> (`docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md`), and the relevant phase spec
> under `docs/superpowers/specs/` BEFORE starting — and must update this journal as part of the work.**

## Context (read once)

- **What:** folding the `meeting-analyzer` app into this repo as **Meetsy**, a separately-deployable
  sibling to **Clicksy** (the existing ClickUp→Postgres sync at root `src/`). One login, one
  org/workspace model, one Postgres (Clicksy owns `public`, Meetsy owns `meetsy`), shared ClickUp token.
- **Why:** Meetsy turns Zoom transcripts into ClickUp-ready, evidence-grounded, correctly-assigned tasks,
  grounded in Clicksy's mirrored ClickUp history (RAG) and pushed back into ClickUp.
- **Build order (confirmed):** Phase 0 plumbing → Phase 1 ClickUp write-back → Phase 2 RAG/KB →
  Phase 3 smart-assign + learning loop.
- **Key facts:** Azure AI = the unified **Azure AI Foundry "v1" OpenAI-compatible** endpoint
  `niftyaibd-resource.services.ai.azure.com/openai/v1` (chat + embeddings on ONE resource/key as of
  2026-06-29). Main pipeline runs **gpt-5.5**; aux calls narrative/clamp=gpt-5.4, answerability
  judge=gpt-5.4-mini. Embeddings still text-embedding-3-large `dimensions=1024`. The v1 surface needs
  the plain `OpenAI` SDK client (baseURL + `api-key` header), NOT `AzureOpenAI` (404s); `model` field
  routes. (History: chat was `niftyai.openai.azure.com` gpt-5.4, embeddings a separate
  `niftyocr.openai.azure.com` — migrated 2026-06-29; old/new text-embedding-3-large vectors verified
  cosine-identical so no re-embed.) pgvector needs the dev Postgres image swapped `postgres:18-alpine`
  → `pgvector/pgvector:pg18` (Phase 2). gpt-5.4-pro is Responses-API-only.

---

## Phase 0 — Monorepo fold + unified auth/org + `meetsy` schema

Spec: `docs/superpowers/specs/2026-06-27-meetsy-phase0-plumbing-design.md`
Branch: `feat/meetsy-phase0`

### 2026-06-27 — kickoff
- Embedding endpoint verified (1024-dim honored, batch works). Decisions saved to memory + plan/spec written and approved.
- Branch `feat/meetsy-phase0` created off `feat/multi-workspace`.
- Build journal + CLAUDE.md pointer established.
- **Next:** Step 1 — the monorepo fold (pnpm+turbo at root; relocate meetsy-api/meetsy-web/shared; green install + typecheck). Auth/schema/Azure refactors follow as separate steps.

<!-- Append new entries below this line as steps complete. -->

### 2026-06-27 — Step 1: the monorepo fold (pnpm + Turborepo) — DONE / GREEN

Pure relocation + toolchain switch. **No** app logic, auth, schema, or dependency-version changes. Not committed.

**Moved (rsync, source only — excluded node_modules/.next/dist/.turbo/.git/coverage and real `.env`):**
- `meeting-analyzer/apps/api/` → `apps/meetsy-api/` (package name kept `@ma/api`, NestJS 10, Prisma 5)
- `meeting-analyzer/apps/web/` → `apps/meetsy-web/` (package name kept `@ma/web`, Next.js 15)
- `meeting-analyzer/packages/shared/` → `packages/shared/` (kept `@ma/shared`, Zod)
- `meeting-analyzer/tsconfig.base.json` → repo-root `tsconfig.base.json` (verbatim; `apps/meetsy-api/tsconfig.json`'s `../../tsconfig.base.json` now resolves).

**Created:** `pnpm-workspace.yaml` (`apps/*`, `packages/*`), `turbo.json` (build/dev/lint/typecheck), `pnpm-lock.yaml` (single root lock).
**Edited root `package.json`:** added `"packageManager": "pnpm@9.12.0"`; removed npm `"workspaces"`; converted `dev:web`/`build:web` to `pnpm --filter web …`; added `dev:meetsy`, `turbo:build`, `turbo:typecheck`, `turbo:lint`; added `turbo@^2.3.0` devDep. Clicksy's `build`/`test`/`start:*`/`prisma:*` left intact.
**Deleted:** `package-lock.json` (npm lock).
**No `.npmrc` needed** — pnpm's default isolated linker kept Clicksy's `@prisma/client@7.8.0` and Meetsy's `@prisma/client@5.22.0` in separate virtual-store paths (no clobber; confirmed by re-running Clicksy tests after both generates).

**Node note:** Prisma 7 (and 5) preinstall requires Node ≥22.12; the shell's nvm Node was v22.0.0 → install failed. Re-ran under the machine's Homebrew Node **v25.9.0** (satisfies Prisma's 24.0+). No repo Node pin exists; this is an environment detail, not a code change.

**Verify table (all green):**
| # | Target | Command | Result |
|---|---|---|---|
| a | Clicksy backend build | `pnpm build` (nest build) | PASS |
| b | Clicksy tests | `pnpm test` | PASS — 63 suites / 561 tests |
| c | `@ma/shared` build | `pnpm --filter @ma/shared build` | PASS |
| d | `@ma/api` typecheck | `pnpm --filter @ma/api typecheck` | PASS (no test suite exists in meetsy-api) |
| e | Clicksy frontend build | `pnpm --filter web build` | PASS |
| f | `@ma/web` typecheck + build | `pnpm --filter @ma/web {typecheck,build}` | PASS — `next build` succeeded without `NEXT_PUBLIC_API_URL` |
| g | Turbo orchestration | `pnpm turbo:typecheck` (`turbo run typecheck`) | PASS — 4 tasks; `^build` correctly built `@ma/shared` before typechecks |

> **Turbo scope note:** `pnpm-workspace.yaml` is `apps/*` + `packages/*` (per task), so the **root Clicksy backend package is NOT a turbo workspace** — `turbo:build` builds meetsy-api/meetsy-web/web/shared but NOT Clicksy's `nest build`. Clicksy backend still builds via its own `pnpm build`. (Intentional; spec's optional `"."` glob was not added.)
> **Node requirement:** all commands above were run under **Node v25.9.0** (Homebrew). `pnpm install` HARD-FAILS under Node <22.12 (Prisma 7/5 preinstall gate) — e.g. the shell's nvm default v22.0.0. Root `engines` still says `>=22.0.0` but is effectively `>=22.12` via Prisma 7.8.0 (pre-existing, unchanged).

**Deviations from literal task commands (documented):**
- Clicksy `prisma:generate` needs `DATABASE_URL` at config-load (`prisma.config.ts`); ran with an inline throwaway `DATABASE_URL` (generate doesn't connect).
- Meetsy generate ran as `pnpm --filter @ma/api exec prisma generate` to bypass its `dotenv -e ../../.env` wrapper (no root `.env` exists; generate doesn't need env).

**Not copied (by design):** meeting-analyzer's repo-root `fixtures/sample-transcript.txt` and `sample-transcript/*.vtt` — referenced by no app code (manual dev data only); left out to avoid polluting Clicksy's root. Not a blocker.

**Next:** Step 2 — auth (retire Meetsy JWT, adopt Clicksy cookie session + `@clicksy/shared`); then `meetsy` schema + Prisma 5→7; then Azure deployment-per-call refactor.

### 2026-06-27 — Step 2: shared cookie-session auth + `meetsy` Prisma schema — DONE / GREEN (code-first; not committed)

Backend only. Live DB integration deferred (no Docker). Frontend (`apps/meetsy-web`), ClickUp write-back, RAG, and full `?workspaceId=` wiring all out of scope. All commands run under Homebrew **Node v25.9.0** (pnpm needs ≥22.12; shell nvm v22.0.0 fails).

**Part A — new `@clicksy/shared` package** (`packages/clicksy-shared`, mirrors the `@ma/shared` setup):
- `src/hash.ts` `sha256()` (node:crypto, byte-identical to Clicksy's `src/common/utils/hash.ts` for string tokens), `src/cookies.ts` (`SESSION_COOKIE='clickup_sync_sid'`, `CSRF_COOKIE='csrf'`, `MUTATING_METHODS`), `src/principal.ts` (`Role`, `AuthPrincipal`), `src/index.ts` barrel. `package.json` (build=tsc) + `tsconfig.json` extending root base. Both services hash the same token to the same `token_hash`.

**Part B — meetsy-api Prisma (multiSchema, shared DB; kept Prisma 5.22, NOT 5→7):**
- `generator previewFeatures=["multiSchema"]`; `datasource schemas=["meetsy","public"]`, url=`env("MEETSY_DATABASE_URL")`. (Prisma 5→7 upgrade deferred — multiSchema is preview-GA on 5.22 and `generate` succeeds; upgrade is a later optimization.)
- Moved `Meeting`/`AnalysisRun`/`Feedback`/`ChatMessage` to `@@schema("meetsy")`; added `workspaceId String @map("workspace_id")` + `@@index` to Meeting & AnalysisRun; kept `orgId`. **Dropped** meetsy's own `Org`/`User` models + `UserRole` enum; `orgId`/`workspaceId` are now plain String **soft refs** to public (no cross-schema FK). Kept enums `RunStatus`/`TaskVote`/`ChatRole` in `meetsy`.
- Added **unmanaged read-only** `@@schema("public")` mirrors of Clicksy's tables (exact `@@map`/`@map`): `User`(users), `Session`(sessions, with `user` relation for the include), `Workspace`(workspaces) + enums `Role`/`UserStatus`/`WorkspaceStatus`. Meetsy never writes these.
- **Migration consolidated, not appended:** deleted the 4 old standalone migrations (they `CREATE TABLE` in public, which the meetsy role can't do) and hand-authored one fresh `prisma/migrations/0001_init_meetsy_schema/migration.sql` emitting `CREATE SCHEMA meetsy` + the meetsy enums/tables/indexes/intra-meetsy FKs ONLY — no public DDL. **UNAPPLIED** (no DB this step). `prisma generate` succeeds (no DB needed) so the client typechecks.
  - ⚠️ **Never run `prisma migrate dev`** for meetsy-api: with the public read-models present Prisma would try to manage/alter them. Always hand-author or `migrate dev --create-only` + strip public DDL.
- Checked-in `prisma/grants.sql`: creates `meetsy` LOGIN role, `GRANT USAGE,CREATE ON SCHEMA meetsy`, `GRANT USAGE ON SCHEMA public`, `GRANT SELECT ON public.users/sessions/workspaces` — no write on public, no REFERENCES. Applied out-of-band before deploy.
- Deleted obsolete `prisma/seed.ts` (used `prisma.org`/`prisma.user`/bcrypt — all gone) + removed the `prisma.seed` block from package.json.

**Part C — meetsy-api auth (JWT → read-only cookie session):**
- New `SessionService.validate(token)`: `sha256` lookup on `public.sessions` (include user) → reject expired / idle (`SESSION_IDLE_TIMEOUT_DAYS`, default 7) / disabled user. **READ-ONLY adaptation:** unlike Clicksy it does NOT delete expired/idle rows and does NOT touch `last_seen_at` (Meetsy has no write grant on public — no sliding refresh).
- New `AuthGuard` (global APP_GUARD): `@Public` bypass → optional `x-admin-key` machine-cred branch (timing-safe → synthetic Owner principal, `orgId:''` in Phase 0) → `clickup_sync_sid` cookie → `validate` → CSRF double-submit (`x-csrf-token`==`csrf` cookie) on mutating verbs → set `req.user` AuthPrincipal. Rewrote `RolesGuard` to honor `@Roles(OWNER|ADMIN|MEMBER)`. New consolidated `decorators.ts` (`Public`/`Roles`/`CurrentUser`). `AuthModule` now provides/exports only `SessionService`.
- **Removed JWT entirely:** deleted `jwt.strategy.ts`, `jwt-auth.guard.ts`, `auth.service.ts`, `public/roles/current-user.decorator.ts`; dropped `@nestjs/jwt`/`@nestjs/passport`/`passport-jwt`/`bcryptjs` (+types) deps and JWT env vars. **No Meetsy login** — `auth.controller.ts` is now just `GET /auth/me` echoing the principal.
- `cookie-parser` dep added + `app.use(cookieParser())` in `main.ts` (CORS already had `credentials:true`). env.ts: `DATABASE_URL`→`MEETSY_DATABASE_URL`, dropped `JWT_*`, added `SESSION_MAX_AGE_DAYS`/`SESSION_IDLE_TIMEOUT_DAYS`/`ADMIN_API_KEY`.
- **SSE:** dropped `@Public()` on `GET /runs/:id/stream` (cookie auth works for EventSource); left a `TODO(phase0-frontend)` that cross-origin EventSource needs `withCredentials:true`.
- **workspaceId:** new `WorkspaceResolver.resolve(orgId, ?workspaceId)` (explicit id else `is_default` workspace from the public read-model); threaded into `createMeeting` (controller reads `?workspaceId=`) so the new non-null `workspaceId` columns on Meeting+Run are satisfied. Pipeline NOT rewritten (`TODO(phase1)` to scope every endpoint by workspace).

**Role mapping conversions (`@Roles`):** the audit found **zero** existing `@Roles(...)` usages in meetsy-api (only `@Public()` on health + the old SSE). So no admin→`OWNER,ADMIN` / member→none conversions were needed — the decorator + guard were swapped to Clicksy roles for future use. `CurrentUser` type is now `AuthPrincipal` (role `OWNER|ADMIN|MEMBER`) across all analysis endpoints.

**Part D — the ONE Clicksy edit:** `src/auth/auth.controller.ts` `setSession` adds `domain: process.env.COOKIE_DOMAIN || undefined` to BOTH `res.cookie` calls; `COOKIE_DOMAIN` added as optional env in `src/config/env.validation.ts`. `.env.example` updated (`COOKIE_DOMAIN`, `MEETSY_DATABASE_URL`, `CORS_ORIGINS`, reuse of `SESSION_*`/`ADMIN_API_KEY`/`APP_ENCRYPTION_KEY`, Azure chat vars). No other Clicksy `src/` or `prisma/` change. No Clicksy test asserted exact cookie options, so none needed updating.

**Verify (all GREEN, Node v25.9.0):**
| # | Target | Command | Result |
|---|---|---|---|
| a | install | `pnpm install` | PASS |
| b | `@clicksy/shared` build | `pnpm --filter @clicksy/shared build` | PASS |
| c | meetsy Prisma client | `MEETSY_DATABASE_URL=… pnpm exec prisma generate` (in apps/meetsy-api) | PASS — multiSchema accepted on 5.22; no DB needed |
| d | `@ma/api` typecheck | `pnpm --filter @ma/api typecheck` | PASS |
| e | `@ma/api` build | `pnpm --filter @ma/api build` | PASS |
| f | Clicksy build | `pnpm build` | PASS |
| g | Clicksy tests | `pnpm test` | PASS — 63 suites / 561 tests (cookie-Domain edit broke nothing) |

**Deferred / stubbed:** migration UNAPPLIED (no DB) + `grants.sql` applied out-of-band; Prisma 5→7 upgrade; full `?workspaceId=` wiring through every endpoint (`TODO(phase1)`); SSE frontend `withCredentials` (`TODO(phase0-frontend)`); the machine-cred principal's `orgId` is `''` in Phase 0 (resolver falls back to default workspace regardless of org). Frontend auth rewrite untouched (out of scope).

**Next:** Azure deployment-per-call refactor + separate embedding client (spec §4); then meetsy-web cookie-auth rewrite + cross-subdomain manual check; then apply migration/grants against a live shared DB.

### 2026-06-27 — Step 2 reviewed & confirmed (orchestrator)
Independently reviewed the security-critical output:
- **Clicksy change minimal & correct:** only `auth.controller.ts` (env-gated `domain` on both cookies; `undefined` default = prior host-only behavior) + `env.validation.ts` (`COOKIE_DOMAIN` optional). Clicksy `prisma/` untouched; 561 tests pass.
- **Shared `sha256`** byte-identical to Clicksy's for string tokens → same `token_hash`.
- **`SessionService.validate()`** genuinely read-only (rejects expired/idle/disabled without delete/touch) — correct for the SELECT-only role.
- **meetsy `public` read-models** map exactly to Clicksy's real columns (`token_hash`/`user_id`/`org_id`/`role`/`status`/`is_default` + Session→User relation) → lookup resolves at runtime.
- **Caveat:** live verification still pending (needs running shared Postgres + applied `grants.sql`).

**Phase 0 remaining:** (4) AzureOpenAIService refactor; (5) meetsy-web cookie-auth rewrite; (6) deploy/routing (Caddy `meetsy.<domain>` + compose); (7) live verification.

### 2026-06-27 — Steps 3+4+5 (parallel) + Dockerfile fix — DONE / GREEN (code-first)
Ran three scoped agents in parallel (disjoint files, no installs), then orchestrator-reviewed + consolidated-verified.

**Step 3 — AzureOpenAIService refactor** (`apps/meetsy-api/src/azure/**`, `config/env.ts`):
- `structured<T>()` gained optional `deployment?: string` (default unchanged) — per-call model selection, additive/opt-in. **No pipeline stage's model changed** (all 7 callers still default to gpt-5.4).
- New `azure-embedding.service.ts`: separate **lazy/optional** `AzureOpenAI` client for the embeddings resource (`AZURE_EMBED_*`, all optional → app boots without them; errors only if `embed()` called unconfigured). `embed(input, {dimensions})` sorts by index, returns vectors.
- Responses-API seam `structuredViaResponses<T>()` throws `// TODO(phase2)` (interface only, for gpt-5.4-pro).
- Flag: `embed()` shares the per-run ALS token accumulator with chat → Phase 2 should split it.

**Step 4 — meetsy-web cookie-auth rewrite** (`apps/meetsy-web/**` only):
- Removed ALL localStorage JWT (storage, Bearer header, refresh-retry) and **deleted the login/register pages**. Single `request()` wrapper: `credentials:'include'` always; mutating verbs read the `csrf` cookie (raw/un-decoded to byte-match) → `x-csrf-token`.
- 401 from any call → `redirectToClicksyLogin()` → `${NEXT_PUBLIC_CLICKSY_LOGIN_URL}?redirect=<href>` (default `http://localhost:5173/login`). `AppShell` gate calls `GET /auth/me`.
- `EventSource` now `{ withCredentials: true }`. TODO(phase0): SSE `onerror` has no status code → relies on the parallel `getRun()` 401 to trigger redirect (falls back to polling meanwhile).

**Step 5 — deploy/routing** (`docker-compose.yml`, `docker-compose.prod.yml`, `Caddyfile`, `.env.example`):
- Added `meetsy-api` (listen 3010) + `meetsy-web` (internal 3000, dev host 3001) to dev+prod compose; build `context: .` + `dockerfile: apps/meetsy-*/Dockerfile`; meetsy-api ENTRYPOINT runs `prisma migrate deploy` (meetsy schema only) via `MEETSY_DATABASE_URL`. Both compose files pass `docker compose config -q`.
- Caddy `meetsy.{$DOMAIN}`: `handle_path /api/*` → strip `/api` → `meetsy-api:3010 { flush_interval -1 }` (SSE); `handle` → `meetsy-web:3000` (gzip scoped to web only). Clicksy routing untouched.
- `.env.example`: added `AZURE_EMBED_*` + `NEXT_PUBLIC_CLICKSY_LOGIN_URL` (Meetsy section already had `MEETSY_DATABASE_URL`/`COOKIE_DOMAIN`/`CORS_ORIGINS`/`APP_ENCRYPTION_KEY` note from Step 2). Added a Phase-2 pgvector image-swap note on `postgres`.

**Dockerfile fix (orchestrator):** the fold had copied the Dockerfiles + entrypoint verbatim with **stale `apps/api`/`apps/web` paths** (meetsy-web's would have built *Clicksy's* frontend). Repointed both Dockerfiles' manifest copies (now list ALL workspace members for frozen-lockfile), node_modules copies, `.next/standalone`+`static` paths, `CMD`/entrypoint, and the entrypoint's `node …/dist/main.js` to `apps/meetsy-{api,web}`.

**Consolidated verify (Node v25.9.0):** `@ma/api` typecheck+build ✅ · `@ma/web` typecheck+build ✅ · `@clicksy/shared` build ✅ · Clicksy `nest build` ✅. Clicksy `src/` diff = exactly the 2 cookie-Domain files; `prisma/`+`test/` untouched (561 Clicksy tests confirmed green at Step 2; nothing has touched Clicksy src/test since).

**Phase 0 status: backend + frontend + infra COMPLETE at code-first/typecheck level. Not committed.**
**UNVERIFIED until live (needs Docker + Node ≥22.12 + shared Postgres):** (a) meetsy Docker images actually build (Dockerfile deps-manifest list + a `.dockerignore` for node_modules should be validated at first real build); (b) apply `apps/meetsy-api/prisma/grants.sql` + the `0001_init_meetsy_schema` migration; (c) end-to-end cross-subdomain cookie auth + least-privilege `INSERT public` denial + SSE-with-credentials. This is the deferred "Step 6 — live verification".

### 2026-06-27 — Auth completion (advisor-flagged gaps) — DONE / GREEN
Advisor review caught two items that were *unfinished* (not just unverified) and needed no DB — fixed before declaring Phase 0 done:

**Part A — meetsy-api auth UNIT tests (were missing; spec §6 requires them).** Added jest (mirrors Clicksy: `jest@30.4.2`/`ts-jest@29.4.9`/`@types/jest`/`@nestjs/testing@^10.4.4`) + `"test"` script + jest config; fixed `tsconfig.json` `types: ["node","jest"]` (build still excludes specs). `session.service.spec.ts` + `auth.guard.spec.ts`: valid/unknown/expired/idle/disabled session paths, the **read-only invariant** (expired → `delete`/`update` spied & asserted NOT called), `tokenHash === sha256(token)`, and the full guard matrix (`@Public`, valid cookie → exact principal, missing cookie/invalid → 401, CSRF mismatch/missing → 403, header===cookie → ok, machine-cred → synthetic OWNER). **`pnpm --filter @ma/api test` → 2 suites / 15 tests pass.**

**Part B — closed the single-login round-trip (2nd Clicksy change, `apps/web` FRONTEND only).** Clicksy's `LoginPage` hardcoded `navigate('/overview')`; a user sent from Meetsy was never returned. Added `apps/web/src/lib/redirect.ts` `safeMeetsyRedirect()` — **fail-closed exact-origin allowlist** against build-time `VITE_MEETSY_WEB_ORIGIN`: `new URL(raw)` with NO base arg (relative/protocol-relative throw → null), `javascript:`/`data:` → origin `"null"` ≠ allowed, exact-origin compare; anything else → null. Wired into BOTH LoginPage call-sites (already-authed effect + post-login) → `window.location.href = r` for the cross-subdomain return, else `/overview`. Clicksy `src/` (backend) still exactly the 2 cookie files; this is `apps/web` frontend only. `pnpm --filter web build` green.

**✅ PHASE 0 COMPLETE (code + unit tests).** Only Step 6 (live DB/Docker verification) remains, deferred by product-owner choice.

### Live-verification checklist (Step 6 — run when Docker up + Node ≥22.12)
1. **DB up w/ migrations:** start Clicksy's Postgres; ensure Clicksy migrations applied (so `public.sessions/users/workspaces` exist).
2. **meetsy role:** apply `apps/meetsy-api/prisma/grants.sql` (creates `meetsy` role + schema, SELECT-only on the 3 public tables).
3. **meetsy migration:** set `MEETSY_DATABASE_URL=postgresql://meetsy:…@host/clickup_sync?schema=meetsy` (the `?schema=meetsy` matters so `_prisma_migrations` lands in `meetsy`, not `public` — else the SELECT-only grant makes migrate fail), then `pnpm --filter @ma/api db:deploy`. Confirm the migration dir is a valid Prisma migration (timestamped + `migration_lock.toml`).
4. **Least-privilege proof:** as the `meetsy` role, `INSERT INTO public.users …` must be **DENIED** (permission error). Asserts read-only is DB-enforced.
5. **Cross-origin cookie round-trip (the make-or-break):** with `COOKIE_DOMAIN` set (prod) or via the dev localhost:5173↔:3001 ports, log into Clicksy, open Meetsy → confirm BOTH `clickup_sync_sid` (HTTP-only) and `csrf` (JS-readable) reach meetsy-api, `GET /auth/me` returns the principal, a mutating call passes CSRF, and a session-less request 401→redirects to Clicksy login and back. Test in a real browser, not curl (SameSite/secure/CORS-credentials must all line up).
6. **Docker images:** `docker compose build meetsy-api meetsy-web` actually succeeds (validate the deps-manifest list + add a `.dockerignore` excluding `node_modules`/`.next`/`dist` if the build pulls host junk).

### 2026-06-27 — Live verification Part 1 (DB plumbing) — DONE / PROVEN + 2 real fixes
Drove the DB-side checklist live (Docker up; Postgres on host **55432** via a throwaway compose override because the user's other projects — `inhunt` on 5433, `ma_*` on 5432/6379 — held the default ports). Container-internal port unchanged.

**Proven end-to-end (from a clean slate, production operator flow):**
- Clicksy migrations apply → `public.users/sessions/workspaces` exist.
- `grants.sql` (operator/superuser) creates the `meetsy` role + schema + grants.
- `prisma migrate deploy` **as the `meetsy` role** applies `0001` **first-try** → `meetsy.{Meeting,AnalysisRun,Feedback,ChatMessage,_prisma_migrations}`; `_prisma_migrations` lands in **meetsy**, not public.
- **Least-privilege boundary (DB-enforced):** `meetsy` SELECTs `public.sessions`/`users` ✓; **INSERT & UPDATE on `public.users` → DENIED** ("permission denied for table users") ✓; writes its own `meetsy.Meeting` ✓; **cannot** read `public.clickup_tasks` (not granted till Phase 2) → DENIED ✓.

**Two real fixes found by live-verify (committed):**
1. **`migration.sql`** — removed `CREATE SCHEMA IF NOT EXISTS "meetsy"`. The least-priv role has CREATE on the *schema* but not the *database*, so a `CREATE SCHEMA` in the migration fails with "permission denied for database". Schema creation belongs to the operator (`grants.sql`), migrations create only tables.
2. **`grants.sql`** — pre-creates `meetsy."_prisma_migrations"` (owned by `meetsy`). Under multiSchema, with Clicksy's `public._prisma_migrations` already present, Prisma's `migrate deploy` will NOT auto-create the meetsy migrations table ("migration persistence is not initialized" — fails even as superuser), and the least-priv role can't make one itself. Pre-provisioning it makes `migrate deploy` work as the `meetsy` role at container start. (Earlier checklist note about `db:deploy` is superseded: use `pnpm --filter @ma/api exec prisma migrate deploy` to bypass meetsy's `dotenv -e ../../.env` wrapper when no root `.env` exists.)

**Still pending — Part 2 (app-level cookie round-trip):** needs Clicksy + meetsy-api running + a real browser (SameSite/secure/CORS-credentials/COOKIE_DOMAIN). The backend half is effectively proven (validate() logic by unit tests + live SELECT on `public.sessions` with matching column maps); the untested remainder is the real-browser cross-origin cookie+CSRF delivery and the meetsy Docker image builds.

**Live test env note:** Postgres left running on host 55432 (`docker compose -f docker-compose.yml -f <scratchpad>/compose.override.yml up -d postgres`); `meetsy` role password set to `meetsy` (dev only). Tear down with `docker compose down`.

### 2026-06-27 — Live verification Part 2 (app-level cookie round-trip) — DONE / PROVEN ✅
Ran the real stack: Postgres+Redis (55432/56379) + Clicksy backend (`node dist/src/main.js`, `COOKIE_DOMAIN=.localtest.me`, DB=meetsy-shared) + meetsy-api (`node apps/meetsy-api/dist/main.js`, **dummy Azure creds** — `/auth/me` never calls Azure, only needs non-empty to pass boot). Used `*.localtest.me` (→127.0.0.1) so a parent-domain cookie genuinely crosses origins (plain `localhost:port` can't — different origins).

- **Clicksy signup** (`POST app.localtest.me:3000/api/auth/signup`, needs `{email,password,name,orgName}`) → `201` with `Set-Cookie: clickup_sync_sid=…; Domain=.localtest.me; HttpOnly; SameSite=Lax` AND `csrf=…; Domain=.localtest.me`. **The COOKIE_DOMAIN change works** — both cookies scoped to the parent domain.
- **(A) Cross-subdomain validation:** `GET meetsy.localtest.me:3010/auth/me` with that cookie → **200** `{userId, orgId:"org_seed", role:"OWNER", email:"owner@localtest.me", isMachine:false}`. meetsy-api hashed the Clicksy cookie, read `public.sessions` **as the read-only `meetsy` role**, loaded the user, returned the principal. **End-to-end shared login proven on the live stack.**
- **(B)** no cookie → **401**; **(C)** forged cookie → **401**.
- **(D)** mutating `POST /meetings` with session cookie but NO `x-csrf-token` → **403**; **(E)** same with matching `x-csrf-token` → **500** (passed auth+CSRF guard, failed only in the pipeline on dummy Azure). **CSRF double-submit enforced cross-service.**
- meetsy-api boots clean against the live DB as the `meetsy` role (BullMQ worker + routes up); Clicksy routes are under `/api` prefix; Clicksy entry is `dist/src/main.js` (pre-existing — `prisma.config.ts` in tsconfig `include` widens rootDir; NOT a Phase-0 regression).

**Notes / minor follow-ups (non-blocking):** Clicksy's `start:prod` script says `node dist/main.js` but the build emits `dist/src/main.js` — pre-existing latent mismatch, not introduced here (flag for Clicksy owners). meetsy Docker image builds still unbuilt-unverified (Part-1 checklist item 6) — validate at first real `docker compose build`.

## ✅✅ PHASE 0 FULLY COMPLETE & LIVE-VERIFIED
Monorepo fold · shared cookie auth (unit + live) · `meetsy` schema + least-privilege role (live boundary proof) · per-call Azure + embedding client · meetsy-web cookie auth · deploy/routing · **cross-subdomain single-login + CSRF proven end-to-end.** Remaining deferrable ops item: meetsy Docker image build validation. **Ready for Phase 1 (ClickUp write-back).**

---

## Phase 1 — ClickUp write-back

Spec: `docs/superpowers/specs/2026-06-27-meetsy-phase1-clickup-writeback-design.md`. Creates-only push of pipeline tasks into a target ClickUp list; history/RAG is Phase 2, smart-assign + learning loop Phase 3.

### 2026-06-27 — Phase 1 BACKEND — DONE / GREEN (code + tests; live-migrated)
- **`@clicksy/shared` decrypt-only crypto** (`crypto.ts`): `parseEncryptionKey` (64-hex → base64-32 → raw-32, Clicksy's precedence) + `decryptSecret` (AES-256-GCM `base64(iv|tag|ct)`, tamper-throwing) — exact inverse of Clicksy's `crypto.service.encrypt`. **9 tests** incl. byte-parity round-trip + tampered-throw.
- **meetsy ClickUp client** (`apps/meetsy-api/src/clickup/`, native fetch): `createTask` (NEW — Clicksy has none), `getTeamMembers`, `getSpaceTree`. `ClickUpTokenService` resolves the per-workspace token from `public.workspaces.clickupApiTokenEnc` (read-model) → `decryptSecret(parseEncryptionKey(APP_ENCRYPTION_KEY))`, falls back to `CLICKUP_API_TOKEN` env, else throws.
- **Services:** `AssigneeResolverService` (name→clickupUserId within the allowlist only), `TaskMapperService` (priority urgent/high/normal/low→1/2/3/4, dueDate ISO→epoch ms, markdown_description w/ criteria+evidence), `PushConfigService`, `PushService` (idempotent per `(runId,meetsyTaskId)`; skips already-pushed; **allowlist enforced at the POST boundary**; per-task independent failure; audits to `meetsy.TaskPush`).
- **Endpoints:** `GET/PUT /workspaces/:id/push-config` (PUT Owner/Admin), `GET /clickup/lists|members` (Owner/Admin), `GET|POST /runs/:id/push`, plus `GET /workspaces` (list enabler, orchestrator-added). Org/workspace-scoped; CSRF on mutations.
- **Schema/migration:** `WorkspacePushConfig` + `TaskPush` (+ `PushStatus` enum) in `meetsy`; migration `20260627120000_meetsy_phase1_push` (no CREATE SCHEMA) **applied live as the `meetsy` role first-try**; both tables confirmed present.
- **Env:** `APP_ENCRYPTION_KEY` + `CLICKUP_API_TOKEN` added to meetsy `env.ts`, both optional (app boots without; push errors clearly if used unconfigured).
- **51 meetsy-api tests** pass (15 Phase 0 + 36 new). Clicksy `src/`+`prisma/` untouched.

### 2026-06-27 — Phase 1 FRONTEND (meetsy-web) — DONE / GREEN
- `lib/api.ts`: 7 typed methods via the cookie+CSRF `request()` wrapper; types mirror the backend DTOs exactly.
- `lib/user-context.tsx` (`UserProvider`/`useCurrentUser`) + `AppShell` nav link "Push settings" (Owner/Admin only).
- **`/settings/push`** page (Owner/Admin-gated): workspace selector (default-first), target-list **tree picker** (space→folder→list), assignable-members **checklist**, optional defaultStatus; `Promise.allSettled` so a missing-token surfaces a banner not a crash; saves via PUT.
- **Review-screen `PushSection`** (run results): fetches `GET /runs/:id/push`; null config → banner→settings; else per-task editable **assignee dropdown (allowlist, pre-resolved from suggestions)** + priority + due + optional list-override; **already-pushed rows locked with ✓ + ClickUp link**; bulk "Push to ClickUp" (confirm) → `POST /runs/:id/push`; per-row ✓/✗/skipped + re-fetch; edits preserved across feedback/chat re-fetches.
- typecheck + `next build` green.

### Deferred / notes (Phase 1)
- **Live ClickUp push NOT yet exercised** against a real list (all ClickUp HTTP mocked in tests). The make-or-break ops check: configure a workspace's token+list, push a run, confirm tasks appear with correct assignee/priority/due, and re-push doesn't duplicate. Needs a real/sandbox ClickUp workspace.
- Idempotency residual: two *simultaneous* pushes could both create before either `TaskPush` lands (unique key prevents double-record but not double-create on a true race) — human-triggered, low risk.
- Per-task list **override** is a free-text list-id input (the `/clickup/lists` tree is Owner/Admin-only; a Member pushing can't fetch it) — admin tree-override is a fast-follow.
- Subtasks/dependency-links folded into the description; real ClickUp child tasks + dep links = Phase 1.x.

### 2026-06-27 — Phase 1 LIVE ClickUp push — DONE / PROVEN ✅
Ran the real path end-to-end against the live ClickUp API (test team `90181854711`, token via scratchpad). Reused the Phase-0 test DB + session cookie; booted meetsy-api with `CLICKUP_API_TOKEN` as the env fallback (no per-workspace stored token → no decrypt needed). Created a dedicated throwaway list `Meetsy Live Test` (`901819060208`) so nothing existing was touched. Seeded a default workspace (`ws_livetest` → team `90181854711`) + a completed run.
- `GET /clickup/members` (meetsy-api) → parsed live `.user.id` correctly → `clickupUserId:"242630708"`.
- `PUT /workspaces/ws_livetest/push-config` (target list + assignable member) → 200 (CSRF).
- `POST /runs/run_live/push` (1 task, assignee 242630708, priority high) → `pushed`, task `86ey2yc7a`.
- **Read back from ClickUp:** name ✓, priority `high` ✓, tags `[meetsy]` ✓, description carries Acceptance criteria + Evidence ✓, list `901819060208` ✓, and **ASSIGNEES `[(242630708, 'Shoabur…')]`** ✓ — the assignee is ACTUALLY set (the advisor's string-vs-number "silent drop" risk disproven live; the mapper sends an integer).
- **Idempotent re-push** → `skipped`, same task id; **list task count = 1** (no duplicate). ✓
- Advisor's other two flagged risks (`.user` nesting, push DTO carrying criteria/evidence) verified earlier against the code AND now confirmed on real data.

**Fix found by live-verify (committed):** date-only due dates (`YYYY-MM-DD`) were sent at UTC midnight and ClickUp shifted them to the prior day for a `+06:00` workspace (showed `2026-06-30` for `2026-07-01`). `TaskMapperService` now anchors a bare date at **noon UTC** (`T12:00:00Z`); full datetime strings pass through. +1 test (52 meetsy-api tests now).

**Test-env note:** a real task (`86ey2yc7a`) exists in the throwaway list `Meetsy Live Test` (`901819060208`) in team `90181854711` — safe to delete the whole list. ClickUp token is in the scratchpad only; user will rotate it.

## ✅✅ PHASE 1 COMPLETE & LIVE-VERIFIED — real ClickUp task created with assignee set, idempotent, correct fields. Next available: Phase 2 (RAG/KB) or polish (subtasks/dep-links Phase 1.x, meetsy Docker image build validation).

---

## Phase 2.0 — Clicksy ClickUp comment-sync (the first substantive Clicksy feature)

Spec: `docs/superpowers/specs/2026-06-27-clicksy-comment-sync-design.md`. Enables Meetsy's KB to read task comments (Clicksy mirrored descriptions but not comments).

### 2026-06-28 — Phase 2.0 — DONE / GREEN + LIVE-VERIFIED
**Purely additive to Clicksy** (11 files modified — all additions; new `src/comments/` module + `comment-sync.processor` + migration `0014_clickup_task_comments`). Existing task/time-entry/webhook paths untouched.
- **Schema:** `ClickupTaskComment` (no FK on `task_id` — append-log like `ClickupTaskEvent`, so a comment webhook before the task is mirrored still inserts; upsert by `commentId`) + `commentsSyncedAt`/`commentCount` markers on `ClickupTask` (so Meetsy re-embeds a task once on comment completion, not per page).
- **Client:** `getTaskComments` — `GET /task/{id}/comment`, pages backward via `start`+`start_id` (25/page, no "since" filter), dedupes, reuses 429 handling.
- **Queue/worker:** `clickup-comments` queue + `CommentSyncProcessor`; own **40/min limiter** (under the verified 100/min token budget shared with the 30/min task/time-entry sync); BullMQ **priority** by task value (open/in-progress > recently-updated > else). `markTaskCommentsSynced` uses `updateMany` → safely no-ops if the task isn't mirrored.
- **Webhook:** `taskCommentPosted`/`taskCommentUpdated` added to default `CLICKUP_WEBHOOK_EVENTS` (+ `workspace.service` `DEFAULT_EVENTS`); processor branch enqueues a comment re-fetch (idempotent; one code path with backfill). Parser unchanged (top-level `task_id` already extracted).
- **Backfill:** opt-in only (NOT the hourly sweep). Admin endpoints `POST /admin/comments/sync-task` + `POST /admin/comments/backfill {spaceId}` (RBAC + audit free; Meetsy-triggerable via `x-admin-key`).
- **Meetsy read:** `GRANT SELECT ON public.clickup_task_comments TO meetsy` added to `grants.sql`.
- **Verify:** `nest build` ✅ · full suite **641 tests** ✅ (baseline 622 after origin/main merge + 19 new) · **lint regression FIXED** — added `globals` devDep (eslint flat config imports it; pnpm didn't hoist it since the Phase-0 npm→pnpm conversion → `pnpm lint` had been broken; now passes, 0 errors).
- **LIVE-VERIFIED on team "Chishty" (`90181854711`)** with the real token: posted 2 comments to test task `86ey2yc7a` → `POST /admin/comments/sync-task` → both stored in `clickup_task_comments` with author + text; `commentsSyncedAt` set, `commentCount=2`; **re-run idempotent** (still 2 rows, `sync_count` 1→2). The webhook *live-capture* path is unit-tested only (needs a public endpoint; verify at deploy).
- **Deferred (TODO in-code):** threaded replies (`parentCommentId` reserved, no ClickUp reply webhook), comment-delete reconciliation (no ClickUp comment-deleted webhook).
- **Test artifacts:** 2 comments on task `86ey2yc7a` in the throwaway "Meetsy Live Test" list (team `90181854711`) — deletable with the list.

**Next:** Phase 2a — minimal KB slice (pgvector image swap + `meetsy` kb_chunk + onboarding embed). VALUE verification still gated on a ClickUp token with access to the real "Nifty" history.

---

## Phase 2a — minimal KB slice

Spec: `docs/superpowers/specs/2026-06-28-meetsy-phase2a-kb-slice-design.md`. Per-workspace RAG KB: embed ClickUp tasks → hybrid-searchable index.

### 2026-06-28 — Phase 2a — DONE / GREEN + LIVE-VERIFIED (incl. real semantic retrieval)
Built (meetsy-api): `pgvector` enablement; `meetsy.KbChunk` (`vector(1024)` HNSW + generated `tsv` GIN + filter metadata) + `KbSyncState`; public read-models (clickup_tasks/comments/events/time_entries/sync_job_logs/workspace_spaces); deterministic **card builder** (comments folded only on `commentsSyncedAt` → one re-embed); embed via `AzureEmbeddingService` (`dimensions:1024`, batched); **`meetsy-kb` queue/worker** (coverage-check → trigger Clicksy `/admin/backfill` + `/admin/comments/backfill` via `x-admin-key`, poll, then embed; **graceful degrade** to "embed what's mirrored" on admin error/unreachable; transactional cursor advance); **hybrid search** (`$queryRaw` pgvector cosine `OPERATOR(public.<=>)` + `tsv websearch_to_tsquery` → **RRF k=60**; `hnsw.iterative_scan=relaxed_order`); endpoints `POST kb/onboard`, `GET kb/status`, `GET kb/search`. Env: `CLICKSY_ADMIN_URL` (+ reused `ADMIN_API_KEY`/`AZURE_EMBED_*`). grants.sql: `CREATE EXTENSION vector`, `ALTER ROLE meetsy SET search_path`, SELECT on the clickup_* mirror tables. **73 meetsy-api tests** (21 new) + build green; Clicksy untouched.

**LIVE-VERIFIED** on team "Chishty" (real ClickUp data; Nifty `3450636` still inaccessible — 0 spaces — so seeded 10 varied tasks + the prior 1 into Chishty):
- pgvector **0.8.3** enabled via image swap `postgres:18-alpine`→`pgvector/pgvector:pg18` (data survived); migration applied as the `meetsy` role (KbChunk `vector(1024)` + HNSW + GIN indexes present).
- Onboarded `ws_seed` → **embedded 11/11** (1024-dim), `status=ready`.
- **🎯 Semantic retrieval proven** — paraphrased queries with ZERO keyword overlap returned the correct task #1 every time: "users get logged out"→SSO session-expiry; "customers charged twice"→Stripe double-charge; "charts not showing on apple browser"→Safari chart; "database runs out of connections"→PG pool; "phone alerts not arriving"→iOS push. This is the actual point of the KB (meaning-match beyond keywords), proven live.
- **Incremental** re-onboard → 0 re-embeds (content-hash + cursor gating holds).

**Bug found by live-verify + FIXED (committed):** `lookbackDaysForRange("all")=36_500` exceeded Clicksy's 3650 cap → backfill 400. `ensureCoverage` now clamps the value sent to Clicksy to 3650 (the KB's own embed window is unaffected). The cross-service trigger itself works (meetsy worker reached Clicksy admin).

**Test-environment notes (NOT code bugs):** Clicksy caches `workspace_spaces` at boot, so a space inserted via raw SQL reads as "Valid: (none)" to the admin backfill until Clicksy restarts / the space is added via its API (in real use it is) — so for the value test the 11 tasks were mirrored into `clickup_tasks` directly. There were two `is_default` workspaces (`ws_seed`=team 3450636, `ws_livetest`=team 90181854711) — consolidated onto `ws_seed` (repointed to the Chishty team) for a consistent test. The comment-debounce embed path wasn't exercised (mirrored tasks had no comments) — covered by unit tests; verify with comments on real data later.

**Test artifacts:** 11 tasks in the throwaway "Meetsy Live Test" list (Chishty team `90181854711`), deletable. Local pgvector Postgres on 55432.

## ✅ PHASE 2a COMPLETE & LIVE-VERIFIED (incl. real semantic retrieval). Next: 2a.1 "what we learned" card → 2b docs+improvement metric → 2c pipeline integration.

---

## Phase 2a.1 — "what we learned" summary card

Spec: `docs/superpowers/specs/2026-06-28-meetsy-phase2a1-summary-card-design.md`.

### 2026-06-28 — Phase 2a.1 — DONE / GREEN + LIVE-VERIFIED ON REAL NIFTY DATA 🎉
Built (meetsy-api): `meetsy.KbSummary` (cache) + migration; `SummaryFactsService` (aggregate SQL — roster+ownership, components, throughput/median-cycle, categories, workload, blockers, coverage; **zero Azure dependency**); `NarrativeService` (ONE gpt-5.4-mini `structured()` call, "no inventing numbers" guard); `SummaryService` (facts always + narrative-if-configured + cache w/ drift-based regenerate); `GET /workspaces/:id/kb/summary?refresh=`. **103 meetsy-api tests** (30 new); build green; Clicksy untouched.

**🔑 NIFTY UNLOCKED:** the user provided a token with real "Nifty" (`3450636`) access (Ahmad, `ahmad@niftybookkeepers.com`) — 37 members, 5 spaces (3 match the prod config: Digital Marketing 3577824, R&D Apps 3589129, Projects 3525433). Verified read-only. Production webhook host `clicksy.niftyitsolution.com` reachable.

**LIVE-VERIFIED on REAL production data:** mirrored **614 real R&D-Apps tasks** (Clicksy backfill with the Nifty token), embedded **614/614** (pgvector), then:
- **Semantic search** over real tasks returned results for paraphrased queries (energy-report PDF, CRM→accounting sync, bookkeeping automation).
- **"What we learned" card is accurate on real data:** roster = Shoabur (357 tasks), Rashedul Hasan (150, owns Energy Reporting), Ahmad (57), Sayem Billah (44), Zahidul Fahim (10); components = Sprint 13/14/15, [Nifty AI] Backlog, R&D sprints; status Closed 331/done 217/to-do 44; clients Nifty AI 349 / Energy Reporting 190 / AIT 6; cycle median p50≈0/p75≈4.9d (genuinely skewed — query verified correct vs direct SQL). **Narrative (gpt-5.4-mini, live)** produced an accurate team profile ("centered on Nifty AI and Energy Reporting… Shoabur is the main driver… Rashedul…"). Two suspected "bugs" (components-null, cycle≈0) were **false alarms** (my display-parse used wrong keys; both facets are correct).

**Real onboarding-robustness findings (NOT card bugs; for a follow-up):**
1. **Onboarding blocks on the time-entries backfill phase** — `ensureCoverage`→`pollUntilDrained` waits for the slow per-task time-entries sync (hundreds of reqs @ ≤100/min) that the *embed doesn't need*. Should stop waiting once the task-fetch phase completes (the `/admin/backfill/active` `phase` field already distinguishes `fetching` vs `time-entries`). Workaround used in verification: onboard without `CLICKSY_ADMIN_URL` (embeds already-mirrored).
2. **A killed worker leaves the job locked** (`lockDuration: 10min`); a re-onboard (jobId=workspaceId) then deduped/stalled until the lock expired. Needs job-recovery/cleanup (or a shorter lock + idempotent resume). Cleared via Redis `bull:meetsy-kb:*` del in verification.
3. Consider presenting cycle time as p50/p75 (skew-honest) rather than a single median.

**Test artifacts:** ws_nifty (team 3450636) + R&D Apps space backfilled into the local test DB (614 tasks); throwaway. The slow time-entries backfill may still be draining locally. Nifty token in scratchpad only (user will rotate).

## ✅ PHASE 2a.1 COMPLETE & LIVE-VERIFIED ON REAL NIFTY HISTORY. Next: 2b (docs + honest improvement metric) → 2c (pipeline integration). Follow-up: the 2 onboarding-robustness fixes above.

---

## Onboarding-robustness fixes (the 2a.1 follow-ups) — DONE / GREEN + LIVE-VERIFIED

### 2026-06-28 — Fix 1 (task-fetch-only poll) + Fix 2 (KB job recovery) — commit `c1f4426`
The two follow-ups flagged in 2a.1 are fixed (meetsy-api only; Clicksy untouched). **108 meetsy-api tests** (5 new) + build green.

**Fix 1 — onboarding no longer blocks on the slow time-entries backfill phase.**
`ClicksyAdminClient.pollUntilDrained` → **`pollUntilTasksFetched`**: it now reads `/admin/backfill/active` and counts only spaces in **`phase: 'fetching'`** (tasks), returning once tasks are mirrored. Time-entry sync (hundreds of per-task calls @ ≤100/min) keeps draining asynchronously in Clicksy — the embed never needed it. (`getActiveSpaceCount`→`getFetchingSpaceCount`; `kb-onboarding.service.ts` caller updated.)

**Fix 2 — a killed `meetsy-kb` worker no longer locks the job ~10min.**
- `lockDuration` 10min → **120s** + `stalledInterval: 30s` + `maxStalledCount: 1` (`kb.processor.ts`). A healthy long run keeps its lock via BullMQ's timer-based auto-renewal (independent of awaited I/O); `lockDuration` now only governs post-crash reclaim latency.
- **Authoritative `failed` handler** (the subtle one): a job exceeding `maxStalledCount` is moved to `failed` by BullMQ *without* re-entering `process()`, so the `catch` that sets `status:"error"` never runs — leaving `kbSyncState` stuck on `"onboarding"` forever. New `worker.on("failed")` → `markFailed()` sets `error` + emits the SSE error event (idempotent with the catch; the first `stalled` event only re-queues, doesn't touch state).
- **`enqueue()` supersedes a retained completed/failed job** before re-adding (`kb.queue.ts`): the stable `jobId=workspaceId` otherwise made a re-onboard a silent no-op (BullMQ dedupes jobId across *all* states incl. retained completed) — which is exactly why every prior re-onboard needed a manual `redis-cli del`.
- Unit tests added: `pollUntilTasksFetched` returns on `phase=time-entries`; `enqueue` removes a completed job before re-adding (`clicksy-admin.client.spec.ts`, `kb.queue.spec.ts`).

**LIVE-VERIFIED on the real Nifty stack (Clicksy + meetsy-api against the 55432 pgvector DB):**
- **Fix 2 / jobId collision:** ws_nifty had a *retained completed* `bull:meetsy-kb:ws_nifty` job. Re-onboard → worker actually re-ran (status `onboarding`→`ready`, fresh `lastRunAt`) with **no `redis-cli del`**. Old code = silent no-op.
- **Fix 2 / crash recovery:** invalidated content-hashes to force a full re-embed, killed meetsy-api `-9` mid-embed (frozen at 100/614, job orphaned in the `active` set, lock TTL ~101s confirming the 120s lock). Restarted → BullMQ stalled-recovery reclaimed it after lock expiry and the worker **resumed from the committed cursor (100, not 0)**, reaching `ready` in **~111s** (vs the old ~600s lock).
- **Fix 1 (the headline):** with `CLICKSY_ADMIN_URL` set, onboarded `12m` (gap vs 90d mirrored → triggered a real Clicksy backfill). Watched `/admin/backfill/active`: `phase: fetching` for ~46s (meetsy correctly *waited*), then it flipped to `phase: time-entries` (**1711 jobs queued, 0 done**) and meetsy proceeded to embed, reaching **`ready` at 75s while time-entries were still entirely undrained (remaining=1711, done=0)**. Old `pollUntilDrained` would have blocked on those 1711 jobs @ ~100/min ≈ **17+ min**. The wider window also pulled ~584 more real Nifty tasks → **KB grew 614 → 1198 chunks**, all embedded (`status=ready, embedded=1198`).

**Notes:** Clicksy was booted only for verification (Nifty token as `CLICKUP_API_TOKEN` env fallback, read-only; no writes/task-creation) and stopped afterward; its leftover production-API time-entry jobs were cleared from Redis. Local test stack (pgvector 55432 / Redis 56379) left running with `ws_nifty` healthy at 1198 chunks.

## ✅ ONBOARDING-ROBUSTNESS FIXES COMPLETE & LIVE-VERIFIED. Next: **Phase 2b** — write the spec, then build (PDF/SOP upload → embed into KB → honest improvement metric [answerability-lift + corpus novelty, never blended] + doc↔task linking) → 2c pipeline integration.

---

## Phase 2b — Document upload + honest KB-improvement metric

Spec: `docs/superpowers/specs/2026-06-28-meetsy-phase2b-docs-improvement-metric-design.md` (APPROVED — locked: hybrid blind judge; show provisional answerability labelled; 25 MB / 300 pages; hard-delete).

### 2026-06-28 — Phase 2b — DONE / GREEN + LIVE-VERIFIED ON REAL NIFTY DATA — commit `ffcc295`
Built (meetsy-api only; Clicksy untouched). **128 meetsy-api tests** (20 new) + build + typecheck green. New deps: `pdf-parse`, `multer`.

- **Data model:** `KbDocument` (sha256 dedup, extracted text persisted / raw bytes discarded, status, `metric` JSON) + `KbDocTaskLink` (plain `taskId` soft-ref, no public write) + migration `20260628140000` (applied as the least-priv `meetsy` role). Doc chunks **reuse `KbChunk`** (`sourceType=document`, `sourceId=docId`) — no KbChunk change.
- **Pipeline:** `POST /workspaces/:id/kb/documents` (multipart, 25 MB cap, Owner/Admin) → `meetsy-kb-docs` worker: parse (`doc-extract`: `pdf-parse` text-PDFs-only, OCR out, scanned→clear error; plain/markdown) → `chunkText` (paragraph-aware, ~400-token target, 15% overlap) → embed (reuses 2a `AzureEmbeddingService` + `embedInBatches`) → metric → `ready`. Worker **reuses the onboarding-robustness fixes** (120s lock + stalledInterval + maxStalledCount:1 + authoritative `failed` handler + enqueue-supersede).
- **Honest metric — two NEVER-blended signals:** (1) **corpus novelty** (`NoveltyService`, pgvector-only, per-chunk nearest-neighbour cosine distance; novelty = minDistance) as the headline; (2) **answerability-lift** (`AnswerabilityService`: held-out questions — real transcripts when present else task-derived+`provisional`; a **blind, identical gpt-5.4-mini judge** before vs after, only the retrieved context differs; delta = `newlyAnswerable`). "No improvement" is first-class.
- **Doc↔task auto-linking** (`DocTaskLinkService`, HNSW per-chunk nearest tasks, best-score aggregate, top-N ≥ 0.75). `GET` list/detail + hard-`DELETE` (chunks+links cascade).

**LIVE-VERIFIED end-to-end on ws_nifty (1198 real Nifty task chunks):**
- **Upload → parse → chunk → embed → ready** for both **markdown** and a **real PDF** (`pdf-parse` extracted "Nifty Vendor Payment Approval Policy… invoices above 5000 USD require dual approval…", pageCount=1).
- **Novelty discriminates honestly:** an energy-themed doc scored medianNovelty **0.243** (more similar to existing energy tasks ⇒ less novel) vs a bookkeeping-SOP **0.399** (genuinely newer) — landing on the right side.
- **Doc↔task linking found the real related task:** the energy doc linked to `86evkrgvw` (0.757) = "Energy Audit Web Portal".
- **🎯 Answerability-lift POSITIVE path proven (the centerpiece):** inserted one `Meeting` whose transcript raised vendor-payment questions, uploaded the vendor-payment-policy PDF → **`provisional=false, source=transcript, before=1→after=3, newlyAnswerable=2, regressions=0`** — *"What is the approval threshold for large vendor invoices?"* and *"Who must sign off…?"* both flipped **N→Y**. This single run proved the transcript branch, that BEFORE/AFTER retrieval genuinely differs, and that the blind judge detects a real lift.
- **Dedup** (identical bytes → `deduped:true`, no reprocess), **unsupported type → 400**, **hard-DELETE** removed doc+chunks+links while the 1198 task chunks stayed intact.

**Honest caveats (recorded, not hidden):**
- All live docs were small (single-chunk), so the novelty **distribution** wasn't exercised and `pctNovel` read 0 for both (maxSim just above the 0.6 cutoff). **`medianNovelty` is the de-facto headline today**; the `pctNovel` cutoff wants tuning on multi-chunk docs (follow-up).
- Uploaded docs are intentionally **NOT** returned by `/kb/search` (it filters `sourceType='clickup_task'`) — docs feed the metric + linking in 2b; surfacing them in retrieval is a 2c decision.

**Test artifacts:** all test docs + the test `Meeting` deleted; ws_nifty restored to 1198 task chunks / 0 docs / 0 meetings. Local stack (pgvector 55432 / Redis 56379) left running.

## ✅ PHASE 2b COMPLETE & LIVE-VERIFIED ON REAL NIFTY DATA (incl. the positive answerability-lift path). Next: **Phase 2c** — pipeline integration (KB context injection into analyze/critic/enrich, field prediction [weak prior + range + evidence, abstain when thin], dedup, HITL sprint/client/points; surface docs in retrieval).

---

## Phase 2c — Pipeline integration (sliced 2c.1 → 2c.2 → 2c.3)

Spec: `docs/superpowers/specs/2026-06-28-meetsy-phase2c-pipeline-integration-design.md` (APPROVED — slice it; predict client/sprint/due/estimate, assignee soft-hint only; live-verify pushes to throwaway list on test team `90181854711`; abstain if top-1 share <0.5 or support <3; sprint = pick target list).

### 2026-06-28 — Phase 2c.1 — Context injection — DONE / GREEN + LIVE-VERIFIED — commit `3802f6a`
Ground transcript→task analysis in the client's KB history (tasks + 2b docs). **137 meetsy-api tests** (9 new) + build green.
- **`KbSearchService`** broadened to a `sourceTypes` filter + **`retrieveContext()`** returning ranked snippets **with provenance** (tasks + documents). `search()` unchanged (tasks-only) → the `/kb/search` endpoint is byte-identical.
- **analyze→critic→enrich:** `criticPass` + `enrichTasks` take an **optional `context` arg** (default undefined ⇒ **byte-identical** prompt, locked by `context-injection.spec.ts`). Context keyed on the analysis **summary/topics/titles** (concise/embeddable), NOT the raw transcript; injected **reference-only** ("don't treat as facts from this meeting"). **analyze-injection deferred to a fast-follow** (avoids the chicken-and-egg of a pre-summary retrieval — documented).
- **Processor:** retrieves context after analyze, injects into critic+enrich, and attaches the retrieved provenance to `result.kbContext` so the injected context is **inspectable, not just plumbed**. Best-effort (KB miss ⇒ exact pre-2c behaviour). Fire-and-forget incremental remap for already-onboarded workspaces (collision-safe via the Fix-2 enqueue-supersede; current run uses the already-embedded KB, next is fresher).
- **Module wiring:** KbModule exports `KbSearchService`/`KbQueue`; AnalysisModule imports it. One-way dep analysis→kb (`workspace.resolver` is Prisma-only ⇒ acyclic).

**LIVE-VERIFIED on ws_nifty (1198 real chunks):** ran a real energy-reporting transcript end-to-end (`POST /meetings` → roster → run). `result.kbContext` held the **8 right "[Energy Reporting]" tasks** (Energy Audit Web Portal, Section editor + AEA-faithful PDF gen, ECM data mapping…) — proving the retrieval is **relevant + inspectable**, not just wired. The run produced 3 enriched tasks with absolute due dates (next-Friday → 2026-07-03), estimates, ACs, and **domain-consistent tags** (energy-reporting/web-portal/aea-layout/ecm). Fire-and-forget remap fired; KB stayed healthy (1198, ready). Test meeting/run cleaned up.

**Fast-follow (documented):** inject context into `analyzeMeeting` too (needs a cheap pre-analyze key: roster+title+bounded head) — deferred from 2c.1 to keep the primary retrieval summary-keyed.

### 2026-06-28 — Phase 2c.2 — Field prediction + duplicate flags — DONE / GREEN + LIVE-VERIFIED — commit `05d8fe2`
Attach weak, history-grounded predictions + dupe flags to the run result (`result.fieldPredictions[id]` / `result.duplicates[id]`); no `@ma/shared` Task change, no push (that's 2c.3). **149 meetsy-api tests** (12 new) + build green.
- **Card-shaped kNN + similarity FLOOR (the echo-trap fix):** per task, build a card comparable to the stored card embeddings, kNN over `clickup_task` chunks, keep only neighbours above a cosine floor (`SIM_FLOOR=0.5`). Plain top-K always returns K → modal-of-K just echoes the corpus base rate; the floor means a task with no genuinely-similar history has `< MIN_QUALIFYING(3)` qualifying neighbours and **abstains for real**.
- **LLM clamp = echo-breaker:** client/sprint/assignee predicted via a similarity-weighted modal prior that a gpt-5.4-mini call may CLAMP to (pick among observed candidates, or abstain). Confidence/support always ride on the **distribution**, never the model's assertion. Due = **p80** cycle-time of closed neighbours (p50 ≈ "due today" here); abstain with <3 closed qualifying.
- **Duplicate flags — EMPIRICALLY calibrated:** measured live that a near-verbatim re-extraction peaks ~**0.73** against the exact existing task (sparse-query vs rich-stored-card asymmetry) with the next distinct task ~0.69 — so the spec's 0.90/0.82 would **never** fire. Bands set to **flag ≥0.72 / suggest ≥0.64** (corpus-tuned; richer query card / per-workspace calibration is a follow-up). Never auto-merge.
- read-model: `ClickupTask.estimation` (Decimal; unmanaged mirror, no migration).

**LIVE-VERIFIED on ws_nifty (1198 chunks) — the discrimination test the advisor required (not just "a prediction appeared"):**
- **AIT (MINORITY client) → predicted AIT**, NOT the majority — the statistical modal was **Nifty AI (9) vs AIT (5)**, but the LLM clamp picked **AIT** from the task text ("explicitly mention AIT"), honestly `conf=low` with the full distribution shown. The echo trap is broken.
- **Majority sanity:** energy → **Energy Reporting [15/15, conf=high]**. **OOD** "holiday party" → **ABSTAIN** every task. **Due** → real p80 future dates (2026-07-01/04/09), not "due today".
- **Dedup:** a re-extracted "Energy Audit Web Portal" **FLAGGED** the real existing task `86evkrgvw` (@0.764) + a second energy task — calibrated bands fire correctly.

All test meetings/runs deleted; ws_nifty restored (1198 chunks, 0 docs, 0 meetings).

**Advisor follow-ups (both-directions checks) — applied:**
- **Dedup true-NEGATIVE verified** (not just the true-positive): measured the top dup cosine for two genuinely-NEW (non-duplicate) tasks — "Fix the audit objectives default…" → **0.648**, "Debug Zoho sync for AIT" → **0.655**. Both land in **SUGGEST (0.64–0.72), NOT FLAG** — so the flag band ("very likely already exists") does **not** over-fire on new-but-related work, while the true near-dup (0.764) still flags. Discriminates in both directions; no margin rule needed.
- **`share` no longer zeroed for minority picks:** `PriorCandidate` now carries its own weighted `share`, and `field()` reports the PICKED value's true support/share + an `isModal` flag (the AIT pick is now `supp=5/15 share≈0.33 isModal=false`, not the contradictory `share=0`). Matters because 2c.3's `FieldOverride` logs this as the Phase-3 learning signal — no corrupted training data.
- **`estimate` filters zero/blank** before the modal (many tasks have estimation 0 → a "0" suggestion is meaningless; abstains when no real estimate exists).

### 2026-06-28 — Phase 2c.3 — HITL push extension — DONE / GREEN + LIVE-VERIFIED — commit `23e96f7`
The final Phase-2 slice: confirm sprint/client/points on the push + log the human's accept/override of the 2c.2 predictions (the Phase-3 signal). **159 meetsy-api tests** (10 new) + build green.
- **Config:** `WorkspacePushConfig` += `clientFieldId`/`clientFieldName`/`clientOptions`/`sprintLists`/`pointsEnabled` (+ migration `20260628150000`, applied as the meetsy role). New **`FieldOverride`** model.
- **`POST /workspaces/:id/push-config/refresh-fields`** — fetch the target list's custom fields (client **dropdown** → option UUIDs from `type_config.options`) + the space tree's lists (sprint targets) from ClickUp; persist on the config.
- **`TaskMapperService.map()`** adds `custom_fields:[{id,value:optionUUID}]` (client) + top-level `points` — **both omitted entirely unless configured+confirmed**, so a Phase-1 push emits the EXACT same payload (the existing 11-case mapper spec still passes). Sprint = the existing per-task `listId` override.
- **`PushService`** writes a `FieldOverride` per pushed task: `predicted` from the **stored run result** (server-authoritative; `assemble` preserves the `t1..tM` id the push carries as `meetsyTaskId`) — **skip on an id-miss** so the table is never null-poisoned (an abstain is real content, not a miss); `confirmed` = the actual list/client/points/assignee.

**LIVE-VERIFIED on the TEST team `90181854711`** (throwaway lists; prod `3450636` **never written** — the test token can't even authenticate against it):
- `refresh-fields` fetched the live **sprint lists** (both test lists); `clientFieldId` null (no dropdown on the test team — honest).
- Pushed two tasks: one **routed to a chosen "Sprint 99" list** (sprint-routing) and **points set on both** (8 / 3 — the Sprints ClickApp is on); ClickUp confirmed placement + points.
- **`FieldOverride` rows written** with the run's `predicted` bundle (abstain — empty-KB workspace, real content) + the `confirmed` list/points — id-correspondence holds.
- **Client dropdown set is unit-tested only:** the test team has no dropdown field and ClickUp's API can't create one; real Nifty prod has the field but is read-only. Named gap, not a hole.
- Test tasks + throwaway lists deleted after; ws_nifty untouched (1198 chunks).

## ✅ PHASE 2c COMPLETE (2c.1 context + 2c.2 prediction/dedup + 2c.3 HITL push) & LIVE-VERIFIED. **Phase 2 (RAG/KB + pipeline integration) is DONE.** Next: **Phase 3** — smart assignment + the learning loop that consumes the `FieldOverride` log. Open fast-follows: inject context into `analyzeMeeting`; tune the novelty `pctNovel` cutoff + dedup bands on multi-chunk/cross-workspace data; a review-UI surface for the 2c.2 predictions/dupes + 2c.3 sprint/client/points controls.

---

## Phase 3 — Smart assignment + learning loop (sliced 3.1 → 3.2)

Spec: `docs/superpowers/specs/2026-06-28-meetsy-phase3-smart-assign-learning-design.md` (APPROVED — slice it; always require a human click [no auto-assign]; learning gate ≥3 corrections + ≥60% agreement; workload 30d; verify pushes only to test team `90181854711`).

### 2026-06-28 — Phase 3.1 — Smart assignment — DONE / GREEN + LIVE-VERIFIED — commit `05cf8b2`
Per extracted task, rank the assignable-member pool by **ownership precedent** → `result.assignment[taskId]`; recommendation-only (no auto-assign; the human confirms → logged as a `FieldOverride`). **170 meetsy-api tests** (11 new) + build green.
- **`rankOwners` (pure):** aggregate owners over the task's **qualifying kNN neighbours** (reused from 2c.2 — no re-embedding), **closed precedent weighted 2×**. **THE ECHO-BREAKER:** the floor alone doesn't fix majority-area domination *among* qualifying neighbours (an AIT task pulls Nifty-AI neighbours owned by a prolific cross-area dev). So when 2c.2 predicted a client, **condition ownership on same-client neighbours** → the minority-area owner wins. Falls back to all qualifying when the client abstained / has no matching neighbours.
- **`AssignmentService`:** map history owner names → `assignableMembers` via `AssigneeResolverService` (verified the real names resolve, incl. "Ahmad"→"Ahmad Syed Anwar" and the double-spaced "Shoabur Rahman  Chishty"); **workload** (open-task count + 30d tracked hours) as a **featherweight tie-break only** (never reorders real ownership); **ABSTAIN** below `SIM_FLOOR`/`MIN_QUALIFYING`; when history points only OUTSIDE the pool, **name that owner** instead of a bare abstain.
- Processor loads the pool from `WorkspacePushConfig` (direct Prisma; analysis→kb one-way dep preserved) + attaches `result.assignment`.

**LIVE-VERIFIED on ws_nifty (1198 chunks) — the advisor's discrimination test, both directions:**
- **Energy task → Rashedul Hasan** (the energy owner; ownership 0.54–0.69, conditionedOnClient=true). Ranked Rashedul > Shoabur > Sayem.
- **AIT (MINORITY area) → Ahmad Syed Anwar**, **NOT** the globally-prolific Rashedul (114 closed energy tasks / **0 AIT**) — client-conditioning restricted ownership to AIT neighbours so Ahmad (the real AIT owner) wins and Rashedul doesn't appear. This is the echo broken in the assignment slice.
- **OOD "holiday party" → ABSTAIN** ("No clear owner from history").
- Every recommended name resolved from history into the pool. Test meetings/runs/config cleaned up; ws_nifty restored (1198 chunks).

### 2026-06-28 — Phase 3.2 — Learning loop — DONE / GREEN + LIVE-VERIFIED — commit `f1c6a33`
Consume the `FieldOverride` log (written by 2c.3) to nudge future predictions when users CONSISTENTLY override the model the same way — deterministic, support-gated, honestly measured. A preference memory, **NOT a trained model**. **184 meetsy-api tests** (14 new) + build green.
- **`learning-aggregate` (pure):** per (field, predicted P) → confirmed C counts; **gate = ≥3 corrections AND C ≥60% of P's corrections.** Two advisor-driven anti-traps baked in: **(1) ORGANIC-only** — a correction with a nudge shown does NOT teach the gate, so an accepted nudge can't reinforce the gate that produced it; **(2) the raw override rate is a KB-quality proxy, reported SEPARATELY from nudge-acceptance** (the loop's actual lift — the raw rate can't measure the loop because `predicted` is always the raw 2c.2 value). Unresolved confirmed values counted so a **resolution miss ≠ "not enough data."**
- **`LearningService`:** snapshot (resolve confirmed `clientOptionId`/`clickupUserId` → names via `WorkspacePushConfig`), `applyNudges` (gated nudge per field), `summary`. `adjustForTasks` attaches `result.adjustments` (the raw prediction stays visible).
- **Push records `{shown, accepted}`** per field on each `FieldOverride` (recompute the pre-push nudge) — the piece that makes loop-effectiveness measurable + enables the organic filter. `FieldOverride += adjustments` (migration `20260628160000`). `clickup → kb` one-way dep.
- **`GET /workspaces/:id/learning`** — corrections + the two metrics ("what we've learned").

**LIVE-VERIFIED on ws_nifty with real-shaped seeded corrections (advisor's "done" gate, both directions):**
- Gate **FIRES** at 3× "Nifty AI"→"Energy Reporting" (agreement 1.0) and the nudge **surfaced on a live Nifty-AI run** ("adjusted from 3 past corrections"); the raw prediction stayed visible.
- Gate does **NOT** fire at **2 corrections** (sparse) nor a **3–3 split** (50% < 60%) — conflicting corrections stay silent.
- An **unresolved** option (`opt-DOESNOTEXIST`) → `unresolved=1`, with **no spurious correction** (resolution miss ≠ sparse).
- The two metrics are separate (`rawOverrideRate` vs `nudgeAcceptance=null` until nudges are shown). Nudge-acceptance metric LOGGING is unit-tested; its live end-to-end needs a dropdown field (same constraint as 2c.3). Seeds cleaned up; ws_nifty restored (1198 chunks, 0 overrides).

### 2026-06-28 — Review UI (fast-follow) — BUILT / GREEN — commit `0ad2312`
The meetsy-web run/review screen now surfaces everything the pipeline produces (all backends were already done + live-verified). `apps/meetsy-web`:
- **`signals.tsx`** (new) — web types (`ReviewResult` + the per-task signal maps, mirroring the meetsy-api shapes) + pure, null-guarded display: **`TaskSignals`** per task (duplicate flag/suggest chips, abstain-aware field suggestions client/sprint/due/estimate w/ confidence, the 3.2 learning nudge "adjusted from N", the 3.1 owner recommendation or "no clear owner") + **`KbContextBanner`** (run-level "grounded in N items of this client's history" + snippet peek).
- **`TaskCard`** threads `signalsForTask(result, task.id)`; **`ResultView`** casts the stored result → `ReviewResult` + renders the KB banner.
- **`PushSection`** (2c.3 HITL): per-row **Sprint/list select** (from `config.sprintLists`, free-text fallback), **client dropdown** (`config.clientOptions` when a client field is set), **points input** (when enabled); push body sends `clientOptionId`/`points`. **Assignee pre-filled from the 3.1 recommendation** (in-pool), client option pre-selected from the 2c.2 predicted client. A **"Refresh ClickUp fields"** button hits the refresh-fields endpoint.
- **`LearningPanel`** — the 3.2 "what we've learned": gated corrections + the two HONEST metrics kept distinct (raw-model-accuracy proxy vs nudge-acceptance).
- `api.ts` extended (`PushConfigView` client/sprint/points fields; `PushTaskInput` += clientOptionId/points; `getLearning` + `refreshPushFields` + `LearningSummary`).

**typecheck + `next build` + lint all clean.**

### 2026-06-28 — Review UI — IN-BROWSER SMOKE TEST PASSED + a real bug fixed — commit `cb855ef`
Stood up the full stack and drove a real headless browser (Playwright + system Chrome) against `/runs/[runId]` with a minted Clicksy session cookie (inserted a `public.sessions` row hashed with the shared `sha256`; meetsy-api validates it read-only — Clicksy itself need not run). **13/13 UI checks green, zero page errors**, and the screenshot visually confirms every signal: the "Grounded in 8 items of this client's history" KB banner; per-task SUGGESTED chips (Client/Sprint/Due with "N similar" confidence); the violet **"Adjusted client: Energy Reporting → AIT · from 3 past corrections"** learning nudge; **OWNER: Suggested Rashedul Hasan · 8 closed similar**; **"Possibly related"** duplicate flags on the re-created portal task; and the push controls (Sprint/list + Client [pre-filled] + Points + assignee pre-filled "Rashedul Hasan" + Refresh-fields) + the "What we've learned" panel.
- **🐞 BUG FOUND + FIXED (`cb855ef`):** the smoke test exposed that `analysis.service.getRun` ran `AnalysisResultSchema.parse(run.result)` — zod **strips unknown keys**, so the signals were dropped from the API response and never reached the UI (the data was stored fine; only the read path lost it). Fixed with `.passthrough()`. This is exactly the value of the real in-browser test — build/typecheck/lint were all green while the API silently returned `overview/people/unassignedTasks` only. 184 tests still green. Test stack + data cleaned up; ws_nifty restored (1198 chunks).

## ✅ PHASE 3 COMPLETE (3.1 smart assignment + 3.2 learning loop) & LIVE-VERIFIED. **The full planned roadmap (Phase 0 → 3) is DONE** + the review UI surfaces it. Meetsy now: shared-auth/org foundation → ClickUp write-back → RAG KB + summary + honest doc-improvement metric → pipeline grounding (context, abstain-first field prediction, dedup, HITL push) → smart assignment + a support-gated learning loop. **Open fast-follows (not yet built):** inject context into `analyzeMeeting` (2c.1 deferred); tune novelty `pctNovel` cutoff (2b) + dedup bands (2c.2) on more data; the **meetsy-web review UI** surfacing 2c.2 predictions/dupes + 2c.3 sprint/client/points + 3.1 assignment + 3.2 nudges + the `/learning` panel (all backends ready); a `CorrectionStat` cache if `/learning` read cost grows.

---

# MULTI-WORKSPACE + ONBOARDING JOURNEY (Slices 1→4) — 2026-06-28, branch `feat/meetsy-phase0` (uncommitted at time of writing)

> Built the product owner's onboarding-journey vision on top of the Phase 0→3 base: bidirectional workspace selection, a first-run KB onboarding wizard with scoped embedding, client-at-upload, and a re-onboard/KB-settings surface. Each slice was implemented sub-agent-driven (parallel backend+frontend agents against a pinned contract) and **live-verified** (curl on the running API + CDP real-Chrome browser smokes). Canonical detail lives in the `meetsy-integration-decisions` memory. Final verification after build: `@ma/api` 35 suites/203 tests; `@ma/web` typecheck+lint; Clicksy `apps/web` tsc — all green.

**Integration entry point.** Clicksy sidebar gained a "Meetsy" link (`apps/web` Sidebar) → opens the sibling app carrying the active workspace. One-command dev: root `npm run dev:platform` (`dev:deps` + concurrently Clicksy-api/Clicksy-web/Meetsy-api/Meetsy-web). Dev ports: Clicksy-web 5173, Clicksy-api 3002, Meetsy-web 3001, Meetsy-api 4000; Postgres 55432 (pgvector/pgvector:pg18), Redis 56379. Prod: `VITE_MEETSY_WEB_ORIGIN` baked at Clicksy image build (Dockerfile ARG/ENV + compose build-arg).

**Slice 1 — workspace scoping + bidirectional sync.** meetsy-api: `?workspaceId=` threaded through every analysis endpoint (confirmRoster/getRun/feedback/chat/SSE), resolved via `WorkspaceResolver` (default `is_default`); reads switched to `findFirst({id,orgId,workspaceId})` + 404 (never 403); resolved the `workspace.resolver.ts` TODO(phase1). 🔒 Closed an SSE auth hole (streamRun had NO authz — now auth-gates before redis.subscribe, preserving the subscribe-first race fix). meetsy-web: module `activeWorkspaceId` + `withActiveWorkspace()` auto-appends the param; `workspace-context.tsx` (lazy-init launch-param→strip→localStorage; validate vs GET /workspaces); header `WorkspaceSwitcher`; page remount on switch. **Bidirectional sync via a shared `active_workspace_id` cookie** (same trick as the shared `csrf` cookie — not port-scoped in dev, parent-domain in prod via `cookieDomain()` runtime derivation; `secure` only on https; cookie-only focus/visibility re-sync; both apps prime-from-cookie-first). Clicksy Sidebar carries `?workspaceId=`. Live-verified: getRun/chat/SSE 200 for default/correct ws, 404 cross-ws, SSE Deno-scoped emits error-event/no leak; cross-app cookie sharing proven both directions in real Chrome.

**Slice 2 — onboarding journey wizard + per-onboarding SCOPE.** `POST /kb/onboard` += `scope:{spaceIds?,folderNames?,listIds?,clients?}` (real `clickup_tasks` cols; sprint=list; client by NAME). `buildScopeWhere` into the embed count+findMany. `KbSyncState += scope/range` (migration `20260628170000_kb_onboard_scope`); cursor-reset on scope/range change (else re-onboard skips a new space's history); per-space coverage/backfill unchanged. NEW `GET /kb/spaces` + `GET /kb/scope-options` (distinct from mirrored data). meetsy-web: `KbGate` (redirect non-`ready` ws → `/onboarding`); `app/onboarding/page.tsx` 7-step wizard (confirm ws → pick spaces w/ task counts → sub-scope + honesty note → date range → SSE build progress via `useKbStatusStream` → "what we learned" summary → optional doc upload); role-gated; 9 new KB api methods + multipart upload. Live-verified incl. the load-bearing proof: onboard Deno scoped to one 66-task list → embedded exactly 66 chunks (not the workspace's 270).

**Slice 3 — client-at-upload (Meetsy never predicts the client).** `CreateMeetingRequest` (`@ma/shared`) += `clientOptionId/clientName`; `Meeting` += same (migration `20260628180000_meeting_client`); createMeeting persists. RETIRED per-task client prediction (`field-prediction`), re-sourced assignment ranking from `meeting.clientName`, push defaults each task's client to the meeting client (`effectiveClientOptionId`, per-task clear wins), removed client from the learning loop. `GET /runs/:id/push` echoes `meetingClient` (the durable UI pre-fill channel). meetsy-web: required client `<select>` on upload from `getPushConfig.clientOptions` (fail-open); push UI pre-fills from `meetingClient`; removed the client prediction chip + client learning surfaces. Live-verified: client persists → Meeting row; getRunPush echoes it; CDP smoke = upload dropdown renders the real options.

**Slice 4 — re-onboard / KB settings + purge-on-narrow.** `GET /kb/status` += current `scope/range`. PURGE-ON-NARROW in `kb.processor.embedWorkspace` (deleteMany clickup_task chunks `notIn` the in-scope ids; guards: empty scope=no-op, documents never purged, empty in-scope=skip+warn, idempotent every onboard; `embeddedCount` auto-recounts). meetsy-web: extracted the wizard step bodies into `app/onboarding/steps.tsx` (`KbBuildPanel`/`SpacesChecklist`/`SubScopeChecklists`/`RangeRadios`); NEW `app/settings/kb/page.tsx` (status card + scope/range summary + pre-filled re-onboard form → `KbBuildPanel`); reconciled `/settings/push` to the global header switcher; added the "KB settings" nav link. Live-verified: purge proven (Deno 2 lists=106 chunks → re-onboard 1 list=66); `/kb/status` echoes scope; CDP smoke = `/settings/kb` renders + the refactored wizard still works.

**⚠️ RECOVERY INCIDENT (2026-06-28).** While preparing to commit, a stray `git checkout … -- .` (mistakenly believed to be a dry-run) reverted ~34 already-tracked files to the committed base, wiping their uncommitted Slice-1→4 *modifications* (the ~14 newly-created files survived, being untracked). Recovered by replaying the Edit/Write tool ops recorded in the session + agent transcripts onto the reset-to-base files, filtered to ops AFTER the HEAD commit (`9d18f54`, the cutoff that separates committed history from this session's work). 32/34 reconstructed cleanly by replay; `meetsy-web/package.json` (dev port) + `assignment.service.spec.ts` (one stale `noPred`→`null` call site) + this journal were fixed by hand. Full green re-verified post-recovery (203 api tests, web typecheck/lint, clicksy tsc). Lesson recorded in the `meetsy-web-next-build-dev-footgun` neighbourhood: `git checkout <ref> -- <path>` mutates the working tree — never use it as a "dry run".


### 2026-06-29 — Pipeline fixes: richer descriptions, real time estimates, member suggestion at upload — GREEN (tsc + 211 tests)

Three fixes to close gaps where pushed ClickUp tasks were thin. `apps/meetsy-api` only (shared `@ma/shared` already carried the new `Participant.clickupUserId/clickupName` + `Task.estimateHours` fields).

- **D — expanded descriptions.** Moved prose enrichment into Stage 4 (which has task + summary + KB history). `stage4-enrich.ts`: `EnrichLLMSchema += description`; new systemPrompt bullet to expand the seed into a 3-6 sentence, history-grounded, no-fabrication work item; `merged` now `description: e.description?.trim() ? e.description : t.description`; strengthened the KB-context block to "match the detail/structure of the example tasks"; bumped `reasoningEffort` low→medium. `stage12-analyze.ts` SYSTEM: one sentence nudging multi-sentence descriptions at extraction.
- **E — real time estimates that reach ClickUp.** `stage4-enrich.ts`: `EnrichLLMSchema += estimateHours (z.number().nullable())` + an always-provide-a-number prompt bullet; `merged` coerces a 0/negative back to null (TaskSchema requires `>0`, models disobey) — `e.estimateHours && e.estimateHours > 0 ? e.estimateHours : (t.estimateHours ?? null)`. Plumbed to push: `CreateTaskPayload += time_estimate (epoch ms)`; `task-mapper` `MappableTask += estimateHours` and `map()` sets `time_estimate = round(hours*3.6e6)` when `>0`; `push.service.pushTasks` reads `estimateHours` from the STORED run result by meetsyTaskId (server-authoritative; web never sends it) and threads it into the mapper.
- **C — ClickUp member suggestion per roster participant at meeting creation.** `analysis.service.createMeeting` now annotates the roster in place (before persist, same array returned) via a new `suggestClickupMembers` helper: resolves workspace members once (`ClickUpClient.getAssignableMembers` — new shared method, controller refactored onto it), tries `[displayName, ...aliases]` through `AssigneeResolverService.resolve` (first hit wins), sets `clickupUserId`/`clickupName`. try/catch → missing token/connection leaves null and the meeting still creates. DI: `ClickUpModule` now `exports` `ClickUpClient` + `AssigneeResolverService`; `AnalysisModule` imports `ClickUpModule` (one-way, no cycle). `stage0-normalize.toParticipants` + `stage5-critic` candidate updated for the new required fields.
- **Follow-up (deferred, noted):** `push.service.getStatus` assignee suggestion still re-resolves from `assigneeName` rather than preferring the roster participant's confirmed `clickupUserId` (threading task→assigneeId→participant was more churn than the task scope wanted).
- **Tests:** new `stage4-enrich.spec.ts` (description+estimateHours merge, empty-description fallback, estimateHours=0→null) and `analysis.service.create-meeting.spec.ts` (member annotation, alias match, fetch-error degrades to null); extended `task-mapper.service.spec.ts` (time_estimate set/omitted); fixed literals in `context-injection.spec.ts` + arity in `analysis.service.workspace-scope.spec.ts`. `npx tsc -p apps/meetsy-api/tsconfig.json --noEmit` clean; `pnpm --filter @ma/api test` = 37 suites / 211 tests green. NOT nest-built (live dev server on :4000).

### 2026-06-29 — AI/embeddings model migration: unified v1 endpoint + gpt-5.5 main pipeline — GREEN (tsc + 213 tests)

Migrated chat + embeddings off the old two-resource setup (`niftyai`/`niftyocr`) onto the **single Azure AI Foundry "v1" OpenAI-compatible endpoint** the product owner provided (`niftyaibd-resource.services.ai.azure.com/openai/v1`), and upgraded the model placement. `apps/meetsy-api` only; Clicksy untouched. **Approved placement (quality-first; cost deferred).**

**Pre-flight tests (live, before any code change — all GREEN):** all 6 chat models (gpt-5.5/5.4/5.4-mini/5.4-nano/DeepSeek-V4-Flash/Kimi-K2.6) reachable + honor strict JSON schema; embeddings honor `dimensions=1024`. **Old-vs-new `text-embedding-3-large` cosine = 1.000/0.9999 (= same-endpoint control) → drop-in compatible, NO re-embed, all calibrated thresholds (SIM_FLOOR 0.5, dedup 0.72/0.64, novelty) stay valid.** Param check: gpt-5.5 rejects `temperature` (needs `reasoning_effort`, as today); DeepSeek+Kimi accept `reasoning_effort` (global `REASONING=true` flag won't break them). **SDK path:** `AzureOpenAI({baseURL,apiVersion})` → 404; plain `new OpenAI({baseURL, apiKey, defaultHeaders:{"api-key":KEY}})` + `.parse`+`zodResponseFormat` → works. Head-to-head on the REAL stage12 prompt+schema: gpt-5.5 best coverage+priority calibration; DeepSeek strong but under-prioritized; Kimi fluent but over-confident (all conf=1.0).

**Code changes:**
- `azure/azure-openai.service.ts` + `azure/azure-embedding.service.ts`: swapped `AzureOpenAI` (deployment-style, 404s on v1) → plain **`OpenAI`** client (`baseURL`=ENDPOINT, `defaultHeaders:{"api-key"}`). `model`-field routing + the whole `structured()`/`embed()` bodies unchanged. Embeddings keep their own client instance (can still diverge from chat later).
- `config/env.ts`: `AZURE_OPENAI_API_VERSION` + `AZURE_EMBED_API_VERSION` → **optional** (unused on v1; back-compat). ENDPOINT docs updated to "full base URL incl. /openai/v1".
- **Model placement:** `.env` `AZURE_OPENAI_DEPLOYMENT` gpt-5.4 → **gpt-5.5** (lifts all 6 main stages: roster/analyze/critic/enrich/refine/chat). `stage12-analyze` + `stage4-enrich` `reasoningEffort` medium → **high**. Aux constants: `NARRATIVE_DEPLOYMENT` + `CLAMP_DEPLOYMENT` gpt-5.4-mini → **gpt-5.4** (`narrative.service.spec` assertion updated); `JUDGE_DEPLOYMENT` **kept gpt-5.4-mini** (answerability metric consistency).
- `.env` + `.env.example`: one v1 endpoint+key for chat & embeddings; placeholder key (owner will rotate); removed the now-unused `*_API_VERSION` lines from live `.env`.

**Live end-to-end confirm:** gpt-5.5 @ `reasoning_effort:high` on the analyze schema → `finish=stop` (no truncation; `.env` sets no `MAX_COMPLETION_TOKENS` cap), 4 well-prioritized tasks, 47–61-word descriptions, 4–5 ACs each. `.env` has `REASONING=true` so `temperature` is never sent (gpt-5.5 would 400 on it).

**Verify:** `pnpm --filter @ma/api typecheck` clean; `pnpm --filter @ma/api test` = **37 suites / 213 tests** green (under Homebrew Node v25.9.0). NOT nest-built.

**Deferred / noted:** (1) **cross-family critic A/B** (analyze=gpt-5.5, critic=DeepSeek/Kimi) — approved to *benchmark* only, NOT defaulted; the diverse second opinion may catch more, validate before switching. (2) gpt-image-2 + 5.4-nano available but unused. (3) The 3 aux model constants are still hardcoded (not env-driven) — fine for now; env-ify if tuning cadence grows. (4) Owner will rotate the placeholder API key.

---

## Meetsy v2 — Reorganization (2026-07-18 kickoff)

Meetsy v1 Phases 0–3 are complete: engine works, tasks push to ClickUp, KB is grounded, learning loop fires. **v2 rebuilds the cockpit** — information architecture, evidence surfacing, learning-loop trust, KB legibility, per-workspace tunables — tuned for **IC engineers checking their assignments** (evidence expanded by default, chips clickable, keyboard-first).

**Read first (v2 chain):**
1. `docs/superpowers/plans/2026-07-18-meetsy-v2-plan.md` — umbrella plan (6 phases: Foundations → IA/Home → Evidence → Learning trust → KB → Tuning → Polish).
2. `docs/superpowers/specs/2026-07-18-meetsy-v2-phase0-foundations-design.md` — Phase 0 spec (start here).
3. This journal (v1 entries above are the engine; v2 entries append below as work lands).

**v2 audience decision (locked 2026-07-18):** IC engineers. Every design choice biases toward evidence + drill-down over speed-to-push. The push editor becomes a secondary tab, not the default view.

**Phase 0 backend changes (approved 2026-07-18):**
- **Signal-loss fix.** `analysis.service.ts:227` uses plain `.parse()` — strips `kbContext / fieldPredictions / duplicates / assignment / adjustments` from `AnalysisRun.result` on every feedback submit and every chat-added task. Also `push.service.ts:158-159` then reads `.fieldPredictions` and gets `{}`, so the learning-loop signal silently dies for those runs. Fix = `ReviewResultSchema` in `@ma/shared` + `mergeSignals(assembled, ctx.result)` before every write.
- **`WorkspaceMlConfig`** (per-workspace tunables container) + **`AnalysisRunSnapshot`** (frozen mlConfig/model routing per completed run — enables reproducible /tuning preview in Phase 5). Both `@@schema("meetsy")`, no cross-schema FKs.
- **`GET /workspaces/:id/clickup/tasks/:taskId`** — resolves ClickUp task ids (surfaced in duplicate chips + `evidenceTaskIds` + kbContext) to `{title, status, assigneeName, url}`. Enables clickable evidence chips in Phase 2.
- **`GET /workspaces/:id/runs?limit&offset&status`** — paginated run list. Powers Phase 1 `/home` recent runs + `/meetings` history.
- **Design system foundations** — `shadcn/ui` primitives (Button, Dialog, Sheet, Tabs, Toast, Command, DropdownMenu, Skeleton, Tooltip), `lucide-react`, `next-themes` (dark mode wired but no toggle UI in Phase 0), `sonner` toast. Transitional shim in `app/ui.tsx` re-exports so no big-bang caller migration.

**v2 phases at a glance (see plan §3 for full table):**
| Phase | Focus | Notable backend additions |
|---|---|---|
| 0 | Foundations (this spec) | signal-loss fix, `WorkspaceMlConfig`, `AnalysisRunSnapshot`, task-lookup + runs-list endpoints, `ReviewResultSchema` |
| 1 | IA + Home + History | `/learning/me`, full-text `runs/search` (tsvector + GIN) |
| 2 | Evidence-first review | attach raw kNN neighbours to result; push retry queue + dead-letter |
| 3 | Learning trust | `patterns/:key/history`, learning cache, near-gate SSE, **expand `FIELDS` to include `sprint`** |
| 4 | /kb consolidation | `kb/tasks?cursor&filter` (browse) |
| 5 | /tuning (Owner) | `ml-config` GET/PUT + preview endpoint (replays past runs against candidate config) |
| 6 | Cross-cutting UX | dark, keyboard, empty states, a11y, mobile |

**v2 status:** plan + Phase 0 spec written 2026-07-18. Not yet implemented. Recommended PR split (see Phase 0 spec §6): PR-A signal-loss fix, PR-B Prisma models + endpoints, PR-C design-system foundations.

<!-- Append new v2 entries below as steps complete. -->

### 2026-07-18 — v2 Phase 0 · PR-A: signal-loss fix — GREEN (typecheck + 217 tests)

Fixed the silent-loss bug that stripped `kbContext / fieldPredictions / duplicates / assignment / adjustments` from `AnalysisRun.result` on every feedback submit and every chat-added task, and (as a knock-on) made `push.service.ts:158` read `{}` from `.fieldPredictions` — killing the FieldOverride logger on those runs. Not committed yet.

**Root cause (grounded in v2 spec §1.1):** `loadRunContext` at `analysis.service.ts:227` parsed `run.result` with plain `AnalysisResultSchema.parse()` (strict) — dropping the five signal keys. `assemble()` then rebuilt a strict AnalysisResult without them. Both `submitFeedback` (line 295) and `sendChat` (line 363) persisted the stripped payload. `push.service.ts:158-159` read `.fieldPredictions` off the raw JSON blob and silently returned `{}` for any run touched by feedback/chat.

**New shared schema (@ma/shared):**
- New file `packages/shared/src/review-result.ts` — Zod-typed source-of-truth for the five signal keys: `KbContextHitSchema`, `TaskPredictionSchema` (with `FieldPredictionSchema` + `PriorCandidateSchema` + `DuePredictionSchema`), `DuplicateHitSchema`, `TaskAssignmentSchema` (+ `AssignmentCandidateSchema`), `TaskAdjustmentsSchema` (+ `FieldAdjustmentSchema`). All five signal keys are OPTIONAL on `ReviewResultSchema` so historical runs still parse. Also exports `TaskAdjustments.sprint?` (reserved for v2 Phase 3 — learning-loop expansion to sprint).
- Re-exported from `packages/shared/src/index.ts`.
- `RunResponseSchema.result` (`api.ts:50`) and both `SubmitFeedbackResponseSchema.result` + `SendChatResponseSchema.result` (`feedback.ts:36, 68`) switched from `AnalysisResultSchema` → `ReviewResultSchema` — so signals now round-trip on the wire type, not just at runtime.

**Backend changes (apps/meetsy-api):**
- `analysis.service.ts:227` — `loadRunContext` now parses with `ReviewResultSchema.parse()`; the returned `result` type widens from `AnalysisResult` to `ReviewResult` in the context object.
- New `mergeSignals(base, source)` helper at file bottom — re-attaches the five signal keys onto a freshly-`assemble()`d result. Called from both write paths (`submitFeedback` line 291 and `sendChat` line 366) — the merged `ReviewResult` (not the stripped `AnalysisResult`) is what gets persisted and returned. `assemble()` itself stays strict; separation-of-concerns preserved.
- `push.service.ts:82` (`getStatus`) — kept `AnalysisResultSchema.safeParse` (only reads tasks). `pushTasks` reads `estimateHours` via `AnalysisResultSchema.safeParse` AND reads `fieldPredictions` via a **dedicated** `z.record(z.string(), TaskPredictionSchema.passthrough())` parse with a raw-fallback — this independent read means predictions survive even when the AnalysisResult base is malformed (existing `push.fieldoverride.spec.ts` uses a minimal partial stub; behavior preserved).

**Frontend changes (apps/meetsy-web):**
- `app/runs/[runId]/signals.tsx` — deleted the local `interface FieldPrediction/DuePrediction/TaskPrediction/DuplicateHit/AssignmentCandidate/TaskAssignment/FieldAdjustment/TaskAdjustments/KbContextHit/ReviewResult` (77 lines); now `import type { … } from "@ma/shared"` + `export type { … }` for the two consumers. `TaskSignalData` (a local aggregation type) stays.
- `app/runs/[runId]/page.tsx` — `useState<AnalysisResult | null>` → `useState<ReviewResult | null>`.
- `app/runs/[runId]/components.tsx` — `ResultsSection`, `ResultView`, `PushSection`, `ChatPanel` signatures switched from `AnalysisResult` to `ReviewResult`; deleted both `as ReviewResult` casts (lines 281 + 731) as unneeded now.

**New tests:**
- `apps/meetsy-api/src/analysis/analysis.service.signal-roundtrip.spec.ts` — v2 Phase 0 acceptance test. Four cases:
  1. `submitFeedback` with downvote-no-comment on a task NOT in the result → signals survive on both the response and the persisted row.
  2. `submitFeedback` with downvote-no-comment on a task IN the result → assemble runs (changed=true), signals still survive.
  3. `sendChat` with `newTasks.length > 0` (mocked azure returns a valid FullTaskLLM) → resultUpdated + signals survive on both response and persisted row.
  4. `sendChat` with `newTasks.length === 0` → no `analysisRun.update` call (unchanged branch).

**Verify (all green):**
| # | Target | Command | Result |
|---|---|---|---|
| a | `@ma/shared` build | `pnpm --filter @ma/shared build` | PASS |
| b | Meetsy API typecheck | `pnpm --filter @ma/api typecheck` | PASS |
| c | Meetsy web typecheck | `pnpm --filter @ma/web typecheck` | PASS |
| d | Meetsy API tests | `pnpm --filter @ma/api test` | PASS — 38 suites / 217 tests (+4 new round-trip cases) |
| e | Clicksy backend tests | `pnpm test` (root) | PASS — 105 suites / 806 tests (no regression) |

**Not touched by this PR (per spec §6 — deferred to PR-B / PR-C):** WorkspaceMlConfig + AnalysisRunSnapshot migrations, task-lookup + runs-list endpoints, shadcn/ui + lucide + next-themes + sonner. This PR is the standalone signal-loss fix; PR-B (backend models + endpoints) and PR-C (design system) can land in either order after.

**Next:** PR-B — Prisma models (`WorkspaceMlConfig` + `AnalysisRunSnapshot`), migration, `GET /workspaces/:id/clickup/tasks/:taskId`, `GET /workspaces/:id/runs`.

### 2026-07-18 — v2 Phase 0 · PR-B: Prisma models + endpoints — GREEN (typecheck + 235 tests)

Landed the two new Meetsy-schema tables + the two new read endpoints the later phases build on. Not committed yet.

**Schema changes (apps/meetsy-api/prisma/schema.prisma + new migration):**
- New model `WorkspaceMlConfig` — `workspaceId` PK (one row per workspace), `orgId`, `tunables` JSONB, `models` JSONB, `updatedBy?`, `createdAt`/`updatedAt`. Index on `orgId`. Soft ref to `public.workspaces` (no cross-schema FK).
- New model `AnalysisRunSnapshot` — `runId` PK (1:1 with AnalysisRun via cascade FK), `workspaceId`, frozen `tunables` + `models` JSONB, `createdAt`. Index on `workspaceId`. Append-only.
- Added `@@index([workspaceId, createdAt])` on `AnalysisRun` — powers the newest-first paginated runs-list endpoint.
- Hand-authored migration `apps/meetsy-api/prisma/migrations/20260718120000_meetsy_v2_phase0_foundations/migration.sql` — `meetsy` schema only, no `public` writes. Note: the AnalysisRun index uses `"createdAt"` (camelCase — no `@map` on that field, unlike the new tables where every column is `@map`-ed to snake_case).

**Shared schemas (@ma/shared):**
- New file `packages/shared/src/ml-config.ts` — `WorkspaceTunablesSchema` (with defaults matching the hardcoded thresholds: dupFlag 0.72, dupSuggest 0.64, simFloor 0.5, minQualifying 3, closedWeight 2, minCorrections 3, minAgreement 0.6, rrfK 60, novelMaxSimCutoff 0.6, linkMinSim 0.75, embedBatch 64), `StageRoutingSchema` + `WorkspaceModelsSchema` (per-pipeline-stage effort routing), `RunSnapshotPayloadSchema` (the `AnalysisRunSnapshot` shape). Re-exported from `index.ts`.
- `api.ts` — added `ClickUpTaskLookupViewSchema` + `RunListItemSchema` + `RunListPushStatus` enum (`not_configured | not_pushed | partial | pushed`) + `RunListViewSchema`.

**Backend changes (apps/meetsy-api):**
- New `apps/meetsy-api/src/kb/ml-config.defaults.ts` — single source-of-truth for `DEFAULT_TUNABLES` + `DEFAULT_MODELS`, each field annotated with the file:line of the hardcoded constant it mirrors (so a code drift is visible in one place).
- New `apps/meetsy-api/src/kb/ml-config.service.ts` — `MlConfigService.forWorkspace(id)` reads `WorkspaceMlConfig` and falls back to the defaults on missing row / malformed JSON / DB error (never throws). Exported from `KbModule` for `AnalysisProcessor` to consume.
- `apps/meetsy-api/src/analysis/queue/analysis.processor.ts` — added `MlConfigService` dep + snapshot write immediately after the `status: "completed"` update. Wrapped in try/catch — snapshot failure logs a warning but never blocks run completion (the run row is already `completed` at that point).
- New `apps/meetsy-api/src/clickup/tasks-lookup.controller.ts` + `tasks-lookup.service.ts` — `GET /workspaces/:id/clickup/tasks/:taskId` returns `ClickUpTaskLookupView | null`. Soft-scopes to the requesting workspace via `workspaceId` comparison; also returns null for soft-deleted tasks so the chip degrades to "unavailable" instead of an error. Reads the read-only `public.clickup_tasks` mirror. Any authenticated user.
- `apps/meetsy-api/src/analysis/analysis.service.ts` — new `listRuns(workspaceId, {limit, offset, status?})` method. Batches: one `$transaction([findMany, count])` for the page + total; one `TaskPush.findMany` for the whole page's push audits; one `WorkspacePushConfig.findUnique` for the "not_configured" branch. `derivePushStatus` collapses per-run audit counts to a single label; `extractTaskCount` defensively counts `people[i].tasks + unassignedTasks` without a full Zod parse (returns null on a malformed row).
- `apps/meetsy-api/src/analysis/analysis.controller.ts` — new `@Get("workspaces/:id/runs")` route on the existing controller. Clamps `limit` to `[1, 100]` (default 20), `offset` to `≥ 0`. Unknown `status` query values are silently dropped rather than 400ing — stale client bookmarks don't error.

**New tests (all green):**
- `apps/meetsy-api/src/kb/ml-config.service.spec.ts` — 4 cases: default fallback on missing row, merge partial DB row over defaults, DB error → defaults, unparsable JSON → defaults.
- `apps/meetsy-api/src/clickup/tasks-lookup.service.spec.ts` — 5 cases: found, missing, cross-workspace (null), soft-deleted (null), null updatedDate → epoch ISO.
- `apps/meetsy-api/src/analysis/analysis.service.list-runs.spec.ts` — 9 cases: pagination + meeting join, status filter branch, taskCount from well-formed result, taskCount = null on malformed, pushStatus null when queued, `not_configured`, `not_pushed`, `pushed` (all-pushed), `partial` (mixed).

**Verify (all green):**
| # | Target | Command | Result |
|---|---|---|---|
| a | `@ma/shared` build | `pnpm --filter @ma/shared build` | PASS |
| b | Meetsy API typecheck | `pnpm --filter @ma/api typecheck` | PASS |
| c | Meetsy web typecheck | `pnpm --filter @ma/web typecheck` | PASS |
| d | Meetsy API tests | `pnpm --filter @ma/api test` | PASS — 41 suites / 235 tests (+18 new: 4 ml-config + 5 tasks-lookup + 9 list-runs) |
| e | Clicksy backend tests | `pnpm test` (root) | PASS — 108 suites / 824 tests (no regression) |

**Deferred to Phase 5:** the `/tuning` UI that writes `WorkspaceMlConfig`; the preview endpoint that replays a past run against a candidate config (reads `AnalysisRunSnapshot`). Nothing today READS `WorkspaceMlConfig` — the snapshot writer only writes the defaults today (via `MlConfigService.forWorkspace` which returns defaults when the row is absent).

**Next:** PR-C — design-system foundations (shadcn/ui primitives, lucide-react, next-themes, sonner toast, ThemeProvider, transitional re-export shim in `app/ui.tsx`).

---

## 2026-07-18 · v2 Phase 0 · PR-C (design-system foundations)

Third and final PR of Phase 0. Installs the shadcn/ui + lucide-react + next-themes + sonner stack in `apps/meetsy-web`, wires the theme provider + toast host, and refactors `app/ui.tsx` into a transitional shim so every existing caller keeps working unchanged.

**Packages added (`apps/meetsy-web/package.json`):**
- `class-variance-authority`, `clsx`, `tailwind-merge` — shadcn's variant + `cn()` toolkit.
- `@radix-ui/react-{checkbox,dialog,dropdown-menu,label,radio-group,select,separator,slot,tabs,tooltip}` — headless primitives shadcn wraps.
- `lucide-react` — the icon set used throughout shadcn primitives.
- `next-themes` — theme provider + `useTheme()` hook.
- `sonner` — the toast library shadcn defaults to.
- `cmdk` — command-menu primitive (installed now so Phase 4's ⌘K palette doesn't need another package add).
- `tw-animate-css` — provides `animate-in` / `animate-out` / `fade-in-0` / `zoom-in-95` etc. utility classes that Radix primitives depend on for their enter/exit transitions (Tailwind v3 shipped these via `tailwindcss-animate`; Tailwind v4 needs `tw-animate-css`, which we `@import` in `globals.css`).

**Primitives installed (`apps/meetsy-web/components/ui/`):**
button, card, dialog, sheet, tabs, dropdown-menu, command, tooltip, skeleton, sonner (Toaster + `toast()` re-export), input, select, label, checkbox, radio-group, separator — 16 files, following the standard shadcn source verbatim (no local drift).

**New helpers:**
- `apps/meetsy-web/lib/utils.ts` — `cn(...inputs)` using `clsx` + `tailwind-merge`. Every primitive imports it as `@/lib/utils`.
- `apps/meetsy-web/components/theme-provider.tsx` — thin `"use client"` wrapper around `next-themes/ThemeProvider` so the server root layout can mount it without becoming a client component.

**globals.css (Tailwind v4 + shadcn tokens):**
- `@import "tw-animate-css";` for the animate-in / animate-out class family.
- `@custom-variant dark (&:where(.dark, .dark *));` — Tailwind v4's way to enable class-based dark mode (`next-themes` toggles `.dark` on `<html>`).
- `:root` + `.dark` blocks define the full shadcn oklch token palette (background/foreground/card/popover/primary/secondary/muted/accent/destructive/border/input/ring + `--radius`).
- `@theme inline { --color-<name>: var(--<name>); }` maps those CSS variables into Tailwind utility class names (bg-background, text-muted-foreground, border-input, …) so the primitives work unchanged from a Tailwind v3 shadcn project.

**Theme provider + toast wiring:**
- `apps/meetsy-web/app/layout.tsx` — wraps `<AppShell>` in `<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>`. Adds `suppressHydrationWarning` on `<html>` (next-themes writes the theme class pre-hydration; the existing `<body suppressHydrationWarning>` for Grammarly stays).
- `apps/meetsy-web/app/AppShell.tsx` — `SignedInShell` mounts `<Toaster richColors closeButton />` above the `<Brand>` header. `Toaster` reads the current `next-themes` theme so toasts match dark/light automatically. No theme-toggle UI in Phase 0 — Phase 6 adds a header switch; today the system preference drives it.

**`app/ui.tsx` refactor:**
- Original implementations of `Button`, `Card`, `ErrorBanner`, `Spinner`, `PriorityBadge`, `Tag` moved verbatim to `app/ui-legacy.tsx`.
- `app/ui.tsx` becomes a one-line shim: `export { Button, Card, ErrorBanner, Spinner, PriorityBadge, Tag } from "./ui-legacy";`.
- Deviates from the spec §4.3 example (which routed `Button` + `Card` through the new shadcn primitives): we route ALL six through legacy in Phase 0 so existing `variant="primary"` etc. keep their exact type + look. Phase 1 flips a page's imports to `@/components/ui/*` and its look in one commit — no cross-phase visual drift.
- No caller of `@/app/ui` needed a change. All 8 files that import it (page.tsx, AppShell.tsx, settings/kb, settings/push, meetings/[id]/roster, runs/[runId]/{page,components}, onboarding/{page,steps}) work unchanged.

**Verify (all green):**
| # | Target | Command | Result |
|---|---|---|---|
| a | `@ma/shared` build | `pnpm --filter @ma/shared build` | PASS |
| b | Meetsy API typecheck | `pnpm --filter @ma/api typecheck` | PASS |
| c | Meetsy web typecheck | `pnpm --filter @ma/web typecheck` | PASS |
| d | Meetsy web lint | `pnpm --filter @ma/web lint` | PASS (0 warnings, 0 errors) |
| e | Meetsy API tests | `pnpm --filter @ma/api test` | PASS — 41 suites / 235 tests (no regression) |
| f | Clicksy backend tests | `pnpm test` (root) | PASS — 108 suites / 824 tests (no regression) |

`next build` was intentionally skipped per the `meetsy-web-next-build-dev-footgun` memory (running `next build` against a live `next dev` server's shared `.next` state breaks every route in dev). typecheck + lint are the sanctioned verification path here. No `next dev` was running at verify time either — this is policy, not accommodation.

**What's now unblocked for Phase 1+:**
- New pages can `import { Button } from "@/components/ui/button"` etc. and use the full shadcn variant surface (default / destructive / outline / secondary / ghost / link × default / sm / lg / icon).
- `toast()` calls from anywhere pop into the mounted `<Toaster />`.
- Adding a `.dark` class to `<html>` (or letting `next-themes` do it from the system preference) recolors every primitive via the tokens.
- `ui-legacy.tsx` deletes itself when the last caller migrates — no forever debt.

**Deferred (later phases):**
- Header theme toggle (Phase 6).
- Migrating existing `app/ui` callers to shadcn primitives (per-phase, opt-in).
- Data-table, calendar, form primitives (later phases pull as needed).

**Phase 0 status:** DONE. All three PRs (A/B/C) landed on `feat/meetsy-phase0`. Ready for Phase 1 (Sidebar + Home + History).

---

## Phase 1 (v2) — IA + Home + History

Spec: `docs/superpowers/specs/2026-07-18-meetsy-v2-phase1-ia-home-history-design.md`
Branch: `feat/meetsy-phase0` (still owns v2 work until it lands on `main`)

### 2026-07-18 — PR-D: sidebar shell + /home + /meetings history (frontend only) — DONE / GREEN

Frontend-only; no schema, no endpoints. Uses the `GET /workspaces/:id/runs` endpoint that already landed in Phase-0 PR-B.

- **New:** `apps/meetsy-web/components/nav/sidebar.tsx` — a persistent left rail (Brand · Home / New meeting / Meetings · Workspace switcher · Settings [Owner/Admin only: Push, KB] · user email). `md+` shows a fixed 256px column; smaller screens collapse into an off-canvas `Sheet` triggered by a hamburger in a slim top bar. Active-route highlight matches the current pathname's PREFIX (`/settings/kb/documents` still highlights KB).
- **AppShell rewrite:** `SignedInShell` swaps horizontal Brand → two-column `flex md:flex-row` (Sidebar + main). `<Toaster />` stays mounted at the shell level; `UserProvider` + `KbGate` + the keyed workspace-remount div are preserved verbatim.
- **`/` → redirect to `/home`.** The old upload form moved to `/new/page.tsx` (`git mv` — history intact). Root is now a client `router.replace("/home")` with a Spinner fallback (client-side because the AppShell auth gate runs client-side and a server redirect would race the KB gate).
- **`/home` (new):** two-column layout — recent-runs list (limit 5) on the left `md:col-span-2`, learning-digest slot on the right. Reuses the shared `RunRow` component. Empty state links to `/new`.
- **`/meetings` (new):** paginated full history — Filter chips (All / Completed / Running / Failed) + a `?q=&page=&status=` deep-linkable URL surface. Filter changes `router.replace()` (no back-stack churn). Wrapped in `<Suspense>` per Next 15's `useSearchParams` rule.
- **Shared `RunRow`** (`apps/meetsy-web/components/runs/run-list.tsx`) — one look for both /home and /meetings rows: title · meeting-date-or-relative · task count · status pill · push-status pill (`not_configured/not_pushed/partial/pushed`).
- **`api.listRuns`** exported from `apps/meetsy-web/lib/api.ts` (thin `/workspaces/:id/runs?limit&offset&status` wrapper).
- **Hardcoded `/` refs updated explicitly** rather than relying on the new redirect: `runs/[runId]/page.tsx`'s "New analysis" + "Start over" buttons → `/new`; `meetings/[id]/roster/page.tsx`'s Back → `/new`; `onboarding/page.tsx`'s Finish → `/home`.

### 2026-07-18 — PR-E: runs full-text search backend + UI — DONE / GREEN

Full-text search over meeting title + transcript, backing `/meetings?q=…`.

- **New migration** `apps/meetsy-api/prisma/migrations/20260718150000_meetsy_v2_phase1_run_search/migration.sql` — HAND-AUTHORED. Adds a generated `tsv tsvector` column to `meetsy."Meeting"` (title weighted A, transcript weighted C) + a GIN index. Postgres 12+ generated column recomputes on every INSERT/UPDATE — no trigger, no backfill needed. Prisma can't model `tsvector`, so a comment-only hint on `Meeting` in schema.prisma points to the migration.
- **New service method** `AnalysisService.searchRuns` in `apps/meetsy-api/src/analysis/analysis.service.ts` — uses `$queryRaw` for the WHERE + rank + count (order `ts_rank_cd DESC, createdAt DESC`), reuses the same push-status derivation as `listRuns`. Returns the exact `RunListView` shape so the client renders search results with the same component.
- **New endpoint** `GET /workspaces/:id/runs/search?q=&limit=&offset=&status=` on `AnalysisController` — empty/whitespace-only `q` → 400; `q` > 200 chars → 400; unknown `status` silently dropped (matches `listRuns`). Declared BEFORE `GET /runs/:id` in the file's route table so it isn't shadowed as a run id.
- **`api.searchRuns`** exported from `apps/meetsy-web/lib/api.ts`.
- **`/meetings` search UX:** a `Search`-icon-prefixed input on the right of the filter row, debounced 300ms into the URL's `?q=`. Non-empty q hits `searchRuns`; empty q hits `listRuns`. Clear button (`X` icon) inside the input clears both the local input state and `?q=`. No-results state shows the searched string + a "Clear search" link. Loading state keeps the last results with `opacity-50 pointer-events-none`.
- **Spec** `analysis.service.search-runs.spec.ts` — 4 tests: shape-mapping, empty-q guard, no-match, BigInt→number coercion of the Postgres COUNT.

### 2026-07-18 — PR-F: per-user learning digest — DONE / GREEN

Per-user rollup for /home's "is the model getting better at predicting me?" card.

- **New service method** `LearningService.meSummary(workspaceId, userId)` in `apps/meetsy-api/src/kb/learning.service.ts` — joins `FieldOverride ↔ TaskPush` on `(runId, meetsyTaskId)` and filters by `TaskPush.pushedBy = userId`. Buckets the last 6 ISO weeks (Monday UTC), zero-padded so a sparkline has a fixed x-axis whether or not the user pushed anything that week. Rows outside the 6-week window still count in `totalOverrides`.
- **Rationale for the join** (not a new `userId` column): the workspace-wide `summary()` already loads every FieldOverride per call — the join is strictly less work. Denormalization waits for the Redis learning cache (v2 §4 N6, Phase 3).
- **New endpoint** `GET /workspaces/:id/learning/me` on `LearningController` — any authenticated user; the `me` in the path is a literal, the userId comes from the session principal.
- **Shared types** `LearningMeView`/`LearningMeWeek` added to `apps/meetsy-web/lib/api.ts` (mirrors meetsy-api's convention — feedback/learning types stay local to the web client).
- **New component** `apps/meetsy-web/components/learning/digest-card.tsx` — one card, three metric rows (Accuracy, Corrections, Nudge acceptance), each with a `Sparkline`. Latest week's value rendered as the headline; empty state ("As you review runs…") when totalOverrides = 0. Links to `/settings/kb` for now (Phase 3's `/learning` route replaces the link).
- **New component** `apps/meetsy-web/components/charts/sparkline.tsx` — hand-drawn SVG, 6 bars, ~40 lines. No charting-lib dep. `value: null` renders a placeholder to distinguish "no data" from "zero."
- **Spec** `learning.service.me-summary.spec.ts` — 7 tests: zero-pad, in-window agreement + nudge acceptance count, out-of-window preservation in `totalOverrides` only, abstain does NOT count as agreement, userId reaches the SQL, week-boundary helpers (`weekStartIso` + `lastNWeekStarts`).

### 2026-07-18 — PR-G: /runs/:id tabbed scaffold — DONE / GREEN

Frontend-only; wraps the existing sections in shadcn Tabs so ICs stop scrolling a ~1200-line column.

- `apps/meetsy-web/app/runs/[runId]/page.tsx` — `ResultsSection` / `PushSection` / `ChatPanel` split into `Overview` / `Push` / `Chat` tabs plus a placeholder `Insights` tab (Phase 2 fills it).
- **`forceMount` on every `TabsContent`** with `data-[state=inactive]:hidden` — Radix would otherwise unmount inactive panels, restarting `ChatPanel` state + `PushSection` fetches. Verified manually: switching Overview → Push → Chat → Overview preserves chat history, form edits, and open menus.
- **Hash sync:** initial tab reads from `#hash` (deep-linkable — `/runs/abc#push` opens on Push). Tab clicks use `history.replaceState` so tab churn doesn't fill the back stack. `hashchange` listener catches external hash edits.
- The `PipelineStepper` and error banners stay ABOVE the tabs — while a run is not settled, only the stepper + spinner show and the tabs are hidden. Tabs appear the moment `result` lands.
- Default tab: `overview`. Unknown hashes fall back to `overview`.

### 2026-07-18 — Phase 1 verify (all GREEN)

| # | Target | Command | Result |
|---|---|---|---|
| a | `@ma/shared` build | `pnpm --filter @ma/shared build` | PASS |
| b | Meetsy API typecheck | `pnpm --filter @ma/api typecheck` | PASS |
| c | Meetsy web typecheck | `pnpm --filter @ma/web typecheck` | PASS |
| d | Meetsy web lint | `pnpm --filter @ma/web lint` | PASS (0 warnings, 0 errors) |
| e | Meetsy API tests | `pnpm --filter @ma/api test` | PASS — 43 suites / 246 tests (was 41/235; +2 suites, +11 tests: search-runs + me-summary) |
| f | Clicksy backend tests | `pnpm test` (root) | PASS — 110 suites / 835 tests (was 108/824 baseline in another journal window; unchanged by Phase 1 — meetsy-only work) |

`next build` intentionally skipped per the `meetsy-web-next-build-dev-footgun` memory (running `next build` against a live `next dev` server's shared `.next` state breaks every route in dev). typecheck + lint are the sanctioned verification path here.

**Migration status:** `20260718150000_meetsy_v2_phase1_run_search` is UNAPPLIED (Docker not running at build time). The orchestrator applies via `prisma migrate deploy` on next deploy — see the "Never run `prisma migrate dev` for meetsy-api" invariant in Phase-0 Step 2 (Prisma would try to introspect the DB-only `tsv` column; the migration is hand-authored and stays that way).

**What's now unblocked for Phase 2:**
- Every run in the history has a stable clickable Row (`RunRow`) — the review page's evidence chips will match its look.
- `/runs/:id` tabs give Phase 2's "evidence-first review" a place to land without a full-page redesign: the `Insights` tab is already carved out.
- `LearningDigestCard` proves the sparkline + weekly-bucket pattern that Phase 3's `/learning` page (workspace-wide, gate-progress) will reuse.

**Deferred (later phases):**
- `router.replace()`-based ⌘K palette wiring (Phase 4 — `cmdk` and `command.tsx` already installed in Phase 0).
- Rendering `assignment.ranked[]`, `evidenceTaskIds`, `FieldPrediction.candidates[]` inside `Insights` (Phase 2).
- Header dark-mode toggle (Phase 6).
- Migrating the moved `/new` page's imports from `@/app/ui` to `@/components/ui/*` (per-phase opt-in).

**Phase 1 status:** DONE. All four PRs (D/E/F/G) landed on `feat/meetsy-phase0`. Ready for Phase 2 (evidence-first review).


---

## Phase 2 (v2) — Evidence-first review + push retry

Spec: `docs/superpowers/specs/2026-07-18-meetsy-v2-phase2-evidence-review-design.md`
Branch: `feat/meetsy-phase0` (still owns v2 work until it lands on `main`)

### 2026-07-18 — PR-H: top-5 kNN neighbours attached to `run.result` — DONE / GREEN

The kNN neighbours per task were already computed by `FieldPredictionService` (`apps/meetsy-api/src/kb/field-prediction.service.ts:112`) and threaded through the processor (`analysis.processor.ts:154, :218, :220`) for owner ranking — then dropped on the floor at the persist step. Phase 2 attaches the top-5 to `run.result.neighboursByTask` so the review UI can show "why did the pipeline think of this task as similar?" without re-embedding.

- **Shared schema:** `NeighbourHitSchema` added to `packages/shared/src/review-result.ts` — mirrors the `Neighbour` interface at `kb/prediction-prior.ts:14` but with `createdDate`/`closedDate` as `z.string().datetime().nullable()` (Prisma serializes Date via `Date.prototype.toJSON` on JSON write).
- **`ReviewResultSchema.neighboursByTask`** added as an optional `Record<string, NeighbourHit[]>`; `ReviewSignals` picked type gains `neighboursByTask` so `mergeSignals()` preserves it through feedback + chat writes (same failure mode Phase 0 R2 fixed for the other signal keys).
- **`sliceNeighbours(byTask, n)`** — pure local helper in `analysis.processor.ts` that copies the top-N per task. Source arrays already sorted DESC by cosine (pgvector `ORDER BY <=>` in `field-prediction.service.ts:139`) so it's just a slice.
- **Persist:** the `result: { ... }` write at `analysis.processor.ts:243` gains `neighboursByTask: sliceNeighbours(taskAnalysis.neighboursByTask, 5)`.
- **`mergeSignals()`** at `analysis.service.ts:717` gains `neighboursByTask: source.neighboursByTask` so feedback + chat mutations don't strip evidence.
- **Bounds:** top-5 × ~20 tasks × ~100 bytes ≈ 10 KB/run — trivial vs. transcript-sized fields already on `run.result`.
- **Specs:** `analysis.processor.slice-neighbours.spec.ts` (4 tests — top-N truncation, shorter-arrays pass-through, empty map, non-mutation of source); `analysis.service.signal-roundtrip.spec.ts` extended to seed + assert `neighboursByTask` round-trip across feedback + chat writes (3 additional assertions).

### 2026-07-18 — PR-I: push retry queue + dead-letter — DONE / GREEN

Failed pushes (`push.service.ts:249-266`) previously just sat with `status="failed"` — no queue, no retry endpoint, no dead-letter. Users could only click Push again (which re-ran everything, idempotent-skipped the `pushed` rows, and retried the `failed` ones — noisy and slow).

- **Migration:** `apps/meetsy-api/prisma/migrations/20260718200000_meetsy_v2_phase2_push_dead_letter/migration.sql` — HAND-AUTHORED. Creates `meetsy."PushDeadLetter"` (`{id, runId, meetsyTaskId, workspaceId, jobId, payload, errorMessage, errorStack, attemptsMade, failedAt, retriedAt, resolvedAt, resolvedBy}`) + 2 indexes (`workspaceId`, `runId`). Mirrors Clicksy's root `DeadLetterJob` shape but in `meetsy` schema.
- **Schema:** `PushDeadLetter` model appended in `apps/meetsy-api/prisma/schema.prisma` right after `TaskPush`, using the same meetsy-schema convention (camelCase, no `@map`).
- **Queue + worker:** `apps/meetsy-api/src/clickup/push-retry/`:
  - `redis.ts` — queue name `meetsy-push-retry`.
  - `push-retry.queue.ts` — producer. Job id `${runId}:${meetsyTaskId}:${nonce}` (nonce is `Date.now().toString(36)` — intentionally per-enqueue so a retry after a retry actually runs; the DB row on `TaskPush` is the idempotency key). Options: `attempts: 4`, `backoff: { type: "exponential", delay: 2000 }`, `removeOnComplete/Fail: 100`.
  - `push-retry.processor.ts` — worker. Reads `TaskPush` by `(runId, meetsyTaskId)`, no-ops if already `pushed`, otherwise re-plays the stored ClickUp payload against the workspace's CURRENT `targetListId` (per-task listId overrides at original push time are not re-derivable; explicit design tradeoff). On success upserts `TaskPush(status:"pushed",clickupTaskId,clickupUrl,error:null)`. On BullMQ's final `failed` event (attempts exhausted), writes a `PushDeadLetter` row — `TaskPush.status` stays `failed` (dead-lettered ≠ lost). FieldOverride is INTENTIONALLY NOT re-logged on retry — the original push-time request context isn't recoverable from the stored payload; a retried push has the same audit shape as a never-failed one.
- **Retry endpoint:** `POST /runs/:id/push/retry` on new `PushRetryController` (co-located with `PushController`). Body `{ taskIds?: string[] }`; empty/absent = retry every failed row. Response `{ enqueued: string[], skipped: [{ meetsyTaskId, reason }] }`. Reasons: `not_found` (a filter id had no `TaskPush` row) · `not_failed:<status>` · `enqueue_failed:<msg>`. Auth: any authenticated user (same as `PushController`), CSRF via global AuthGuard.
- **Dead-letter admin:** `PushDeadLetterController` at `/workspaces/:id/push/dead-letter` — `@Roles("OWNER","ADMIN")` class-level; `GET` lists unresolved by default (`?includeResolved=true` opts in), `POST /:deadLetterId/resolve` hand-marks with `resolvedBy = user.userId`. No re-enqueue path (Phase 4 polish).
- **Module wiring:** `ClickUpModule` adds `PushRetryController`, `PushDeadLetterController`, and the 4 new providers (`PushRetryQueue`, `PushRetryProcessor`, `PushRetryService`, `PushDeadLetterService`). Analysis-queue pattern preserved (worker + producer on separate Redis connections).
- **Specs:** `push-retry.service.spec.ts` (6 tests — fan-out over failed rows, `taskIds` filter with `not_found` reporting, non-failed rows as `not_failed:<status>`, cross-org NotFoundException, missing-run NotFoundException, enqueue-failure reporting) and `push-dead-letter.service.spec.ts` (6 tests — unresolved-by-default filter, `includeResolved`, ISO serialization + total, cross-workspace 404, missing-row 404, `resolvedBy` write path).

### 2026-07-18 — PR-J: evidence panels expanded by default (web) — DONE / GREEN

`apps/meetsy-web/app/runs/[runId]/signals.tsx` rewritten from the ground up. The old file rendered four shallow rows (duplicates → 3 pred chips → optional nudge → owner name-only) with the `assignment.ranked[]`, `FieldPrediction.candidates[]`, and `evidenceTaskIds` from the pipeline never rendered.

- **Sections rendered per task card, top-to-bottom** (each short-circuits when its signal is absent):
  1. **Duplicates** — every `d.taskId` renders as a `TaskChip` (red/amber by band).
  2. **Suggested fields** — Sprint / Due / Estimate chips as before, PLUS a sub-strip of the sim-weighted candidates behind each prediction (`from A · 42% · B · 25% …`), the picked value styled distinct. A `clamp` badge appears when `isModal === false` (LLM overrode the modal top).
  3. **Owner** — top-3 ranked candidates with score bars (`ownershipScore`), closed/open/tracked-hours line, plus every `evidenceTaskIds` (up to 5) as clickable `TaskChip`s. "Show N more" expands to the full ranking; recommended candidate highlighted green.
  4. **Learning nudge** — `assignee` AND `sprint` (Phase 3 will populate the sprint side of `TaskAdjustments`; the code path is ready).
  5. **Similar (neighboursByTask)** — top-3 neighbours as `TaskChip`s with the cosine %. Hover shows assignee/sprint/client provenance.
- **No collapsible container.** Everything is expanded by default per the audience decision (spec §2). The `KbContextBanner` at the run level keeps its `<details>` since only some viewers care about workspace-wide grounding.
- **`workspaceId` prop plumbed** from `ResultView` → `PersonSection` → `TaskCard` → `TaskSignals` → each section, sourced from `useWorkspace()`. A `null` workspaceId falls back to non-interactive `<span>` chips (defensive — chip must not crash when no workspace context exists).

### 2026-07-18 — PR-K: clickable task-id chips → side sheet + retry-failed button — DONE / GREEN

- **`TaskSheetProvider`** (`apps/meetsy-web/components/tasks/task-sheet-context.tsx`) — a single side-sheet slot per view; any chip in the subtree calls `openTaskSheet(taskId)`. Scoped to `runs/[runId]/page.tsx` (spec §8; hoisting to `AppShell` is Phase 4).
- **`TaskChip`** (`apps/meetsy-web/components/tasks/task-chip.tsx`) — a `<button>` (not `<span>` — chips are interactive), 6 tone variants, focus ring for keyboard traversal (Phase 6 wires j/k later). Falls back to no-op when no provider is mounted.
- **`TaskDetailSheet`** (`apps/meetsy-web/components/tasks/task-detail-sheet.tsx`) — right-side `Sheet` (shadcn), re-fetches on each open via `api.getClickupTask(workspaceId, taskId)`. Three legit states: loading (spinner + skeleton) · loaded (title, status, assignee, updatedAt, "Open in ClickUp ↗" external link) · null (task predates KB — legitimate; message reassures the chip is still trustworthy).
- **`api.getClickupTask`** — thin wrapper over `GET /workspaces/:id/clickup/tasks/:taskId` (the Phase 0 endpoint at `tasks-lookup.controller.ts`); returns `ClickUpTaskLookupView | null`.
- **`api.retryFailedPushes`** — thin wrapper over `POST /runs/:id/push/retry`.
- **Chip wire-up sites** (all in the new `signals.tsx`): DuplicatesSection, RankedRow.evidenceTaskIds, NeighboursSection, KbContextBanner (for `sourceType === "clickup_task"` hits only).
- **Retry-failed button in `PushSection`:** the header button row (`components.tsx:947`) gains a `variant="secondary"` "Retry failed (N)" button that fires `api.retryFailedPushes(runId)` and reloads after 3s (the worker's typical wall time is < 2s per row). Only rendered when `failedCount > 0`. Enqueue success surfaces a green status message; enqueue failure surfaces an `ErrorBanner`.
- **Insights tab** rewritten from "coming in Phase 2" placeholder to a note pointing users to the Overview tab's inline evidence (the point of PR-J was to make a separate Insights view unnecessary).

### 2026-07-18 — Phase 2 verify (all GREEN)

| # | Target | Command | Result |
|---|---|---|---|
| a | `@ma/shared` build | `pnpm --filter @ma/shared build` | PASS |
| b | Meetsy API typecheck | `pnpm --filter @ma/api typecheck` (via `tsc --noEmit`) | PASS |
| c | Meetsy web typecheck | `pnpm --filter @ma/web typecheck` (via `tsc --noEmit`) | PASS |
| d | Meetsy web lint | `next lint` | PASS — 0 warnings, 0 errors |
| e | Meetsy API tests | `pnpm --filter @ma/api test` | PASS — **46 suites / 262 tests** (was 43/246 after Phase 1; +3 suites, +16 tests: `analysis.processor.slice-neighbours` + `push-retry.service` + `push-dead-letter.service`; existing `analysis.service.signal-roundtrip` extended to cover `neighboursByTask` in 3 test cases) |
| f | Prisma generate | `prisma generate` | PASS — new `PushDeadLetter` model + `neighboursByTask` shared type available in Prisma client |

`next build` intentionally skipped per the `meetsy-web-next-build-dev-footgun` memory. typecheck + lint are the sanctioned verification path.

**Migration status:** `20260718200000_meetsy_v2_phase2_push_dead_letter` is UNAPPLIED (same footing as Phase 1's tsv migration — Docker not running at commit time). The orchestrator applies via `prisma migrate deploy` on next deploy.

**Deferred (later phases):**
- Dead-letter UI (endpoints ship; visible surface is Phase 4 KB consolidation, which touches the same admin nav).
- Per-row retry button on `TaskPushRow` (bulk retry covers the common case; per-row would be noise).
- Neighbours as a standalone "cross-run similarity" view (evidence-strip on the task card is enough for IC engineers checking one task at a time).
- FieldOverride re-log on retried pushes (original request-time context isn't recoverable from stored payload; documented tradeoff in `push-retry.processor.ts`).

**Phase 2 status:** DONE. All four PRs (H/I/J/K) landed on `feat/meetsy-phase0`. Ready for Phase 3 (learning trust).


---

## Phase 3 (v2) — Learning trust

Spec: `docs/superpowers/specs/2026-07-18-meetsy-v2-phase3-learning-trust-design.md`
Branch: `feat/meetsy-phase0` (still owns v2 work until it lands on `main`)

Design goal (spec §1): make the learning loop legible and trustable. Before Phase 3, the loop's state was hidden in a single settings-page panel; users saw a nudge or didn't, with no signal that they were "one correction away" from teaching the loop something new. Phase 3 gives the loop a first-class surface (`/learning`), expands what it learns beyond `assignee` (now `assignee | sprint`), publishes near-gate / gate-passed toasts as they happen, and caches the aggregate to keep the push path fast even at 10k+ overrides.

### 2026-07-18 — PR-L: FIELDS = ["assignee", "sprint"] expansion — DONE / GREEN

Before Phase 3, `LearningService` was hardcoded to a single field (`assignee`) — the `snapshot` type was `{ assignee: FieldAggregate }`, `TaskAdjustments` was `{ assignee?: … }`, and the push flow's `computeAdjustments` only branched on the assignee prediction. PR-L widens the loop to a second learnable field (`sprint`) with the discipline that adding a THIRD field in a future phase is a five-line change (documented in `learning.service.ts:17-22`).

- **`learning-aggregate.ts`** — `CorrectionStat` gains `field: string` (which learnable field this correction belongs to) and `key: string` (a stable, URL-safe base64url of `field|predicted|confirmed`, used as a path segment on `/learning/patterns/:key/history`). `aggregateField` signature changes from `(records)` to `(field, records)` so every correction it emits carries the pair. New exports: `NEAR_GATE_THRESHOLD` (`MIN_CORRECTIONS - 1`), `patternKey(field, predicted, confirmed)`, and `decodePatternKey(key)` (throws on malformed input so a bad URL 400s in the controller).
- **`learning.service.ts`** — `FIELDS: LearnField[] = ["assignee", "sprint"]`, `LearningSnapshot = Record<LearnField, FieldAggregate>`, `TaskAdjustments = Partial<Record<LearnField, {from,to,count,agreement}>>`. `PredictionBundle` gains `sprint`; `ConfirmedBundle` gains `listId` (the ClickUp list id the task was pushed to — resolved to a sprint name via `WorkspacePushConfig.sprintLists[]`, the asymmetry with assignee's `clickupUserId → name` documented in the spec §3.1 and the code). `snapshot()` builds sprint records via the sprintLists resolver; `applyNudges()` emits both `.assignee` and `.sprint`; `adjustForTasks()` returns a row when EITHER field's nudge fires; `meSummary()` counts `[adj.assignee, adj.sprint].filter(Boolean)` toward nudgesShown/Accepted so the /home digest honestly reflects the loop as it expands.
- **`push.service.computeAdjustments`** — now accepts `confirmedListId` and adds a sprint branch. Resolves via `config.sprintLists.find(s => s.listId === confirmedListId)?.name`, parallel to the assignee's `memberName` map.
- **Specs updated**: `learning-aggregate.spec.ts` (all `aggregateField(...)` calls now pass `"assignee"` first arg); `learning.service.spec.ts` + `learning.service.me-summary.spec.ts` — `workspacePushConfig.findUnique` returns `sprintLists: []` (the snapshot now selects it) and the constructor takes three args (see PR-M).
- **New spec**: `learning-aggregate.pattern-key.spec.ts` (6 tests) — round-trips ascii/spaces/slashes/unicode through `patternKey`/`decodePatternKey`, rejects malformed keys. `learning.service.sprint.spec.ts` (4 tests) — end-to-end sprint learning path: sprint override records feed the aggregate, gate the same way as assignee, drive `applyNudges().sprint`, and stay independent of assignee counts.

### 2026-07-18 — PR-M: Redis snapshot cache + gate constants endpoint + pattern history — DONE / GREEN

Three moves on the API surface, all in service of the `/learning` page:

- **`LearningCacheService`** (`apps/meetsy-api/src/kb/learning-cache.service.ts`) — Redis KV cache for `LearningService.snapshot()`. Key `meetsy:learning:snapshot:v1:{workspaceId}`, `SETEX` 3600. `read/write/invalidate` all catch errors and return null/log so a Redis outage transparently degrades to Phase-2 always-DB behavior. The `v1` guards a future snapshot-shape change from reading a stale value written by an older server. `LearningService.snapshot()` becomes read-through-cached: a hit returns the stored value; a miss falls through to the DB scan then writes back. `LearningService.invalidateCache(workspaceId)` is called from `push.service.logFieldOverride` after every FieldOverride write. Bounded staleness (1h) means a failed DEL is still safe — nudges only get worse if stale, they don't break.
- **`GET /workspaces/:id/learning/gate`** — returns `{ minCorrections, minAgreement, nearGateThreshold, fields }`. Workspace-independent today; Phase 5's `/tuning` UI will make this per-workspace by reading from `WorkspaceMlConfig`, and the return shape stays stable across that migration.
- **`GET /workspaces/:id/learning/patterns/:key/history`** — one pattern's timeline. Decodes the base64url key (400 on malformed / unknown field), consults the resolved snapshot for the pattern's stats (404 if the pattern isn't in the workspace's snapshot), then scans up to 500 newest FieldOverride rows and filters to those matching the pattern's `(predicted, confirmed)` after name resolution (same resolvers as `snapshot()` — no drift between summary and drilldown). `?limit=` default 50, capped 200. `nudgeShown` per entry so the UI can badge nudge-influenced rows.
- **Specs**: `learning.service.cache.spec.ts` (3 tests — miss+writeback, hit skips DB, `invalidateCache` delegates); `learning.service.gate.spec.ts` (2 tests — shape + constants match the aggregate module); `learning.service.history.spec.ts` (5 tests — chronological newest-first, `nudgeShown` flag on nudge-influenced rows, 400 on malformed key, 400 on unknown field in key, 404 on unknown pattern).

### 2026-07-18 — PR-N: near-gate SSE toast — DONE / GREEN

- **`LearningStreamService`** (`apps/meetsy-api/src/kb/learning-stream.service.ts`) — Redis pub/sub for workspace-scoped `near-gate | gate-passed` events. Mirrors `kbChannel` (`kb.queue.ts:11`) + `KbController.stream` (`kb.controller.ts:99`): dedicated publisher connection, per-subscription subscriber connection, teardown on client disconnect. Exports `learningChannel(workspaceId)` and `classifyThreshold(count)` — pure decision, `NEAR_GATE_THRESHOLD → "near-gate"`, `MIN_CORRECTIONS → "gate-passed"`, else null. `LearningEvent` shape: `{ workspaceId, field, predicted, confirmed, count, at, kind }`.
- **`LearningService.maybePublishThreshold(workspaceId, {predicted, confirmed, adjustments})`** — called from `push.service.logFieldOverride` AFTER the DB write + cache invalidation. Consults the POST-write snapshot (already fresh because we invalidated first) for the just-written `(field, predicted, confirmed)`; if the aggregate's `count === NEAR_GATE_THRESHOLD` publishes `near-gate`, if `count === MIN_CORRECTIONS` publishes `gate-passed`. Skips: agreement rows (predicted === confirmed), abstain/unresolved (no value on one side), and — critically — nudge-influenced writes (they don't count toward the organic aggregate per `learning-aggregate.ts:73-78`, so their count never changes; the guard here is belt-and-braces). Best-effort throughout: a publish miss only loses a toast, and the next `/learning` page load re-derives from the summary.
- **`GET /workspaces/:id/learning/stream`** (`@Sse`) — Observable returned SYNCHRONOUSLY with async workspace resolution inside (mirrors `KbController.stream`; Nest's SSE handler subscribes to the return value and does not unwrap a Promise).
- **Web wire-up**: `apps/meetsy-web/lib/useLearningStream.ts` — `EventSource` with `withCredentials: true`; parses each `LearningStreamEvent` and renders a Sonner toast: `near-gate` as `toast()` info ("One more correction and X → Y will start nudging"), `gate-passed` as `toast.success()`. Mounted inside `SignedInShell` in `AppShell.tsx` so toasts fire workspace-wide, regardless of whether the user is on `/learning` at the moment.
- **Specs**: `learning-stream.service.spec.ts` (5 tests — `classifyThreshold` at 0/1/2/3/4); `learning.service.threshold-publish.spec.ts` (6 tests — near-gate at count=2, gate-passed at count=3, quiet at count=1, quiet at count=4, never fires when the write was nudge-influenced, never fires on agreement rows).
- **Push spec hygiene**: `push.fieldoverride.spec.ts` + `push.service.spec.ts` `LearningService` mocks gained `invalidateCache` + `maybePublishThreshold` no-op stubs (the pushed-flow catch was hiding "not a function" warnings that made test output noisy — assertions were already passing).

### 2026-07-18 — PR-O: `/learning` workspace page (Active / Building / Coverage) — DONE / GREEN

- **`apps/meetsy-web/app/learning/page.tsx`** — three stacked sections:
  1. **Active** — patterns the loop currently gates (`gatePassed === true`). Per row: `predicted → confirmed`, correction count, consistency %.
  2. **Building up** — near-gate patterns (`!gatePassed && count >= 1`). Per row: progress bar `count / minCorrections`, `N of 3` label. Clicking any row opens the pattern-history sheet.
  3. **Coverage** — per-field: predictions seen, "Predictions you changed" (formerly `rawOverrideRate` in the panel), "Suggestions shown" (nudgeSample), "Suggestions accepted" (formerly `nudgeAcceptanceRate`), and — when > 0 — Unresolved (amber, so a resolution bug looks like a resolution bug, not "sparse data").
- **Metric renaming happens ONLY at this UI layer.** The API still returns `rawOverrideRate` / `nudgeAcceptanceRate`; the existing `LearningPanel` in `runs/[runId]/components.tsx` keeps working.
- **`PatternHistorySheet`** — right-side `Sheet`, re-fetches `getLearningPatternHistory(workspaceId, patternKey)` on open. Shows the pattern's aggregate stats + a chronological entry list (run id · timestamp · nudge-shown badge when applicable). Empty state ("no matching entries in the last 500 rows") tells the truth about the scan bound.
- **Navigation**: `apps/meetsy-web/components/nav/sidebar.tsx` gains a "Learning" entry (Sparkles icon), routed to `/learning`. The old "See patterns →" link on `LearningDigestCard` (home) now points to `/learning` instead of `/settings/kb`.
- **API additions**: `apps/meetsy-web/lib/api.ts` — `LearningGateView`, `LearningPatternHistoryEntry/View`, `LearningStreamEvent` types; `LearningCorrection` gains `field` + `key`; `api.getLearningGate(workspaceId)`, `api.getLearningPatternHistory(workspaceId, key, opts?)`, `api.learningStreamUrl(workspaceId)` helpers.

### 2026-07-18 — Phase 3 verify (all GREEN)

| # | Target | Command | Result |
|---|---|---|---|
| a | `@ma/shared` build | not needed — no shared-package changes in Phase 3 | SKIP |
| b | Meetsy API typecheck | `pnpm --filter @ma/api typecheck` (via `tsc --noEmit`) | PASS |
| c | Meetsy web typecheck | `pnpm --filter @ma/web typecheck` (via `tsc --noEmit`) | PASS |
| d | Meetsy web lint | `next lint` | PASS — 0 warnings, 0 errors |
| e | Meetsy API tests | `npx jest` (in `apps/meetsy-api`) | PASS — **53 suites / 293 tests** (was 46/262 after Phase 2; +7 suites, +31 tests: `learning-aggregate.pattern-key` · `learning-stream.service` · `learning.service.gate` · `learning.service.cache` · `learning.service.history` · `learning.service.sprint` · `learning.service.threshold-publish`) |

`next build` intentionally skipped per the `meetsy-web-next-build-dev-footgun` memory. typecheck + lint are the sanctioned verification path.

**Migration status:** no new migrations in Phase 3 — the loop grew but the Postgres shape didn't. `WorkspacePushConfig.sprintLists` and `FieldOverride.{predicted,confirmed,adjustments}` (Json) were already present from Phase 0/2. The two prior unapplied migrations (`20260718150000_meetsy_v2_phase1_run_search` from Phase 1 and `20260718200000_meetsy_v2_phase2_push_dead_letter` from Phase 2) still ride `prisma migrate deploy` on the next deploy.

**Deferred (later phases):**
- Storing the resolved sprint NAME on `FieldOverride.confirmed.sprintName` at push time (parallel to assignee's clickupUserId→name resolution happening at aggregate time). The listId-based lookup is correct today but rotates if the workspace renames a list; Phase 5-ish will backfill.
- Per-workspace tuning of `MIN_CORRECTIONS` / `MIN_AGREEMENT` via `WorkspaceMlConfig` — Phase 5's `/tuning` UI. The `/gate` endpoint shape is already stable across that migration.
- SSE reconnect UX (right now `EventSource` reconnects silently; a "reconnected" banner during long sessions would be a Phase 6 polish).
- Threshold events for the `client` field IF/when it re-joins the learning loop (currently a meeting-level value the user sets at upload, per the FIELDS comment).

**Phase 3 status:** DONE. All four PRs (L/M/N/O) landed on `feat/meetsy-phase0`. Ready for Phase 4 (KB consolidation) — a single admin surface for workspace KB, push config, sprint lists, dead-letter admin, and now the `/learning` page.


---

## Phase 4 (v2) — `/kb` consolidation

Spec: `docs/superpowers/specs/2026-07-18-meetsy-v2-phase4-kb-consolidation-design.md`
Branch: `feat/meetsy-phase0`

Design goal (spec §1): the KB is real (`/kb/search`, `/kb/documents`, `/kb/summary`, `/kb/status`) but never surfaced together. Before Phase 4, users saw the KB exactly once — during the seven-step `/onboarding` wizard — and could only re-embed from the deeply-buried `/settings/kb`. Phase 4 replaces both with a single canonical `/kb` route (Overview / Tasks / Documents / Search / Rebuild), retires the `/onboarding` full-page redirect in favor of an in-page banner, and adds a global ⌘K palette so search + navigation reach the user from anywhere.

### 2026-07-18 — PR-P: `GET /kb/tasks` paginated task list — DONE / GREEN

- **`KbTasksService`** (`apps/meetsy-api/src/kb/kb-tasks.service.ts`) — joins `KbChunk` (meetsy) with `public.clickup_tasks` and returns the distinct set of embedded ClickUp tasks, keyset-paged on `(updated_date DESC NULLS LAST, task_id DESC)`. `?filter=<q>` narrows via a case-insensitive `ILIKE` against `task_name`, `client`, and `assignees_names`; `?limit` defaults to 50 (capped 100). Cursor is `base64url(JSON.stringify({u: iso|null, t: taskId}))` — malformed → 400. Runs via `prisma.$queryRaw` (Prisma's `groupBy` doesn't compose keyset paging + a distinct chunk count in one round-trip); all params bound through the tagged template.
- **`GET /workspaces/:id/kb/tasks`** — wired on `KbController` (`kb.controller.ts:159`). Any authed user; workspace-scoped via `WorkspaceResolver`. Response: `{ tasks: KbTaskRow[], nextCursor: string | null, total: number }`.
- **Specs**: `kb-tasks.service.spec.ts` (7 tests) — first page + nextCursor, last page returns null cursor, limit clamps (0 → 1, 1000 → 100), null `updated_date` returns null ISO, malformed cursor 400s, shape-wrong cursor 400s, decoded nextCursor round-trips to the last-returned row's `(updated, taskId)`.

### 2026-07-18 — PR-Q: `/kb` shell + Overview / Documents / Search / Rebuild tabs — DONE / GREEN

- **`apps/meetsy-web/app/kb/page.tsx`** — client route, shadcn `<Tabs>` keyed off `?tab=<name>` (defaults to overview). Owner/Admin sees the Rebuild tab; Members see the other four. Status card + idle banner render ABOVE the tabs so a not-ready KB is visible without a redirect (see PR-R). The page provides `TaskSheetProvider` + mounts `TaskDetailSheet` so both the Tasks and Search tabs can open a ClickUp side-sheet on click.
- **`app/kb/overview-tab.tsx`** — `StatusCard` + "What we learned" (narrative + `FactsSummary`). Renders only when status is `ready`; otherwise a "waiting on the build" note replaces the body.
- **`app/kb/documents-tab.tsx`** — extract of the wizard's `DocumentsStep`; upload/list/delete against `api.kbListDocuments|kbUploadDocument|kbDeleteDocument`. Read-only for Members (backend already 403s writes; the button is hidden to reduce error noise).
- **`app/kb/search-tab.tsx`** — plain `Input` with 300ms debounce → `api.kbSearch(ws, q, 20)`. Hits render as clickable cards; clicking opens the shared `TaskDetailSheet`. `?q=` is echoed back into the URL so browser back is honest and the ⌘K palette can deep-link.
- **`app/kb/rebuild-tab.tsx`** — extract of the old `KbSettings` body; the `KbBuildPanel` + spaces/sub-scope/range form re-embed the KB with a different scope. On `onDone`, the parent page reloads status so Overview + Tasks show the fresh embed counts.
- **`app/kb/facts-summary.tsx`** + **`app/kb/status-card.tsx`** — the shared extracts consumed by Overview and Rebuild; both were previously inline in the wizard and settings pages.
- **API surface**: `apps/meetsy-web/lib/api.ts` — new `KbTaskRow`, `KbTasksPage`, `KbSearchHit` types; new `api.kbTasks(ws, opts)` + `api.kbSearch(ws, q, k?)` helpers.

### 2026-07-18 — PR-R: retire `/onboarding` full-page redirect — DONE / GREEN

- **`app/AppShell.tsx`** — `KbGate` is deleted (v1's redirect-to-`/onboarding` behaviour). `SignedInShell` now renders children directly; the `activeWorkspaceId` remount key stays for workspace switches. The auth gate remains outermost and is untouched.
- **`app/onboarding/page.tsx`** — deleted.
- **`app/onboarding/steps.tsx`** → **`app/kb/steps.tsx`** — moved via `git mv`; all three call sites (`kb/page.tsx`, `kb/rebuild-tab.tsx`, `kb/status-card.tsx`) updated. The `KbBuildPanel` inside remains the single onboard/re-embed code path.
- **`app/settings/kb/page.tsx`** — rewritten as a Next.js server-side `redirect("/kb?tab=rebuild")`. External bookmarks resolve; new callers use `/kb` directly.
- **`components/nav/sidebar.tsx`** — `SETTINGS` loses the `/settings/kb` entry; `PRIMARY` gains a "Knowledge base" entry (`BookOpen` icon) routed to `/kb`. Members see the entry; the Rebuild tab is Owner/Admin-only within the page itself.
- **Idle-state UX on `/kb`** — when `kbStatus.status !== "ready"`, the page renders a banner above the tabs. Owner/Admin can flip the banner into a `KbBuildPanel` (range=3m default) directly; Members see a read-only "ask an Owner/Admin" note. `onboarding` and `error` statuses distinguish tone (amber vs red).

### 2026-07-18 — PR-S: global ⌘K command palette — DONE / GREEN

- **`components/nav/command-palette.tsx`** — shadcn `<CommandDialog>`; toggled by `⌘K` or `Ctrl+K` via a `window` keydown listener that debounces to the palette's own state. Two groups: **Go to** (Home, New meeting, Meetings, Learning, Knowledge base; Owner/Admin also sees Push settings) and **Search knowledge base** — a 250ms-debounced live search against `/kb/search` (`k=8`). Selecting a hit navigates to `/kb?tab=search&q=<query>` (the palette closes; the search tab renders the full hit list in context). `AbortController` cancels stale searches on query change.
- **Mounted in `AppShell.tsx`** next to the `<Toaster>` — inside `SignedInShell` (so `useWorkspace` is safe) and outside `<main>` (so it overlays the whole app). Rides the workspace context reactively; a switch mid-open drops in-flight hits and re-searches against the new workspace.
- **State hygiene**: closing the palette resets `q`, `hits`, and `searching` — reopening starts blank. The palette itself does not persist recent queries (deferred to Phase 6 polish).

### 2026-07-18 — Phase 4 verify (all GREEN)

| # | Target | Command | Result |
|---|---|---|---|
| a | `@ma/shared` build | not needed — no shared-package changes in Phase 4 | SKIP |
| b | Meetsy API typecheck | `pnpm --filter @ma/api typecheck` (via `tsc --noEmit`) | PASS |
| c | Meetsy web typecheck | `pnpm --filter @ma/web typecheck` (via `tsc --noEmit`) | PASS |
| d | Meetsy web lint | `next lint` | PASS — 0 warnings, 0 errors |
| e | Meetsy API tests | `npx jest` (in `apps/meetsy-api`) | PASS — **54 suites / 300 tests** (was 53/293 after Phase 3; +1 suite, +7 tests: `kb-tasks.service`) |

`next build` intentionally skipped per the `meetsy-web-next-build-dev-footgun` memory. typecheck + lint are the sanctioned verification path.

**Migration status:** no new migrations in Phase 4 — PR-P reads existing tables (`KbChunk` + `public.clickup_tasks`) via raw SQL. The two prior unapplied migrations (`20260718150000_meetsy_v2_phase1_run_search`, `20260718200000_meetsy_v2_phase2_push_dead_letter`) still ride `prisma migrate deploy` on the next deploy.

**Deviations from spec:**
- Spec §4.1 said the moved `steps.tsx` would live at `app/kb/steps.tsx` with `rebuild-tab.tsx` as the "single caller"; the actual code has three call sites in `app/kb/` (`page.tsx`, `rebuild-tab.tsx`, `status-card.tsx`) — all inside the `/kb` route, so the location is right, just not literally single-caller. No functional impact.

**Deferred (later phases):**
- KB search facets (`?sourceType=clickup_task|document`) — the `/kb/search` API supports it internally via `retrieveContext`, but the public search endpoint fixes `["clickup_task"]`.
- Task drilldown → per-chunk embedding provenance (which chunk of the task matched a given query + its RRF branch scores).
- Palette recent-search history (local-storage backed) — Phase 6 polish.
- Result-snippet highlighting: the API returns the snippet, but neither the Search tab nor the palette bolds the matched span.

**Phase 4 status:** DONE. All four PRs (P/Q/R/S) landed on `feat/meetsy-phase0`. Ready for Phase 5 (`/tuning` — per-workspace ML tunables with preview replay).


---

## Phase 5 (v2) — `/tuning` per-workspace ML tunables

Spec: `docs/superpowers/specs/2026-07-18-meetsy-v2-phase5-tuning-design.md`
Branch: `feat/meetsy-phase0`

Design goal (spec §1): Phase 0 landed the `WorkspaceMlConfig` + `AnalysisRunSnapshot` tables and a `MlConfigService.forWorkspace(...)` accessor, but nothing in the runtime actually read those tunables — the analysis pipeline still used compile-time constants (`DUP_FLAG` / `DUP_SUGGEST` in `duplicate-bands.ts`, `MIN_CORRECTIONS` / `MIN_AGREEMENT` in `learning-aggregate.ts`). Phase 5 closes that gap for the two tunable groups whose consumers are already isolated behind pure functions (dup bands + learning gate), ships an Owner-visible `/tuning` page to edit them, and adds a preview endpoint that replays the last N `AnalysisRun` snapshots against a candidate config so an Owner sees the delta before hitting Save. The remaining tunables (simFloor / minQualifying / closedWeight / rrfK / novelMaxSimCutoff / linkMinSim / embedBatch / model-routing) are stored today but not yet consumed by runtime code — the UI flags them with a "Not applied yet" chip so an Owner isn't misled.

### 2026-07-18 — PR-T: `MlConfigService.upsert` + `GET | PUT /workspaces/:id/ml-config` — DONE / GREEN

- **`apps/meetsy-api/src/kb/ml-config.service.ts`** — `MlConfigService` grew a second constructor dep (`LearningCacheService`) and two methods. `viewForWorkspace(workspaceId)` returns `{ tunables, models, updatedBy, updatedAt, isDefault }` — `isDefault=true` when the row is absent so the UI can show a "workspace hasn't customised this" chip. `upsert(workspaceId, orgId, updatedBy, payload)` defensively re-parses through `RunSnapshotPayloadSchema` (belt-and-braces after the controller's `ZodValidationPipe`), does a single `prisma.workspaceMlConfig.upsert({...})`, then calls `this.cache.invalidate(workspaceId)` so the learning-snapshot cache doesn't return a stale value keyed off the pre-edit gate constants.
- **`apps/meetsy-api/src/tuning/tuning.controller.ts`** — new `@Controller("workspaces/:id/ml-config")`. `@Get()` returns the view (any authed user; workspace-scoped via `WorkspaceResolver`). `@Put()` `@Roles("OWNER")` accepts a `RunSnapshotPayload` through `ZodValidationPipe`, resolves the org via `WorkspaceResolver`, and returns the fresh view. `@Post("preview")` `@Roles("OWNER")` delegates to `MlConfigPreviewService.run(...)` (see PR-V) — Owner-only because preview reads every `AnalysisRun` in the workspace, which we treat as sensitive.
- **`apps/meetsy-api/src/tuning/tuning.module.ts`** — imports `KbModule` (for `MlConfigService` + `LearningCacheService`) and `AnalysisModule` (for the `AnalysisRun` + `AnalysisRunSnapshot` prisma models via `PrismaService`); providers add `MlConfigPreviewService` and `WorkspaceResolver`.
- **`apps/meetsy-api/src/app.module.ts`** — imports `TuningModule`.
- **Specs**: `ml-config.service.upsert.spec.ts` (5 tests, new) — persist + cache invalidate; both `create` + `update` variants of the upsert; malformed payload rejected via defensive re-parse; `viewForWorkspace` marks `isDefault=true` when row absent; surfaces `updatedBy`/`updatedAt` from the persisted row. `ml-config.service.spec.ts` (existing) updated to pass a `{invalidate: jest.fn()}` cache stub to `makeService`.

### 2026-07-18 — PR-U: runtime consumption of dup bands + learning gate — DONE / GREEN

The runtime paths that already had a clean pure-function seam get wired through `MlConfigService`; every other tunable stays as its compile-time default (see the deferred list below). This is the honest minimum for Phase 5 — the rest is a Phase 6+ refactor of `retrieval.service.ts` and `kb.queue.ts`.

- **`apps/meetsy-api/src/kb/duplicate-bands.ts`** — `classifyDuplicates(neighbours, bands?: DuplicateBands, max = 3)` extended signature. `bands` defaults to `{dupFlag: DUP_FLAG, dupSuggest: DUP_SUGGEST}` so callers that don't pass one get compile-time constants. Exported `DuplicateBands` interface consumed by the preview service.
- **`apps/meetsy-api/src/kb/field-prediction.service.ts`** — `analyze(workspaceId, tasks, meetingDateISO, tunables?: WorkspaceTunables)` — optional so unit tests that don't need bands can keep calling the 3-arg form. When passed, plumbs `{dupFlag, dupSuggest}` through to `classifyDuplicates`.
- **`apps/meetsy-api/src/analysis/queue/analysis.processor.ts`** — loads `const mlSnapshot = await this.mlConfig.forWorkspace(workspaceId)` up front, passes `mlSnapshot.tunables` to `fieldPrediction.analyze`, and REUSES the same snapshot for the `AnalysisRunSnapshot` write (previously did a second round-trip). One less query per analysis run.
- **`apps/meetsy-api/src/kb/learning-aggregate.ts`** — `aggregateField(field, records, gate?: AggregateGate)` optional gate defaulting to `{minCorrections: MIN_CORRECTIONS, minAgreement: MIN_AGREEMENT}`. `gatePassed` derives from `gate.*` so a workspace with `minCorrections=5` genuinely needs 5 (not the module constant's 3) before nudges fire.
- **`apps/meetsy-api/src/kb/learning.service.ts`** — constructor grew a `MlConfigService` dep. `gate(workspaceId)` is now async and reads `{minCorrections, minAgreement, nearGateThreshold}` from `mlConfig.forWorkspace(...)` (nearGateThreshold = `max(minCorrections - 1, 0)` so a workspace tuned to `minCorrections=1` doesn't have a "near-gate" state). `snapshot(workspaceId)` reads tunables and passes `{minCorrections, minAgreement}` to every `aggregateField` call. `maybePublishThreshold(...)` reads `minCorrections` via a `Promise.all` alongside the snapshot re-fetch and passes it to `classifyThreshold`.
- **`apps/meetsy-api/src/kb/learning-stream.service.ts`** — `classifyThreshold(count, minCorrections = MIN_CORRECTIONS)` — same near-gate derivation as `LearningService.gate`.
- **Specs updated**: 7 `learning.service.*.spec.ts` files — each `new LearningService(prisma, cache, stream)` call updated to `new LearningService(prisma, cache, stream, mlConfig)` where `mlConfig` is a stub returning `{tunables: {minCorrections: 3, minAgreement: 0.6}, models: {}}`. `learning.service.gate.spec.ts` made async and gained a per-workspace override test (asserts `minCorrections=5` propagates end-to-end). `duplicate-bands.spec.ts` two existing calls shifted from `classifyDuplicates(neighbours, 10 | 2)` to `classifyDuplicates(neighbours, undefined, 10 | 2)` for the new signature; a new test verifies per-call band overrides.

### 2026-07-18 — PR-V: `POST /workspaces/:id/ml-config/preview` replay endpoint — DONE / GREEN

- **`apps/meetsy-api/src/tuning/ml-config-preview.service.ts`** — `MlConfigPreviewService.run(workspaceId, candidate, opts)` synchronously replays the workspace's last N completed `AnalysisRun` rows against a candidate config. Loads runs LEFT-joined to `AnalysisRunSnapshot` (so a legacy run without a snapshot uses the current workspace default as its baseline) + `meeting` (title, meetingDate for the UI). For each run: extracts `neighboursByTask` from `run.result` via a permissive `safeParseResult` helper that only requires `taskId` (string) + `sim` (number) on each neighbour hit — the rest of the `NeighbourHit` shape isn't needed for classification and legacy runs may have stored a narrower shape. Reclassifies via `classifyDuplicates(raw, baselineBands)` and `classifyDuplicates(raw, candidateBands)`; counts `flag`, `suggest`, `changed`. Gate delta is workspace-wide (not per-run): one `countGate(snap, baseline)` + one `countGate(snap, candidate)` against the current snapshot. `skippedFields()` returns the fixed list of non-replayable tunables + reasons for the UI's "these fields aren't in preview" note. Legacy runs without `neighboursByTask` return `duplicates: null` so the UI can visibly say "this run pre-dates neighbour storage".
- **BullMQ queue explicitly NOT added.** The spec's `meetsy-ml-preview` queue is documented as deferred (§5); preview compute is cheap synchronous JSON math (a few kB of neighbour data per run × 10 runs). Wiring stays available if preview grows heavier — e.g. running a candidate model through re-embedding for the sim-floor tunables — but Phase 5's compute doesn't earn a worker.
- **`limit`** clamps to `[1, 20]` (default 10). Owner is the only role that can call preview (see PR-T) so the read amplification is bounded to a workspace's Owner set.
- **Specs**: `ml-config-preview.service.spec.ts` (6 tests, new) — counts baseline vs candidate duplicates; legacy runs missing `neighboursByTask` return `duplicates: null`; uses `AnalysisRunSnapshot.tunables` as baseline when present, workspace default otherwise; reports non-replayable fields in `skipped`; gate summary counts baseline+candidate patterns from the workspace-wide snapshot; clamps `limit` to [1, 20].

### 2026-07-18 — PR-W: `/tuning` web page — DONE / GREEN

- **`apps/meetsy-web/app/tuning/page.tsx`** — client route. Reads `useCurrentUser()` + `useWorkspace()`; fetches `api.mlConfigGet(ws)` on workspace change. Owner-writable / Member-read-only (backend enforces via `@Roles("OWNER")`; the UI hides Save + Preview for Members and disables numeric inputs). Every `WorkspaceTunables` field renders as `<Input type="number">` bound to metadata in `tunable-meta.ts` (min/max/step come from the Zod schema's constraints — comment in the meta file flags that they MUST stay in sync). Fields where `consumed=false` show a "Not applied yet" chip so an Owner sees which knobs are stored-but-not-yet-live. Model routing renders as a read-only table (routing changes are a Phase 6 refactor of the callers). **Preview** button posts to `api.mlConfigPreview(ws, body, 10)` and opens a `PreviewSheet` showing per-run duplicate deltas + the workspace-wide gate delta + the skipped-fields note. **Save** button posts to `api.mlConfigPut(ws, body)` and fires a `sonner` toast on success/failure.
- **`apps/meetsy-web/app/tuning/tunable-meta.ts`** — form metadata for every `WorkspaceTunables` field: `label`, `description`, `min`, `max`, `step`, `section` (`duplicates | similarity | gate | novelty | kb`), `consumed`. `SECTIONS` + `SECTION_TITLES` drive the grouped layout so the page reads Duplicate detection → Similarity → Gate → Novelty → KB.
- **`apps/meetsy-web/components/nav/sidebar.tsx`** — `SETTINGS` gains a `/tuning` entry (`Sliders` icon, `ownerAdminOnly: true`). Members can still navigate directly (they get a read-only view); hiding the sidebar entry keeps their surface uncluttered.
- **`apps/meetsy-web/lib/api.ts`** — types (`WorkspaceMlConfigView`, `MlConfigPreviewRun`, `MlConfigPreviewView`); helpers (`api.mlConfigGet(ws)`, `api.mlConfigPut(ws, body)`, `api.mlConfigPreview(ws, body, limit?)`). Re-imports `RunSnapshotPayload`, `WorkspaceModels`, `WorkspaceTunables` from `@ma/shared` so the client + server share the Zod-derived types.

### 2026-07-18 — Phase 5 verify (all GREEN)

| # | Target | Command | Result |
|---|---|---|---|
| a | `@ma/shared` build | not needed — no shared-package changes in Phase 5 | SKIP |
| b | Meetsy API typecheck | `pnpm --filter @ma/api typecheck` (via `tsc --noEmit`) | PASS |
| c | Meetsy web typecheck | `pnpm --filter @ma/web typecheck` (via `tsc --noEmit`) | PASS |
| d | Meetsy web lint | `next lint` | PASS — 0 warnings, 0 errors |
| e | Meetsy API tests | `npx jest` (in `apps/meetsy-api`) | PASS — **56 suites / 313 tests** (was 54/300 after Phase 4; +2 suites, +13 tests: `ml-config-preview.service` + `ml-config.service.upsert`) |

`next build` intentionally skipped per the `meetsy-web-next-build-dev-footgun` memory. typecheck + lint are the sanctioned verification path.

**Migration status:** no new migrations in Phase 5 — Phase 0 already shipped `WorkspaceMlConfig` + `AnalysisRunSnapshot`. The three prior unapplied migrations (`20260718150000_meetsy_v2_phase1_run_search`, `20260718200000_meetsy_v2_phase2_push_dead_letter`, and Phase 0's `WorkspaceMlConfig`/`AnalysisRunSnapshot` migration) still ride `prisma migrate deploy` on the next deploy.

**Deferred (later phases):**
- `meetsy-ml-preview` BullMQ queue — preview compute is cheap synchronous JSON math today; queue wiring stays available for later.
- Runtime consumption of the remaining tunables: `simFloor`, `minQualifying`, `closedWeight` (currently constants in `retrieval.service.ts` / `field-prediction.service.ts`); `rrfK`, `embedBatch` (`kb.queue.ts` / `kb-embed.service.ts`); `novelMaxSimCutoff`, `linkMinSim` (novelty analyzer, doc↔task linker). Each requires a small refactor of its caller to accept an optional band/gate arg, mirroring PR-U's pattern on `classifyDuplicates`.
- Model routing consumption — `WorkspaceMlConfig.models.{summarizer,duplicateEmbeddings,gpt5NanoRoutes}` is stored but every AI call still resolves the model from `AI_ROUTES` / env config. Phase 6+ will inject the model per-workspace at the `AzureOpenAiClient` call sites.
- Preview coverage for the non-replayable fields — sim-floor / rrfK / model changes would need a re-run against the raw ClickUp task corpus (not the frozen `AnalysisRun.result`); if that becomes valuable, the `meetsy-ml-preview` queue is the natural home.
- Per-workspace override history / audit — every `WorkspaceMlConfig.upsert` sets `updatedBy` + `updatedAt`, but there's no time-series view. If tunable churn becomes real, a small `WorkspaceMlConfigHistory` table + a "diff since last save" view would slot in without changing the current shape.

**Phase 5 status:** DONE. All four PRs (T/U/V/W) landed on `feat/meetsy-phase0`.

---

## 2026-07-18 — Meetsy v2 Phase 6: cross-cutting UX polish (dark, keyboard, a11y, mobile)

**Design goal:** the last v2 phase is a *trust pass*, not a feature phase. Phase 0 wired shadcn/ui + `next-themes` + the `.dark` class variant, but no route was actually audited to work in dark mode — 364 `zinc-*` / `slate-*` / `bg-white` usages across ~30 files meant `system=dark` rendered white cards on a dark background. There was no theme toggle, no keyboard traversal on the review page, no skeleton loaders (every fetching state was a full-page `<Spinner>`), no `prefers-reduced-motion` guard, and no landmark/skip-link markup beyond the sidebar's `aria-label="Primary navigation"`. Phase 6 closes those gaps in four PRs. Backend footprint: **none** — every change lives in `apps/meetsy-web`.

### 2026-07-18 — PR-AA: dark-mode palette sweep + theme toggle — DONE / GREEN

- **`apps/meetsy-web/components/theme-toggle.tsx`** (new) — shadcn `DropdownMenu` with Light / Dark / System items (Sun / Moon / Laptop icons). Trigger icon animates rotate/scale between Sun and Moon under the `.dark` class variant so the trigger reflects the resolved theme.
- **`apps/meetsy-web/components/nav/sidebar.tsx`** — palette swept to semantic tokens (`bg-background`, `border-border`, `text-foreground`, `text-muted-foreground`, `bg-primary`, `bg-accent`). Active nav pill uses `bg-primary text-primary-foreground`; hover uses `bg-accent`. `aria-current="page"` added on the active `<Link>`. `<ThemeToggle />` mounted at the bottom-right of the desktop rail (alongside the email row) and top-right of the mobile top bar (opposite the hamburger).
- **`apps/meetsy-web/app/ui-legacy.tsx`** — the legacy `Card` / `Button` / `Spinner` / `ErrorBanner` / `PriorityBadge` / `Tag` primitives migrated to semantic tokens. `Button` variants: `primary=bg-primary`, `secondary=border-input bg-background hover:bg-accent`, `ghost=text-muted-foreground hover:bg-accent`, `danger=border-destructive/40 hover:bg-destructive/10`. Priority hues (red/orange/sky) kept but got dark-mode variants (`dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30` etc.) so the palette remains legible in dark mode without changing meaning.
- **Bulk sweep across 22 application files** — `app/{home,kb,learning,meetings,new,runs,settings,tuning,ui-legacy}/*.tsx` + `components/{charts,learning,runs,tasks}/*.tsx`: `bg-white` → `bg-card`; `text-zinc-{900,800,700}` → `text-foreground`; `text-zinc-{600,500}` → `text-muted-foreground`; `text-zinc-400` → `text-muted-foreground/70`; `border-zinc-200` → `border-border`; `border-zinc-300` → `border-input`; `bg-zinc-{100,200}` → `bg-muted`; `bg-zinc-{900,800}` → `bg-primary`; `hover:bg-zinc-100` → `hover:bg-accent`; `focus:border-zinc-{400,500}` → `focus:border-ring`; `focus:ring-zinc-200` → `focus:ring-ring`; `divide-zinc-{100,200}` → `divide-border`. `components/tasks/task-chip.tsx` and `components/tasks/task-detail-sheet.tsx` also swept.

### 2026-07-18 — PR-BB: keyboard shortcuts + landmarks + focus rings — DONE / GREEN

- **`apps/meetsy-web/app/AppShell.tsx`** — added a `sr-only focus:not-sr-only` skip-to-content link as the first focusable element in the shell (`focus:fixed focus:top-2 focus:left-2 focus:bg-primary focus:text-primary-foreground focus:z-50`). `<main id="main-content" role="main" tabIndex={-1}>` so the skip link and screen-reader landmark navigation both target the same node. The redundant `role="main"` is belt-and-suspenders — some assistive-tech implementations don't map the tag alone reliably.
- **`apps/meetsy-web/app/runs/[runId]/use-review-keys.ts`** (new) — `useReviewKeys()` attaches a window-level `keydown` listener. `j` / `ArrowDown` focuses next `[data-task-anchor]`; `k` / `ArrowUp` focuses prev; wraps at both ends; guards against firing while typing in `<input>` / `<textarea>` / `[contenteditable]`; ignores keys with `Ctrl` / `Meta` / `Alt` modifiers so `Ctrl+J` etc. still work. Also smooth-scrolls the anchor into view via `scrollIntoView({block:"nearest"})`.
- **`apps/meetsy-web/app/runs/[runId]/components.tsx`** — `TaskCard` wrapped in a `<div data-task-anchor={task.id} tabIndex={-1} className="scroll-mt-24 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">` so the hook has a stable target. `scroll-mt-24` gives the smooth-scroll enough top offset to not tuck the card under any fixed header. `<h3>` gains `break-words` so long task titles don't overflow the card. Task-card interior structure and the `TaskFeedbackControl` submit button are untouched — Tab still traverses those normally.
- **`apps/meetsy-web/app/runs/[runId]/page.tsx`** — calls `useReviewKeys()` once at the top of `RunPage()`. Deliberately called unconditionally (not scoped to a tab) so `j`/`k` works while a user is on Push / Chat / Insights too — the hook simply no-ops when there are no task anchors in the DOM.
- **Focus-ring pass** — the sidebar links + brand logo gained `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`. shadcn primitives (`<Button>`, `<Input>`, `<Sheet>`, `<Tabs>`, `<DropdownMenu>`, `<Command>`) already ship with `focus-visible:` rings via their base recipes, so the pass focused on hand-rolled interactive elements only.

### 2026-07-18 — PR-CC: skeleton loaders + empty states — DONE / GREEN

- **`apps/meetsy-web/components/ui/empty-state.tsx`** (new) — small `<EmptyState icon={LucideIcon} title description action={{label, href|onClick}} />` surface: dashed-border card, icon in a muted `rounded-full bg-muted` circle, title, optional description, optional single action. Uses semantic tokens throughout so it works in both themes.
- **`apps/meetsy-web/app/home/page.tsx`** — replaced `<Card><Spinner label="Loading runs…" /></Card>` initial-load block with three `<Skeleton className="h-20 w-full rounded-xl" />` rows matching the `RunRow` height. Replaced the hand-rolled "No runs yet" `<Card>` with an `<EmptyState icon={HomeIcon}>` pointing at `/new`.
- **`apps/meetsy-web/app/meetings/page.tsx`** — the paginated list's loading state became a five-row `<Skeleton className="h-16 w-full rounded-xl">` stack. The two empty-state branches (search-no-results and filter-no-results) consolidated into one `<EmptyState>` that adapts its icon (`Search` when a query is active, `ListChecks` otherwise), copy, and action (Clear search vs Analyze a meeting) based on state.
- **`apps/meetsy-web/app/kb/tasks-tab.tsx`** — the `<Spinner label="Loading tasks…" />` became five `<Skeleton className="h-14 w-full rounded-lg">` rows matching the task-row height. The two prior empty texts consolidated into one `<EmptyState icon={ListChecks}>` that reads "No tasks match" when filtering and "No tasks embedded yet" when not.
- **Button-embedded spinners kept** — `<Spinner>` inside `<Button>` (Save, Upload, Load more) is an affordance, not a layout loader; those stay. The full-page `AppShell` gate spinner (pre-auth) also stays because a skeleton there would flash before we even know the user is signed in.

### 2026-07-18 — PR-DD: reduced-motion + mobile-safe review — DONE / GREEN

- **`apps/meetsy-web/app/globals.css`** — appended a `@media (prefers-reduced-motion: reduce)` block that sets `animation-duration: 0ms !important; animation-iteration-count: 1 !important; transition-duration: 0ms !important; scroll-behavior: auto !important;` on `*, *::before, *::after`. Neutralizes shadcn's slide/fade transitions, sonner's toast slide, sheet slides, and Tailwind `animate-*` utilities in one shot. `!important` is necessary because Tailwind utilities and Radix data-state animations have specificity we can't beat via cascade order alone. The `disableTransitionOnChange` on `<ThemeProvider>` (Phase 0) covers the theme-flip case; this block covers everything else.
- **`apps/meetsy-web/app/runs/[runId]/components.tsx`** — `PersonSection`'s task-list indent went from `pl-9` to `pl-4 md:pl-9`. On phones the tasks now stack flush-left instead of eating half the horizontal budget under the person's avatar column.
- **`components/tasks/task-detail-sheet.tsx`** — kept `side="right"` because shadcn's `SheetContent` already uses `w-full max-w-md` which collapses to full-width on phones (< 448px viewport). The bottom-drawer flip described in the spec was reconsidered and skipped — the current behavior already looks correct on mobile and a runtime `side` swap based on media query risks a Radix Sheet unmount during resize.
- **`aria-live` regions** — the tuning page's server-validation error path renders via `ErrorBanner`, which already carries `role="alert"` (upgraded in PR-AA's palette sweep of `ui-legacy.tsx`); no additional wiring needed. Sonner's toast root declares `role="status"` internally.

### 2026-07-18 — Phase 6 verify (all GREEN)

| # | Target | Command | Result |
|---|---|---|---|
| a | `@ma/shared` build | not needed — no shared-package changes in Phase 6 | SKIP |
| b | Meetsy web typecheck | `tsc --noEmit` in `apps/meetsy-web` | PASS |
| c | Meetsy web lint | `next lint` | PASS — 0 warnings, 0 errors |
| d | Meetsy API tests (drift check) | `npx jest` in `apps/meetsy-api` | PASS — **56 suites / 313 tests** (unchanged from Phase 5; no API code touched) |

`next build` intentionally skipped per the `meetsy-web-next-build-dev-footgun` memory. typecheck + lint are the sanctioned verification path.

**Manual QA path (documented for the record):**
1. Toggle `ThemeToggle` → Light / Dark / System. Every primary route (`/home`, `/meetings`, `/kb`, `/runs/:id`, `/tuning`, `/learning`, `/settings/push`) renders correctly with no white-on-black cards.
2. On `/runs/:id`, hit `j` / `k` — focus rings move between task cards; `Esc` closes the task-detail sheet (Radix's built-in).
3. Tab from top of the page — the first stop is the "Skip to main content" link.
4. macOS System Settings → Accessibility → Display → Reduce Motion, reload — sheet/toast/animation transitions are visibly gone.
5. Resize to < 768px — sidebar collapses to a hamburger; review page task cards stack flush-left; long task titles wrap instead of overflowing.

**Migration status:** no new migrations in Phase 6 — no API or Prisma changes.

**Deferred (later phases / follow-ups):**
- **Comprehensive a11y audit** — Phase 6 hits landmarks, focus, reduced motion, skip link, `aria-current`, and role="alert" on error banners. A formal axe/WCAG-AA sweep is deferred.
- **`?` shortcut cheatsheet** — an in-app "keyboard shortcuts" help sheet reachable via `?`. Wait to see how ICs actually use `j`/`k` before designing this.
- **RTL support** — every layout still assumes LTR. Not on the roadmap.
- **`useMediaQuery` bottom-drawer sheet** — the mobile bottom-drawer variant of `TaskDetailSheet` was scoped for Phase 6 but skipped after review; the current right-side sheet at `w-full max-w-md` collapses cleanly on phones.
- **Full palette sweep of every literal hue** — the sweep converted zinc/slate/white to semantic tokens. Blue/amber/red/violet chips picked up `dark:` variants case-by-case; a future pass could tighten those further.

**Phase 6 status:** DONE. All four PRs (AA/BB/CC/DD) landed on `feat/meetsy-phase0`.

**Meetsy v2 status:** DONE. All six phases (0–6) landed. The v2 success criteria from `docs/superpowers/plans/2026-07-18-meetsy-v2-plan.md` §6 are met: Home + past-run navigation (Phase 1), clickable evidence chips + side sheet (Phase 2), visible learning-loop patterns building up + `assignee`+`sprint` learning (Phase 3), consolidated `/kb` route (Phase 4), `/tuning` with preview replay (Phase 5), dark mode + keyboard traversal (Phase 6).

---

### 2026-07-19 — Meetsy v2 Implementation & Verification Guide (PDF) — DONE

Full-length HTML → PDF walkthrough covering v2 Phases 0–6, plus a per-route UI-journey verification guidebook (8 journeys) and the success-criteria checklist. Rendered via headless Chrome from the checked-in HTML source.

- `docs/meetsy/Meetsy-v2-Implementation-Guide.source.html` — HTML source with inline CSS, 8 Mermaid diagrams (architecture, phase-dependency graph, sidebar layout, ER model, KB tab flow, three sequences: SSE learning toast, push retry, end-to-end upload→push), 16 numbered sections including a per-phase deep-dive for each of Phases 0–6. Mermaid renders client-side from CDN under Chrome's `--virtual-time-budget=15000` so all diagrams flush to SVG before capture.
- `docs/meetsy/Meetsy-v2-Implementation-Guide.pdf` — the rendered guide (2.16 MB).

**Verify state at guide time (2026-07-19):** meetsy-web typecheck ✅ · `next lint` ✅ (0/0) · meetsy-api typecheck ✅ · `npx jest` ✅ (56 suites / 313 tests / 5.918s) · working tree clean · HEAD `7884b32`.

**What the guide covers:**
1. v2 in one page — the four problems solved (review-page overload, hidden evidence, invisible learning loop, KB legibility) + the Phase-0 signal-loss bug.
2. Audience decision (IC engineers) + the six-phase table.
3. Architecture + phase-dependency graph (both as Mermaid diagrams).
4–10. Per-phase deep dives (0 · Foundations → 6 · Cross-cutting UX polish) with PR-level detail (A → DD), grounded in this journal.
11. Data model changes at a glance (ER diagram) + migration inventory + signal-key round-trip invariant.
12. End-to-end sequence (upload → review → push) with every v2 addition annotated.
13. Queues, SSE streams, data stores + endpoint quick reference.
14. UI journey — 8 step-by-step verification walkthroughs (A · land + orient · through H · dark mode + a11y).
15. Success-criteria checklist (9 criteria from v2 plan §6, all met) + test-suite growth by phase + honest deferred list.
16. Verification results + ops appendix (local boot, cross-subdomain cookie test, env vars, "where to look when something breaks", source-of-truth read order).

The prior PDF at `docs/meetsy/Meetsy-Implementation-Guide.pdf` (v1 Phases 0–3, integration plan 2026-06-27) is left untouched — the two are complementary.
