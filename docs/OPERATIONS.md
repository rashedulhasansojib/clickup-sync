# Operations

## Start local dependencies

```bash
cp .env.example .env
npm install
npm run dev:deps
npm run prisma:deploy
npm run start:dev
```

## Register ClickUp webhook

Set `CLICKUP_WEBHOOK_ENDPOINT` to the public URL that forwards to `/webhooks/clickup`.

ClickUp events expected by the worker:

```text
taskCreated
taskUpdated
taskDeleted
taskTimeTrackedUpdated
```

## Authentication & roles

Access is per-user with RBAC under a single tenant **Organization**.

- **Bootstrap:** the first `POST /auth/signup` claims the seed org and becomes its **Owner**. After that, signup is closed and new users join by **email invitation** (Owner/Admin invites via the Members & Access tab in Settings).
- **Roles:**
  - **Owner** — org secrets (ClickUp token, webhook secret, team ID, register webhook) + everything Admins can do.
  - **Admin** — ops: rates/tag-mapping CRUD, recalc, sync/backfill, dead-letter & webhook retry, audit log, invite Members/Admins. No org secrets, no touching Owners.
  - **Member** — read-only dashboards and reports.
- **Sessions** are HTTP-only, DB-backed cookies; tokens are stored hashed. Expired sessions are swept hourly by `SessionCleanupService`.
- **`ADMIN_API_KEY`** is now a machine/automation credential (authenticates as a synthetic Owner), not a shared human login.

Auth-related env vars: `DEFAULT_ORG_NAME`, `SESSION_MAX_AGE_DAYS`, `SESSION_IDLE_TIMEOUT_DAYS`, `APP_BASE_URL` (invite links), `ALLOWED_ORIGINS` (CORS), and `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` (invitation email). With no SMTP configured, the dev mailer logs the invite link to the console.

## Manual backfill

Add a BullMQ job to `clickup-backfills` with payload:

```json
{ "spaceId": "3577824", "lookbackDays": 90 }
```

A backfill that hits the task pagination cap is **incomplete** — tasks beyond the cap are not synced. This is now recorded on the run's `sync_job_logs` row as status `partial` (rendered as an amber pill in Sync Logs; the reason shows in the run detail) instead of a clean `completed`. Re-run the backfill with a narrower window if you see it.

## Scheduled reconcile

Three recurring crons run as safety nets for events ClickUp never delivered (real-time updates still arrive via webhooks):

- **Recent updates** — `reconcileRecentUpdates()` every 12h (`@Cron('0 0 */12 * * *')`): re-syncs tasks updated in the last day + a bounded 7-day time-entry window, per enabled space. Deliberately skips the archived per-list scan (too heavy across all spaces every run).
- **List catalog** — `syncListCatalogs()` daily at 03:00 (see "Sprint / list catalog" below).
- **Archived reconcile** — `reconcileArchived()` daily at 04:00 (`@Cron('0 0 4 * * *')`): runs a full `includeArchived=true` backfill for **exactly one** enabled space per day, rotating through the enabled spaces by calendar day. This closes the gap where a task inside a just-completed (archived) sprint whose state changed after its list was archived would otherwise never re-sync until a manual backfill — while keeping the expensive archived scan bounded to one space per run on the small host. It respects the same in-flight overlap guard as the 12h reconcile.

  Caveat: the archived pass issues one paginated request per list (a sprint folder can hold 200+ archived lists) and fans a `sync-task-time-entries` job out per task onto the throughput-bottlenecked `clickup-time-entries` queue. The overlap guard only checks that the space has no `clickup-backfills` job in flight — it does **not** see the time-entry backlog, which drains after the backfill job itself completes. In practice the one-space-per-day rotation gives ~N days (N = enabled space count) for that backlog to drain, and those backfill time-entry jobs are deprioritized so they never block live webhooks. If archived-list counts grow much larger, bound the per-run list count or gate on `clickup-time-entries` depth.

## Windowed time-entry reconcile

`POST /admin/time-entries/reconcile-window` (body: `{ spaceId?: string; lookbackDays?: number }`, default lookback 90 days, clamped to a max of 400 days) enqueues one deprioritized `reconcile-time-entries-window` job per configured space × 30-day slice — a cheap alternative to the per-task `sync-all` sweep. It is manual/on-demand only (not one of the three crons above), wired to Settings → Sync → "Reconcile time entries".

**Unverified assumption:** both its cross-space scoping and its delete-pruning depend on ClickUp's `GET /team/{team}/time_entries` honoring the `space_id` filter. That has not yet been confirmed against a live workspace. If ClickUp silently ignores `space_id`, the windowed fetch returns workspace-wide entries, which get upserted (and their tasks self-healed in) even for spaces this deployment doesn't track, and larger per-slice counts make the truncation guard (`PRUNE_SAFETY_MAX_ENTRIES`) trip more often, skipping pruning. Treat pruning from this endpoint as best-effort until the `space_id` probe is run — see `docs/superpowers/specs/2026-08-08-windowed-time-entry-reconcile-design.md` for the probe and fallback.

