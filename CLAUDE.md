# CLAUDE.md

This file gives Claude Code project-specific instructions for working on this repository.

## Meetsy integration (READ FIRST if the task touches Meetsy)

This repo is being extended into a **two-product ecosystem**: **Clicksy** (the existing
ClickUp→Postgres sync, root `src/` + `apps/web`) and **Meetsy** (a folded-in meeting-intelligence
service — `apps/meetsy-api`, `apps/meetsy-web`, shared code in `packages/*`). Before building or
changing ANY Meetsy feature, read, in order:

1. `docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md` — the umbrella vision + phased build plan.
2. The relevant phase spec under `docs/superpowers/specs/` (e.g. `2026-06-27-meetsy-phase0-plumbing-design.md`).
3. `docs/meetsy/BUILD-JOURNAL.md` — what has actually been built so far + current state.

Then **keep the build journal current** as part of your change. Meetsy shares Clicksy's auth/session,
org/workspace model, Postgres (own `meetsy` schema, read-only on `public`), and ClickUp token — never
duplicate or fork those. Clicksy's source stays untouched except the documented cookie-`Domain` change.

## Project purpose

This repository is a NestJS backend starter that replaces the existing n8n ClickUp sync workflows with a code-based service.

The service synchronizes ClickUp data into PostgreSQL for reporting and Grafana dashboards. It handles:

- ClickUp task webhooks.
- Scheduled/backfill task sync by ClickUp Space.
- Parent task and subtask normalization.
- Task deletes as soft deletes.
- ClickUp tracked-time sync.
- Cost calculation for time entries using effective-dated assignee rates.

## Source-of-truth files to read first

Before making architecture or behavior changes, read these files:

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/OPERATIONS.md`
- `prisma/schema.prisma`
- `src/config/clickup-spaces.config.ts`
- `source-workflows/ClickUp → DB Sync.json`
- `source-workflows/Sync Assignee Rates.json`
- `source-workflows/Old Clikup Task Sync_ Digital Marketing.json`
- `source-workflows/Old Clikup Task Sync_ Projects.json`
- `source-workflows/Old Clikup Task Sync_ R&D Apps.json`
- `source-workflows/clickup_sync_backend_documentation.md`

The n8n workflow files are historical source material. Do not copy n8n quirks blindly; translate the intended behavior into typed NestJS services, workers, repositories, and tests.

## Runtime stack

- **Node.js `>=22.13`** (real floor — Vite 8 + rolldown 1.x + Prisma 7 all reject earlier). Pinned via `.nvmrc` (`22.13`) and `engines.node`. `.npmrc` has `engine-strict=true` so wrong Node fails the install loudly instead of silently dropping optional native bindings.
- **pnpm 9.12** (pinned via root `packageManager` field). `.npmrc` has `manage-package-manager-versions=true` so any pnpm on `PATH` (Homebrew, corepack, npm-global) auto-invokes the pinned 9.12 for this repo. If pnpm isn't on PATH yet: `brew install pnpm` (one-time; lives at `/opt/homebrew/bin/pnpm`, survives nvm switching).
- NestJS 11
- Prisma 7 with `prisma.config.ts`
- PostgreSQL
- Redis
- BullMQ
- Swagger at `/docs`

## Running the project

Two flows: **from-scratch** (fresh clone / new machine / after wiping `node_modules`) and **daily** (every subsequent boot).

### A · From scratch (once per machine, or after a full wipe)

```bash
# 1 · Machine prerequisites (one-time)
brew install pnpm                            # pnpm at /opt/homebrew/bin/pnpm, survives nvm switching
# nvm should already be installed; if not: brew install nvm

# 2 · Node version (reads .nvmrc = 22.13)
cd /path/to/clickup-sync
nvm install                                  # installs Node v22.13.x if missing
nvm use                                      # activates it here
nvm alias default 22.13                      # (optional) make it your global default

# 3 · Copy env file (once per clone)
cp .env.example .env                         # fill in real values afterwards

# 4 · Install deps (postinstall auto-runs BOTH `prisma generate` calls now — see .npmrc guardrails)
pnpm install

# 5 · Start Docker services (Postgres, Redis)
npm run dev:deps                             # docker compose up -d postgres redis

# 6 · Apply DB migrations
npm run prisma:deploy                        # Clicksy schema (public)
# Meetsy schema (first time only, needs the meetsy role from grants.sql):
psql -f apps/meetsy-api/prisma/grants.sql
pnpm --filter @ma/api exec prisma migrate deploy

