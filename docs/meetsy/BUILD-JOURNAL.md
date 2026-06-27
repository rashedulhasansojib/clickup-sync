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
- **Key facts:** Azure chat = `niftyai.openai.azure.com` (gpt-5.4/-pro/-mini). Azure embeddings =
  SEPARATE resource `niftyocr.openai.azure.com` (text-embedding-3-large, `dimensions=1024` honored —
  verified 2026-06-27). pgvector needs the dev Postgres image swapped `postgres:18-alpine` →
  `pgvector/pgvector:pg18` (Phase 2). gpt-5.4-pro is Responses-API-only.

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

## ✅ PHASE 1 COMPLETE (code + tests; live-migrated). Remaining: live ClickUp push validation (needs a real ClickUp list/token).