## Sprint / list catalog

`clickup_lists` is the sprint/list catalog behind `/reports/sprints*` and the `sprintStatus` filter on `/reports/tasks` and `/reports/time-entries`. It is kept in sync four ways:

- **Every manual space backfill** (`POST /admin/backfill`) — after the task/time-entry sync succeeds, `BackfillService` best-effort refreshes the list catalog for that space (failures here are logged only; they never fail the backfill itself).
- **Daily cron** — `SyncScheduler.syncListCatalogs()` runs at 03:00 (`@Cron('0 0 3 * * *')`, job `sync-list-catalog` on the `clickup-backfills` queue), one job per space that's configured and enabled in Settings. This is the backstop for lists that change out-of-band (renamed, moved, archived) without any task in them being touched.
- **`POST /admin/lists/sync`** — body `{ "spaceId": "3577824" }` to sync one space, or an empty body to sync every configured space (regardless of the enabled/disabled setting).
- **Opportunistically from task webhooks/sync** — every normalized task write also upserts its list's `name`/`folderId`/`folderName`/`spaceId`/`spaceName` into the catalog, so new lists show up promptly.

Only the backfill/cron/`POST /admin/lists/sync` paths are authoritative for the `archived` flag and the sprint `startDate`/`dueDate` — the opportunistic webhook path deliberately never writes those fields, so a list that's only ever touched via webhook won't have its archived/date fields populated until one of the other three paths runs.

**Bootstrap:** after deploying this feature, call `POST /admin/lists/sync` once to populate the catalog before the first 03:00 cron run.

## Assignee rates

Rates are managed in the dashboard (`/assignee-rates`) via `POST|PATCH|DELETE /admin/rates`. Changing a rate automatically triggers a scoped `recalculate-costs` job on the `maintenance` queue that recomputes costs for affected `clickup_time_entries`. There is no Google Sheets sync. For a manual full recalculation, call `POST /admin/rates/recalculate`.

## Production deployment

For a full server setup (Docker Compose + Caddy with automatic HTTPS on Ubuntu), see `docs/DEPLOYMENT.md`.

## Production checklist

- Use managed PostgreSQL/Neon and Redis.
- Set `CLICKUP_API_TOKEN` as a secret.
- Keep Grafana read-only credentials separate from app credentials.
- Enable HTTPS before setting the ClickUp webhook endpoint.
- Add alerting on failed jobs, missing rates, and stale checkpoints.

## Blue-green deployment

The production stack runs two web colors — `app-web-blue` and `app-web-green` —
behind Caddy. Caddy proxies to whichever color `active.conf` names. One color is
live; the other is the warm rollback target running the previous image.

### What a deploy does (push to `main`)

`.github/workflows/deploy.yml`: `quality` → `e2e` → `build-and-push` (GHCR image
tagged `:<sha>`) → `deploy`. The deploy job renders `.env` on the host from GitHub
secrets, syncs compose/Caddyfile/scripts, then runs `scripts/deploy.sh`, which:

1. Pulls the new image and ensures infra + Caddy are up.
2. Runs migrations once (`docker compose --profile tools run --rm migrate`) — before any cutover.
3. Detects the current live color from `active.conf` and targets the other.
4. Starts the target color on the new image.
5. Health-gates it on `/api/health` (30 × 2s). **If it never goes healthy, the
   deploy fails and traffic is NOT flipped — the old color keeps serving.**
6. Flips `active.conf` to the target and runs `caddy reload` (graceful).
7. Recreates the singleton `app-worker` on the new image, then prunes old images.

### Rolling back

- **Immediately after a bad deploy** (old color still running the previous image):
  on the host, in `DEPLOY_PATH`:
  ```bash
  # flip back to the other color
  printf 'reverse_proxy app-web-blue:3000\n' > active.conf   # or -green
  docker exec caddy caddy reload --config /etc/caddy/Caddyfile
  ```
  This is instant — no rebuild.
- **Later** (the idle color has since been overwritten): re-run the `Deploy`
  workflow via `workflow_dispatch` from the previous good commit, or
  `DEPLOY_PATH=<path> IMAGE_TAG=<previous-sha> bash scripts/deploy.sh` on the host (the image is
  still in GHCR).

### Migration discipline — expand/contract (REQUIRED)

Blue and green share one Postgres, and the old color must keep working against the
new schema during the rollback window. Therefore **every migration must be
backward-compatible**:

- **Expand**: add nullable columns, new tables, new indexes. Ship code that
  tolerates both old and new shapes.
- **Contract**: only in a *later* deploy, once no running color depends on the old
  shape, drop/rename.
- **Never** drop or rename a column in the same deploy that introduces its
  replacement — that breaks instant rollback. Rollback flips *code*, never
  un-migrates the schema.