# 7 · Boot everything
npm run dev:platform                         # clicksy-api + clicksy-web + meetsy-api + meetsy-web
```

That's it. From this point on, every route is up:
- Clicksy web: <http://localhost:5173>
- Clicksy API: <http://localhost:3000>
- Meetsy web: <http://localhost:3001>
- Meetsy API: <http://localhost:3010>

### B · Daily development (every subsequent boot)

```bash
cd /path/to/clickup-sync
nvm use                                      # picks 22.13 from .nvmrc (skip if it's your default)
npm run dev:deps                             # ensures Postgres+Redis containers are up (no-op if already running)
npm run dev:platform                         # boots all four apps under one concurrently window
```

If you `git pull` and the schema or deps changed:

```bash
pnpm install                                 # postinstall auto-regenerates Prisma clients
npm run prisma:deploy                        # apply new Clicksy migrations
pnpm --filter @ma/api exec prisma migrate deploy   # apply new Meetsy migrations
npm run dev:platform
```

### C · Quality checks (before every commit)

```bash
# From root — Clicksy backend
npm run lint
npm run test
npm run build

# Meetsy — the sanctioned verify path (next build is deliberately skipped per meetsy-web-next-build-dev-footgun memory)
pnpm --filter @ma/api typecheck
pnpm --filter @ma/api test
pnpm --filter @ma/web typecheck
pnpm --filter @ma/web lint                   # next lint
```

### D · Reset local DB (dev only — NEVER staging/prod)

```bash
npm run dev:reset                            # docker compose down -v && bring back up && prisma:deploy
```

### E · Common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `command not found: pnpm` after `nvm deactivate` | pnpm was installed into an nvm-managed Node's global bin | `brew install pnpm` puts it at `/opt/homebrew/bin/pnpm`, immune to nvm state |
| `Cannot find native binding` for `@rolldown/binding-*` | Node was too old at install time so pnpm silently skipped the optional binding | Switch Node → `rm -rf node_modules` → `pnpm install`. `.npmrc`'s `engine-strict=true` now makes this fail loudly at install instead |
| `Property 'meeting' does not exist on type 'PrismaService'` (200+ TS errors on meetsy-api) | Prisma client not generated (fresh `node_modules` without `prisma generate`) | The `postinstall` hooks in root + `apps/meetsy-api/package.json` handle this automatically; if you land here anyway: `pnpm --filter @ma/api exec prisma generate && DATABASE_URL=postgresql://placeholder pnpm exec prisma generate --config ./prisma.config.ts` |
| Vite says `Node.js version 22.13+` | Old nvm default is active | `nvm use` in repo dir picks up `.nvmrc = 22.13` |
| pnpm 11 refuses to boot on Node 22.12 | Homebrew's pnpm 11.15+ requires Node ≥22.13 | The `.nvmrc` and `engines.node` already say `22.13`; `nvm install && nvm use` |

## Environment variables

Use `.env.example` as the template. Never commit real secrets.

Required for core sync:

```env
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
CLICKUP_API_TOKEN=pk_...
CLICKUP_TEAM_ID=3450636
CLICKUP_WEBHOOK_ENDPOINT=https://your-domain.com/webhooks/clickup
CLICKUP_WEBHOOK_SECRET=...
```

## ClickUp permissions and API constraints

Use a dedicated ClickUp Workspace Owner/Admin service account token for production.

The service account token is needed because this backend must fetch and sometimes create/delete time entries for assignees. A normal member token is not enough for assignee-wide tracked-time sync.

Important ClickUp behavior to preserve:

- Webhook endpoint: `POST /webhooks/clickup`.
- Expected webhook events:
  - `taskCreated`
  - `taskUpdated`
  - `taskDeleted`
  - `taskTimeTrackedUpdated`
- Fetch task details with `GET /task/{task_id}?include_subtasks=true`.
- Backfill tasks with `GET /team/{team_id}/task` using:
  - `space_ids[]`
  - `date_updated_gt`
  - `include_closed=true`
  - `subtasks=true`
  - `page` starting at `0`
  - `limit=100`
- Time-entry sync should pass explicit `start_date` and `end_date` windows for backfills/reconciliation, not rely on ClickUp defaults.
- When creating a time entry for another user, use the API field `assignee`, not the old n8n-style `uid` field.
- Preserve webhook dedupe; duplicate events must not create duplicate writes or duplicate time entries.
- Verify webhook signatures before production release. Store the secret returned by ClickUp webhook creation in `CLICKUP_WEBHOOK_SECRET`.

## Default workspace mapping

These values came from the source workflows and are currently encoded in `src/config/clickup-spaces.config.ts`.

| Space | ID | Lookback |
|---|---:|---:|
| Digital Marketing | `3577824` | 30 days |
| R&D Apps | `3589129` | 30 days |
| Projects | `3525433` | 30 days |

Team ID: `3450636`.

## Main code areas

