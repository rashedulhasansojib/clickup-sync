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
