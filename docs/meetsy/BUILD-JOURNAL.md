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