| Area | Files |
|---|---|
| App bootstrap | `src/main.ts`, `src/app.module.ts` |
| Config/env validation | `src/config/*` |
| ClickUp API client and normalization | `src/clickup/*` |
| Task persistence | `src/tasks/*` |
| Time entries and cost calculation | `src/time-entries/*` |
| Webhook ingestion/dedupe | `src/webhooks/*` |
| Scheduled/backfill sync | `src/sync/*` |
| Assignee rates | `src/rates/*` |
| BullMQ workers | `src/workers/*` |
| Database schema | `prisma/schema.prisma` |
| SQL migration | `prisma/migrations/0001_initial/migration.sql` |

## Data model rules

### Tasks

`clickup_tasks` is the reporting table. Preserve these rules:

- `task_id` is the conflict key.
- Parent tasks have `parent_task_id = null`.
- Subtasks store their ClickUp parent in `parent_task_id`.
- Missing parents should be fetched and inserted before subtasks when possible.
- Task deletes should be soft deletes unless the product owner explicitly asks for hard deletes.
- `sync_count`, `synced_at`, and job logs are operational signals; keep them accurate.

### Custom fields

Task normalization must defensively extract:

- `executive_name`
- `department`
- `client`
- `cost`
- `estimation`
- `sprint_name`
- `sprint_points`

`sprint_points` can appear at root level as `points` or `story_points`, or inside custom fields. Check root-level fields first, then custom fields as fallback.

For the `client` dropdown field, resolve the selected option name from `type_config.options` using `orderindex`.

### Time entries

`clickup_time_entries` stores normalized ClickUp tracked time.

Rules:

- Keep `time_entry_id` as the conflict key.
- Convert ClickUp millisecond durations into decimal hours.
- Store original logger fields separately from mapped assignee fields when adding multi-assignee behavior.
- Cost calculation must pick the effective assignee rate for the entry date.
- Missing rates should be visible in logs/job results; do not silently calculate cost as valid when no rate exists.

### Assignee rates

Rates are managed via the dashboard (`/assignee-rates`) / the `POST|PATCH|DELETE /admin/rates` API. There is no Google Sheets sync. Changing a rate enqueues a scoped `recalculate-costs` job (queue `maintenance`) that recomputes existing `clickup_time_entries`. `valid_from`/`valid_to` form a closed-closed (inclusive) interval `[from, to]` (a rate covers `start_time` where `valid_from <= date <= valid_to`; empty `valid_to` = open-ended). The human convention: a rate ending Dec 31 covers Dec 31, and the next rate starts Jan 1 — no overlap, no gap. If two rates do overlap (both match the same date), the one with the later `valid_from` wins because `cost-calculator.service.ts` does `orderBy: { validFrom: 'desc' }` + `findFirst`.

Rules:

- `hourly_rate_cents` must be an integer.
- `valid_from` is required.
- Empty `valid_to` means open-ended.
- Use effective dating to calculate time-entry cost.

## Worker and queue rules

Webhook controllers should respond quickly and queue work. Do not perform heavy ClickUp fetches or database backfills inside the HTTP request path.

Expected queues:

- `clickup-webhooks`
- `clickup-tasks`
- `clickup-time-entries`
- `clickup-backfills`
- `maintenance`

When adding workers:

- Make jobs idempotent.
- Set useful attempts/backoff.
- Log enough context for failed jobs.
- Send unrecoverable payloads to dead-letter storage.
- Avoid infinite retry loops on invalid payloads.

## Coding standards

- Use NestJS dependency injection; avoid newing services manually.
- Keep API calls in `src/clickup/clickup.client.ts` or purpose-specific ClickUp service wrappers.
- Keep database writes in repositories.
- Keep normalization pure and easy to test.
- Add tests for every new payload parser or custom-field extractor branch.
- Prefer explicit DTO/types over `any`; use `unknown` plus guards for untrusted payloads.
- Never log API tokens, Google private keys, webhook secrets, raw auth headers, or full credentials.
- Preserve Prettier formatting.

## Before changing dependencies

This starter intentionally pins package versions. Before changing versions:

1. Check current official package compatibility.
2. Update `package.json` and lockfile together if a lockfile is added.
3. Run:

```bash
npm install
npm run lint
npm run test
npm run build
```

## Before changing Prisma schema

1. Update `prisma/schema.prisma`.
2. Create a migration with Prisma.
3. Review generated SQL before committing.
4. Run:

```bash
npm run prisma:generate
npm run prisma:deploy
npm run test
npm run build
```

Do not manually edit an existing applied migration unless this is still local-only and explicitly intended.

## Security checklist

Before production deployment, make sure these are done:

- ClickUp API token stored only in secret storage.
- Webhook signature verification enabled.
- HTTPS enabled for the webhook endpoint.
- PostgreSQL app user has least-privilege permissions.
- Grafana uses read-only database credentials.
- Queue dashboard/admin endpoints, if added, are protected.
- Rate limiting and request size limits are configured for public endpoints.

## Common implementation tasks

### Add a manual task sync endpoint

Create a controller endpoint that enqueues a task-sync job. Do not fetch ClickUp directly from the controller.

Suggested payload:

```json
{ "taskId": "86abc123" }
```

### Add a manual space backfill endpoint

Create a controller endpoint that enqueues a backfill job.

Suggested payload:

```json
{ "spaceId": "3577824", "lookbackDays": 90 }
```

Validate that the requested space is allowed unless an admin override is explicitly added.

### Add webhook registration

When implementing webhook registration:

- Use `CLICKUP_WEBHOOK_ENDPOINT`.
- Subscribe only to configured `CLICKUP_WEBHOOK_EVENTS`.
- Store the webhook ID and secret returned by ClickUp.
- Avoid creating duplicate active webhooks for the same endpoint/events.

### Complete multi-assignee tracked-time replacement

The source n8n workflow maps tags such as `ahmad`, `chisty`, `fahim`, `rashedul`, `rejaur`, `sayem`, and `expense` into assignee identities.

When implementing this in code:

- Move the mapping into config or a database table, not hardcoded worker branches.
- Fetch the original time entry.
- Create replacement time entries with `assignee` for mapped users.
- Delete the original only after all replacement entries are successfully created.
- Store an audit trail to prevent double replacement.
- Make the job idempotent.

## Known starter limitations

This service is internal-only and intentionally narrow in scope. Items still expected next:

- Per-ORG data isolation (`org_id` on ClickUp data tables, per-org sync/queries, true multi-org self-serve signup). Per-user auth + a single tenant org exist now (see below), but all ClickUp data still belongs to one implicit seed org — this is Spec 2.
- Reporting surfaces for the newer event types: `taskMoved`, `taskAssigneeUpdated`, `taskPriorityUpdated` are now captured into `clickup_task_events` (alongside `taskStatusUpdated`) via `HISTORY_FIELDS` in `clickup-event.processor.ts`, but no report/UI reads them yet (cycle-time/time-in-status still query `event_type='taskStatusUpdated'` only).
- Cycle-time drill-downs by client and department (backend accepts `groupBy=client|department`; UI surface is single bucket).
- Currency rename (the `*Aud` field names and the `currency` columns hold USD in practice — see the `currency-aud-usd-debt` memory).

Already in place (do not re-implement):

- Webhook signature verification (`src/webhooks/webhook-signature.guard.ts`, HMAC-SHA256, hard-required in prod)
- Admin API key gate (machine-credential branch in `src/auth/auth.guard.ts` — length-checked, timing-safe compare, mints a synthetic Owner principal; hard-required in prod via env validation. The old standalone `AdminApiKeyGuard` was dead code and has been removed.)
- Manual admin endpoints (sync task, backfill, replacement backfill, retry-failed-webhooks, dead-letter list/retry/resolve, full task reconcile + live progress, rates CRUD, tag-mapping CRUD, recalc, register webhook, live backfill progress — all in `src/admin/admin.controller.ts`)
- Dead-letter storage + inspector (`DeadLetterJob` + `DeadLetterRepository` + admin endpoints)
- Time-entry replacement with audit (`TimeEntryReplacement` model + `AssigneeReplacementService`; audit row written before original delete; `originalEntryId @unique` for idempotency)
- Admin audit log (`AdminAuditLog` model + `AuditLogInterceptor` on `AdminController`, write actions only, viewable at `/audit-log`)
- Status-change history capture (`clickup_task_events`, subscribed to `taskStatusUpdated`; cycle-time + time-in-status reports at `/reports/cycle-time` and `/reports/time-in-status`; card on Overview page)
- Per-user authentication & RBAC (`src/auth/*`): email/password login (`scrypt` hashing, NIST-style policy), HTTP-only cookie sessions that are DB-backed with SHA-256-hashed tokens and an hourly expired-session sweep (`SessionCleanupService`). One `Organization` tenant with three roles — Owner (org secrets + everything), Admin (ops + invite), Member (read-only) — enforced app-wide by a global `AuthGuard` + `RolesGuard`. Self-serve signup claims the seed org and becomes its first Owner; after that signup is closed and users join by email invitation (`nodemailer`/SMTP, dev transport logs the link). The shared `ADMIN_API_KEY` now authenticates as a synthetic Owner machine credential. The audit log actor is derived from the authenticated session user (the spoofable `X-Admin-User` header is retired). Note: per-ORG data isolation (`org_id` on ClickUp data tables, multi-org sync) is still pending — see Spec 2 and `docs/superpowers/specs/2026-06-06-auth-orgs-rbac-design.md`.
