# Blue-Green CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Docker image and GitHub Actions pipeline from scratch and replace the in-place container recreate with a health-gated, zero-downtime blue-green deployment on a single Ubuntu host.

**Architecture:** One GHCR image per commit runs two ways via a `ROLE` env var — `web` (two blue/green instances behind Caddy) and `worker` (a singleton running BullMQ processors + cron). On push to `main`, CI runs quality + e2e gates, builds and pushes the image, then SSHes to the host to render `.env` from GitHub secrets, run a one-shot migration, start the idle color, health-gate it on `/api/health`, and flip Caddy to it via a graceful reload — keeping the old color warm for instant rollback.

**Tech Stack:** NestJS 11, Prisma 7, Docker multi-stage build, Docker Compose, Caddy 2, GitHub Actions, GHCR.

**Design spec:** `docs/superpowers/specs/2026-06-18-blue-green-cicd-design.md`

## Global Constraints

- Work happens on branch `feat/blue-green-cicd` (already checked out). Never commit to `main`.
- Node `>=22`; image base `node:22-alpine`.
- Registry is **GHCR**: `ghcr.io/rashedulhasansojib/clickup-sync`. Do not switch registries.
- All runtime secrets live in **GitHub repository secrets**; CI renders a fresh `.env` on the host each deploy. Never `echo` a secret value; never commit `.env`; `.env` stays excluded by `.dockerignore`.
- Frontend (`apps/web`) stays **baked into the backend image** (Option A) — no separate frontend artifact or container.
- Single Ubuntu host. Cutover is a **Caddy upstream flip**, not a load balancer.
- Migrations are **expand/contract / forward-only** — no destructive change in the same deploy that introduces its replacement.
- Migrations run **once, before cutover** — never in a container's startup command.
- Preserve the Dockerfile lessons: `npm ci` in build stage for `apps/web` workspace deps; `prisma generate` in build stage with the client copied to the runner; full `node_modules` in the runner (Prisma CLI is a devDep); build-time `DATABASE_URL` placeholder.
- Preserve formatting (Prettier) and existing test conventions (Jest, `*.spec.ts`, `--runInBand`).

---

### Task 1: `ROLE` web/worker split (app code)

Split background work out of the web process so the cron scheduler and BullMQ processors run only in the `worker` role. This is the load-bearing app change: in blue-green the old web color stays alive for the rollback window, so cron/processors must NOT run there or backfills double-fire.

**Files:**
- Create: `src/config/role.ts`
- Create: `src/config/role.spec.ts`
- Modify: `src/config/env.validation.ts:4-38` (add `ROLE` to schema)
- Modify: `src/app.module.ts` (gate `ScheduleModule` + `WorkersModule` by role)
- Modify: `src/main.ts:16-60` (worker bootstrap branch — init without HTTP listen)

**Interfaces:**
- Produces:
  - `getRole(): 'web' | 'worker'` — reads `process.env.ROLE`, defaults to `'web'`, lowercased.
  - `isWorker(): boolean` — `getRole() === 'worker'`.
  - `isWeb(): boolean` — `getRole() === 'web'`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test for the role helper**

Create `src/config/role.spec.ts`:

```ts
import { getRole, isWorker, isWeb } from './role';

describe('role helper', () => {
  const original = process.env.ROLE;
  afterEach(() => {
    if (original === undefined) delete process.env.ROLE;
    else process.env.ROLE = original;
  });

  it('defaults to web when ROLE is unset', () => {
    delete process.env.ROLE;
    expect(getRole()).toBe('web');
    expect(isWeb()).toBe(true);
    expect(isWorker()).toBe(false);
  });

  it('returns worker when ROLE=worker', () => {
    process.env.ROLE = 'worker';
    expect(getRole()).toBe('worker');
    expect(isWorker()).toBe(true);
    expect(isWeb()).toBe(false);
  });

  it('is case-insensitive and trims whitespace', () => {
    process.env.ROLE = '  WORKER ';
    expect(getRole()).toBe('worker');
  });

  it('falls back to web for an unknown value', () => {
    process.env.ROLE = 'banana';
    expect(getRole()).toBe('web');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- role.spec`
Expected: FAIL — `Cannot find module './role'`.

- [ ] **Step 3: Implement the role helper**

Create `src/config/role.ts`:

```ts
export type AppRole = 'web' | 'worker';

/**
 * Which process role this instance runs as. `web` serves HTTP + the SPA and
 * enqueues jobs; `worker` runs BullMQ processors + the cron scheduler. The
 * split exists so blue-green's warm old web color does NOT also run cron
 * (which would double-fire scheduled backfills). Defaults to `web`.
 */
export function getRole(): AppRole {
  const raw = (process.env.ROLE ?? '').trim().toLowerCase();
  return raw === 'worker' ? 'worker' : 'web';
}

export function isWorker(): boolean {
  return getRole() === 'worker';
}

export function isWeb(): boolean {
  return getRole() === 'web';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- role.spec`
Expected: PASS (4 tests).

- [ ] **Step 5: Add `ROLE` to env validation**

In `src/config/env.validation.ts`, add this line to the `z.object({...})` schema (right after the `PORT` line at `:6`):

```ts
  ROLE: z.enum(['web', 'worker']).default('web'),
```

- [ ] **Step 6: Gate ScheduleModule + WorkersModule by role in `app.module.ts`**

Replace the contents of `src/app.module.ts` with:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule } from '@nestjs/throttler';
import { join } from 'path';
import { validateEnv } from './config/env.validation';
import { buildBullConnection } from './config/connection.config';
import { isWorker } from './config/role';
import { DatabaseModule } from './database/database.module';
import { SettingsModule } from './settings/settings.module';
import { ClickupModule } from './clickup/clickup.module';
import { QueuesModule } from './queues/queues.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { TasksModule } from './tasks/tasks.module';
import { TimeEntriesModule } from './time-entries/time-entries.module';
import { RatesModule } from './rates/rates.module';
import { SyncModule } from './sync/sync.module';
import { WorkersModule } from './workers/workers.module';
import { AdminModule } from './admin/admin.module';
import { BudgetsModule } from './budgets/budgets.module';
import { ReportsModule } from './reports/reports.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';

// Background work (BullMQ processors + cron) only runs in the worker role. In
// the web role these are omitted so blue-green's warm old web color can't
// double-fire scheduled jobs. Job *producers* (controllers/QueuesModule) stay
// in both roles; only consumers (WorkersModule) and the scheduler move out.
const worker = isWorker();

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'apps', 'web', 'dist'),
      // path-to-regexp v8 (pulled in via Express 5 / serve-static 5) rejects the
      // old `(.*)` capture-group syntax — it threw on every request, 500-ing all
      // API routes. The v8 equivalent is a named wildcard. is-route-excluded
      // appends a trailing `/`, so `/<prefix>/*splat` matches both the bare
      // prefix and any sub-path.
      exclude: ['/api/*splat', '/docs/*splat', '/webhooks/*splat', '/admin/*splat', '/reports/*splat'],
    }),
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ...(worker ? [ScheduleModule.forRoot()] : []),
    BullModule.forRootAsync({
      useFactory: () => ({ connection: buildBullConnection(process.env.REDIS_URL ?? '') }),
    }),
    DatabaseModule,
    SettingsModule,
    ClickupModule,
    QueuesModule,
    WebhooksModule,
    TasksModule,
    TimeEntriesModule,
    RatesModule,
    SyncModule,
    ...(worker ? [WorkersModule] : []),
    AdminModule,
    BudgetsModule,
    ReportsModule,
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 5 }]),
    AuthModule,
    HealthModule,
  ],
})
export class AppModule {}
```

Note: `@Cron` decorators in `SyncModule`/`SessionCleanupService` stay loaded but are inert without `ScheduleModule.forRoot()` — gating the module out is sufficient to disable cron in the web role.

- [ ] **Step 7: Add the worker bootstrap branch in `main.ts`**

In `src/main.ts`, add this import near the other imports (after line 14):

```ts
import { getRole } from './config/role';
```

Then, at the very top of the `bootstrap()` function body (immediately after the `async function bootstrap() {` line at `:16`), insert the worker branch:

```ts
  // Worker role: boot the DI container so BullMQ processors + cron start, but
  // do NOT open an HTTP port. enableShutdownHooks() lets SIGTERM drain active
  // jobs cleanly on deploy. No helmet/cors/swagger/listen — there is no HTTP.
  if (getRole() === 'worker') {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });
    app.enableShutdownHooks();
    await app.init();
    return;
  }
```

The rest of `bootstrap()` (the existing web path) is unchanged.

- [ ] **Step 8: Verify the build and full test suite pass in both roles**

Run: `npm run build`
Expected: completes, no TS errors.

Run: `npm test`
Expected: all suites pass (including the new `role.spec`).

- [ ] **Step 9: Smoke-test worker boot locally (no HTTP)**

Run: `npm run dev:deps` (starts local Postgres + Redis if not already up), then:
`ROLE=worker DATABASE_URL=postgresql://clickup:clickup@localhost:5433/clickup_sync?schema=public REDIS_URL=redis://localhost:6379 node dist/main.js`
Expected: logs show Nest application started, BullMQ workers registered, **no** "Nest application listening on" HTTP line. Ctrl-C exits cleanly. (If `dist` is stale, run `npm run build` first.)

- [ ] **Step 10: Commit**

```bash
git add src/config/role.ts src/config/role.spec.ts src/config/env.validation.ts src/app.module.ts src/main.ts
git commit -m "feat(app): ROLE web/worker split for blue-green deploys

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Rebuild the Dockerfile

Multi-stage build producing one image that runs as web (default) or worker (via `ROLE`). Migration is removed from startup. Preserves the encoded lessons from the current file.

**Files:**
- Modify: `Dockerfile` (full rewrite)

**Interfaces:**
- Produces: an image whose default `CMD` runs `npm run start:prod` (`node dist/main.js`), reads `ROLE` from env, exposes `3000`, and contains the generated Prisma client + full `node_modules` + built SPA.

- [ ] **Step 1: Write the new Dockerfile**

Replace the contents of `Dockerfile` with:

```dockerfile
# syntax=docker/dockerfile:1

# ── build ─────────────────────────────────────────────────────────────────────
# Install ALL deps (incl. dev + workspace deps), generate the Prisma client,
# compile the backend to dist/, and build the dashboard to apps/web/dist/.
FROM node:22-alpine AS build
WORKDIR /app
# Copy manifests first so `npm ci` is cached until dependencies change.
COPY package*.json ./
COPY apps/web/package.json ./apps/web/
RUN npm ci
COPY . .
# Build-time only: prisma.config.ts resolves env('DATABASE_URL'). `prisma generate`
# never connects, but the var must resolve. The real URL is injected at runtime
# and does not leak from this stage into the runner.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"
RUN npm run prisma:generate \
 && npm run build \
 && npm run build:web

# ── runner ────────────────────────────────────────────────────────────────────
# Full node_modules are kept on purpose: `prisma migrate deploy` (run as a
# one-shot deploy step, not here) and the prisma.config.ts loader are
# devDependencies. node_modules is copied from `build` so it includes the
# generated Prisma client.
#
# NOTE: migrations are intentionally NOT in CMD. With blue-green both colors
# share one DB; migrations run once via the `migrate` compose service before
# cutover. The same image runs as web (default) or worker (ROLE=worker).
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY package*.json ./
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
```

- [ ] **Step 2: Build the image locally to verify**

Run: `docker build -t clickup-sync:plan-test .`
Expected: build succeeds through both stages; final line shows the image tagged. (Requires Docker running.)

- [ ] **Step 3: Verify the built image has the Prisma client and SPA**

Run: `docker run --rm clickup-sync:plan-test sh -c "ls dist/main.js apps/web/dist/index.html && ls node_modules/.prisma/client >/dev/null && echo OK"`
Expected: prints the two paths and `OK`.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "build: rebuild Dockerfile for web/worker image, drop startup migration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Caddy config — import the active-color snippet

Make Caddy proxy to whichever color `active.conf` names, so the deploy can flip traffic with a file rewrite + graceful reload.

**Files:**
- Modify: `Caddyfile`
- Create: `active.conf`

**Interfaces:**
- Produces: `Caddyfile` that does `import /etc/caddy/active.conf`; `active.conf` contains exactly one `reverse_proxy app-web-<color>:3000` line, mounted at `/etc/caddy/active.conf` in the caddy container (wired in Task 4).

- [ ] **Step 1: Rewrite the Caddyfile**

Replace the contents of `Caddyfile` with:

```caddyfile
# Caddy reverse proxy with automatic HTTPS (Let's Encrypt).
# DOMAIN is injected from .env via docker-compose.prod.yml.
#
# Blue-green: the upstream is NOT hardcoded here. It lives in active.conf
# (mounted at /etc/caddy/active.conf), which holds a single line:
#     reverse_proxy app-web-blue:3000     (or app-web-green:3000)
# The deploy script rewrites active.conf and runs `caddy reload` to flip
# traffic gracefully (in-flight requests drain; zero dropped connections).
{$DOMAIN} {
	encode gzip
	import /etc/caddy/active.conf
}
```

- [ ] **Step 2: Create the seed active-color file**

Create `active.conf`:

```caddyfile
reverse_proxy app-web-blue:3000
```

- [ ] **Step 3: Validate Caddy can parse the config**

Run: `docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$PWD/active.conf:/etc/caddy/active.conf:ro" -e DOMAIN=example.com caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile`
Expected: `Valid configuration`. (Requires Docker.)

- [ ] **Step 4: Commit**

```bash
git add Caddyfile active.conf
git commit -m "build(caddy): import active-color snippet for blue-green flip

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Rebuild `docker-compose.prod.yml`

Define blue/green web services, the singleton worker, the one-shot migrate service, and infra. All app services share one image by `IMAGE_TAG`.

**Files:**
- Modify: `docker-compose.prod.yml` (full rewrite)

**Interfaces:**
- Consumes: image `ghcr.io/rashedulhasansojib/clickup-sync:${IMAGE_TAG}`; env file `.env`; `active.conf` from Task 3.
- Produces: services `postgres`, `redis`, `app-web-blue`, `app-web-green`, `app-worker`, `migrate` (profile `tools`), `caddy`.

- [ ] **Step 1: Write the new compose file**

Replace the contents of `docker-compose.prod.yml` with:

```yaml
# Production stack for a single Ubuntu host — blue-green.
#
# Topology:
#   app-web-blue / app-web-green : two HTTP+SPA colors (ROLE=web). Caddy points
#                                  at one; the other is the warm rollback target.
#   app-worker                   : singleton BullMQ + cron (ROLE=worker).
#   migrate                      : one-shot `prisma migrate deploy` (profile tools);
#                                  run explicitly before cutover, never on `up`.
#   postgres / redis             : shared state, internal-only.
#   caddy                        : TLS + reverse proxy; flips via active.conf reload.
#
# Postgres and Redis are NOT published to the host (Docker-published ports bypass
# ufw). Only Caddy publishes 80/443. The deploy is orchestrated by scripts/deploy.sh.
#
# Variables read from ./.env (rendered by CI from GitHub secrets):
#   DOMAIN, POSTGRES_PASSWORD, IMAGE_TAG (defaults to latest for manual use).

x-app: &app-common
  image: ghcr.io/rashedulhasansojib/clickup-sync:${IMAGE_TAG:-latest}
  restart: unless-stopped
  env_file: .env
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy

services:
  postgres:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: clickup_sync
      POSTGRES_USER: clickup
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
    expose:
      - "5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U clickup -d clickup_sync"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:8-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    expose:
      - "6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  app-web-blue:
    <<: *app-common
    environment:
      ROLE: web
    expose:
      - "3000"
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/api/health || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 40s

  app-web-green:
    <<: *app-common
    environment:
      ROLE: web
    expose:
      - "3000"
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/api/health || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 40s

  app-worker:
    <<: *app-common
    environment:
      ROLE: worker

  migrate:
    <<: *app-common
    restart: "no"
    profiles: ["tools"]
    command: ["npm", "run", "prisma:deploy"]

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      DOMAIN: ${DOMAIN:?set DOMAIN in .env}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./active.conf:/etc/caddy/active.conf:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  postgres_data:
  redis_data:
  caddy_data:
  caddy_config:
```

Note: `app-worker`'s `depends_on` inherits the `service_healthy` conditions from the `&app-common` anchor (postgres + redis). The `migrate` service overrides `restart: "no"` so a successful one-shot run isn't restarted.

- [ ] **Step 2: Validate the compose file parses and resolves**

Run: `DOMAIN=example.com POSTGRES_PASSWORD=x IMAGE_TAG=test docker compose -f docker-compose.prod.yml config >/dev/null && echo OK`
Expected: prints `OK` with no errors (the `&app-common` anchor expands into all four app services; `migrate` shows `profiles: [tools]`).

- [ ] **Step 3: Confirm the migrate service is not started by a plain `up`**

Run: `DOMAIN=example.com POSTGRES_PASSWORD=x IMAGE_TAG=test docker compose -f docker-compose.prod.yml config --services | sort`
Expected: lists `app-web-blue app-web-green app-worker caddy postgres redis` — note `migrate` is absent from the default service set because it is behind the `tools` profile.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "build(compose): blue/green web, singleton worker, one-shot migrate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Host-side deploy orchestration script

The script that runs on the Ubuntu host: pull, migrate, start the idle color, health-gate, flip Caddy, update the worker, prune. Keeping it in the repo (not inline YAML) makes it reviewable and testable.

**Files:**
- Create: `scripts/deploy.sh`

**Interfaces:**
- Consumes: env vars `DEPLOY_PATH` (working dir on host) and `IMAGE_TAG` (commit SHA). Run from the deploy step over SSH after `.env`, `docker-compose.prod.yml`, `Caddyfile`, `active.conf`, and `scripts/` are present on the host.
- Produces: a flipped, health-gated deployment; exits non-zero without flipping if the new color fails health.

- [ ] **Step 1: Write the deploy script**

Create `scripts/deploy.sh`:

```bash
#!/usr/bin/env bash
# Blue-green deploy orchestration for the single-host stack. Run on the host by
# the GitHub Actions deploy job over SSH. Requires DEPLOY_PATH and IMAGE_TAG.
#
#   1. pull the new image            5. start the idle (target) color
#   2. ensure infra + caddy up       6. health-gate the target on /api/health
#   3. one-shot migration            7. flip active.conf + graceful caddy reload
#   4. detect current live color     8. update the worker, then prune old images
#
# If the target color fails its health check, traffic is NOT flipped and the
# script exits non-zero — the old color keeps serving.
set -euo pipefail

: "${DEPLOY_PATH:?DEPLOY_PATH is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
cd "$DEPLOY_PATH"

COMPOSE="docker compose -f docker-compose.prod.yml"
export IMAGE_TAG

echo "==> Pulling image tag: $IMAGE_TAG"
$COMPOSE pull app-web-blue app-web-green app-worker

echo "==> Ensuring infra + proxy are up"
$COMPOSE up -d postgres redis caddy

echo "==> Running one-shot migration"
$COMPOSE run --rm migrate

# Detect the live color from the mounted active.conf; default to blue on first run.
CURRENT="$(grep -oE 'app-web-(blue|green)' active.conf | head -1 | sed 's/app-web-//' || true)"
CURRENT="${CURRENT:-blue}"
if [ "$CURRENT" = "blue" ]; then TARGET="green"; else TARGET="blue"; fi
echo "==> Current live color: $CURRENT  ->  deploying to: $TARGET"

echo "==> Starting target color: app-web-$TARGET"
$COMPOSE up -d --force-recreate "app-web-$TARGET"

echo "==> Health-gating app-web-$TARGET on /api/health"
HEALTHY=0
for i in $(seq 1 30); do
  if docker exec caddy wget -qO- "http://app-web-$TARGET:3000/api/health" >/dev/null 2>&1; then
    HEALTHY=1
    echo "    healthy after ${i} attempt(s)"
    break
  fi
  sleep 2
done
if [ "$HEALTHY" != "1" ]; then
  echo "!! app-web-$TARGET failed health check; NOT flipping. Old color ($CURRENT) still live." >&2
  exit 1
fi

echo "==> Flipping traffic to app-web-$TARGET"
printf 'reverse_proxy app-web-%s:3000\n' "$TARGET" > active.conf
docker exec caddy caddy reload --config /etc/caddy/Caddyfile

echo "==> Updating worker (singleton, recreate-in-place)"
$COMPOSE up -d --force-recreate app-worker

echo "==> Pruning images older than 7 days"
docker image prune -af --filter "until=168h" || true

echo "==> Deploy complete. Live color: $TARGET"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/deploy.sh`

- [ ] **Step 3: Verify the script is syntactically valid**

Run: `bash -n scripts/deploy.sh && echo OK`
Expected: prints `OK` (no syntax errors).

- [ ] **Step 4: Lint with shellcheck if available**

Run: `command -v shellcheck >/dev/null && shellcheck scripts/deploy.sh || echo "shellcheck not installed; skipped"`
Expected: either no findings, or the skip message. Fix any error-level findings.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy.sh
git commit -m "build(deploy): host-side blue-green orchestration script

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Rebuild the GitHub Actions workflow

Quality gate → e2e gate → build-and-push to GHCR → deploy (render `.env` from secrets, sync files, run `scripts/deploy.sh`).

**Files:**
- Modify: `.github/workflows/deploy.yml` (full rewrite)

**Interfaces:**
- Consumes: GitHub secrets — deploy creds `SSH_HOST`, `SSH_USER`, `SSH_KEY`, `SSH_PORT`, `DEPLOY_PATH`; runtime secrets `DOMAIN`, `DATABASE_URL`, `POSTGRES_PASSWORD`, `REDIS_URL`, `CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID`, `CLICKUP_WEBHOOK_SECRET`, `APP_ENCRYPTION_KEY`, `ADMIN_API_KEY`, `ALLOWED_ORIGINS`, `APP_BASE_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.
- Produces: a deployed blue-green release on push to `main`.

- [ ] **Step 1: Write the workflow**

Replace the contents of `.github/workflows/deploy.yml` with:

```yaml
name: Deploy

# Push to main → quality + e2e gates → build & push image to GHCR → blue-green deploy.
on:
  push:
    branches: [main]
  workflow_dispatch: {}

# Never run two deploys to the same host at once; let an in-flight deploy finish.
concurrency:
  group: deploy-production
  cancel-in-progress: false

env:
  IMAGE: ghcr.io/rashedulhasansojib/clickup-sync

jobs:
  # ── 1. Quality gate (infra-free unit specs) ─────────────────────────────────
  quality:
    runs-on: ubuntu-latest
    env:
      DATABASE_URL: postgresql://user:pass@localhost:5432/db?schema=public
      REDIS_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run prisma:generate
      - run: npm run lint
      - run: npm run test
      - run: npm run build
      - run: npm run build:web

  # ── 1b. E2E gate (real Postgres + Redis) ────────────────────────────────────
  e2e:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: clickup
          POSTGRES_PASSWORD: clickup
          POSTGRES_DB: clickup_sync
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U clickup"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
      redis:
        image: redis:7
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      NODE_ENV: test
      DATABASE_URL: postgresql://clickup:clickup@localhost:5432/clickup_sync?schema=public
      REDIS_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run prisma:generate
      - run: npm run prisma:deploy
      - run: npm run test:e2e

  # ── 2. Build the image and push to GHCR (the artifact) ──────────────────────
  build-and-push:
    needs: [quality, e2e]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ${{ env.IMAGE }}:latest
            ${{ env.IMAGE }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  # ── 3. Blue-green deploy ────────────────────────────────────────────────────
  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: read
    steps:
      - uses: actions/checkout@v4

      # Sync deploy files to the host. The server keeps its own .env (rendered
      # in the next step) and its own active.conf state once deployed — but we
      # ship active.conf too so the very first deploy has a seed file.
      - name: Copy deploy files to server
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_KEY }}
          port: ${{ secrets.SSH_PORT }}
          source: "docker-compose.prod.yml,Caddyfile,scripts/deploy.sh"
          target: ${{ secrets.DEPLOY_PATH }}

      # Seed active.conf ONLY if the host doesn't already have one (don't clobber
      # the live color on subsequent deploys).
      - name: Seed active.conf on first deploy
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_KEY }}
          port: ${{ secrets.SSH_PORT }}
          script: |
            set -euo pipefail
            cd "${{ secrets.DEPLOY_PATH }}"
            if [ ! -f active.conf ]; then
              echo "reverse_proxy app-web-blue:3000" > active.conf
              echo "seeded active.conf -> blue"
            fi
            chmod +x scripts/deploy.sh

      # Render .env on the host from GitHub secrets (atomic: write tmp, then mv).
      # Values arrive via the envs: list so they are masked in logs and never
      # appear as literal text in this YAML.
      - name: Render .env from secrets
        uses: appleboy/ssh-action@v1
        env:
          DOMAIN: ${{ secrets.DOMAIN }}
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          POSTGRES_PASSWORD: ${{ secrets.POSTGRES_PASSWORD }}
          REDIS_URL: ${{ secrets.REDIS_URL }}
          CLICKUP_API_TOKEN: ${{ secrets.CLICKUP_API_TOKEN }}
          CLICKUP_TEAM_ID: ${{ secrets.CLICKUP_TEAM_ID }}
          CLICKUP_WEBHOOK_SECRET: ${{ secrets.CLICKUP_WEBHOOK_SECRET }}
          APP_ENCRYPTION_KEY: ${{ secrets.APP_ENCRYPTION_KEY }}
          ADMIN_API_KEY: ${{ secrets.ADMIN_API_KEY }}
          ALLOWED_ORIGINS: ${{ secrets.ALLOWED_ORIGINS }}
          APP_BASE_URL: ${{ secrets.APP_BASE_URL }}
          SMTP_HOST: ${{ secrets.SMTP_HOST }}
          SMTP_PORT: ${{ secrets.SMTP_PORT }}
          SMTP_USER: ${{ secrets.SMTP_USER }}
          SMTP_PASS: ${{ secrets.SMTP_PASS }}
          MAIL_FROM: ${{ secrets.MAIL_FROM }}
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_KEY }}
          port: ${{ secrets.SSH_PORT }}
          envs: DOMAIN,DATABASE_URL,POSTGRES_PASSWORD,REDIS_URL,CLICKUP_API_TOKEN,CLICKUP_TEAM_ID,CLICKUP_WEBHOOK_SECRET,APP_ENCRYPTION_KEY,ADMIN_API_KEY,ALLOWED_ORIGINS,APP_BASE_URL,SMTP_HOST,SMTP_PORT,SMTP_USER,SMTP_PASS,MAIL_FROM
          script: |
            set -euo pipefail
            cd "${{ secrets.DEPLOY_PATH }}"
            umask 077
            cat > .env.tmp <<EOF
            NODE_ENV=production
            DOMAIN=${DOMAIN}
            DATABASE_URL=${DATABASE_URL}
            POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
            REDIS_URL=${REDIS_URL}
            CLICKUP_API_TOKEN=${CLICKUP_API_TOKEN}
            CLICKUP_TEAM_ID=${CLICKUP_TEAM_ID}
            CLICKUP_WEBHOOK_SECRET=${CLICKUP_WEBHOOK_SECRET}
            APP_ENCRYPTION_KEY=${APP_ENCRYPTION_KEY}
            ADMIN_API_KEY=${ADMIN_API_KEY}
            ALLOWED_ORIGINS=${ALLOWED_ORIGINS}
            APP_BASE_URL=${APP_BASE_URL}
            SMTP_HOST=${SMTP_HOST}
            SMTP_PORT=${SMTP_PORT}
            SMTP_USER=${SMTP_USER}
            SMTP_PASS=${SMTP_PASS}
            MAIL_FROM=${MAIL_FROM}
            EOF
            mv .env.tmp .env

      - name: Blue-green deploy
        uses: appleboy/ssh-action@v1
        env:
          IMAGE_TAG: ${{ github.sha }}
          GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GHCR_USER: ${{ github.actor }}
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_KEY }}
          port: ${{ secrets.SSH_PORT }}
          envs: IMAGE_TAG,GHCR_TOKEN,GHCR_USER
          script: |
            set -euo pipefail
            cd "${{ secrets.DEPLOY_PATH }}"
            echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
            export DEPLOY_PATH="${{ secrets.DEPLOY_PATH }}"
            export IMAGE_TAG="$IMAGE_TAG"
            bash scripts/deploy.sh
            docker logout ghcr.io
```

- [ ] **Step 2: Validate the workflow YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml')); print('OK')"`
Expected: prints `OK`.

- [ ] **Step 3: Lint with actionlint if available**

Run: `command -v actionlint >/dev/null && actionlint .github/workflows/deploy.yml || echo "actionlint not installed; skipped"`
Expected: no findings, or the skip message. Fix any reported errors.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: blue-green deploy workflow, render .env from GitHub secrets

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Operations runbook

Document how blue-green works, how to roll back, and the expand/contract migration rule so future migrations don't break the rollback guarantee.

**Files:**
- Modify: `docs/OPERATIONS.md` (append a "Blue-green deployment" section)
- Modify: `.env.example` (add `ROLE` with a comment)

**Interfaces:**
- Consumes: the behavior built in Tasks 1–6.
- Produces: operator documentation. No code.

- [ ] **Step 1: Add `ROLE` to `.env.example`**

In `.env.example`, add near the top (after any `NODE_ENV`/`PORT` lines; if none, at the top of the file):

```env
# Process role for this instance: `web` (HTTP + SPA + job producers) or
# `worker` (BullMQ processors + cron scheduler). Compose sets this per service;
# defaults to `web` when unset. Only the worker role runs cron — keep it a singleton.
ROLE=web
```

- [ ] **Step 2: Append the runbook section to `docs/OPERATIONS.md`**

Append:

```markdown
## Blue-green deployment

The production stack runs two web colors — `app-web-blue` and `app-web-green` —
behind Caddy. Caddy proxies to whichever color `active.conf` names. One color is
live; the other is the warm rollback target running the previous image.

### What a deploy does (push to `main`)

`.github/workflows/deploy.yml`: `quality` → `e2e` → `build-and-push` (GHCR image
tagged `:<sha>`) → `deploy`. The deploy job renders `.env` on the host from GitHub
secrets, syncs compose/Caddyfile/scripts, then runs `scripts/deploy.sh`, which:

1. Pulls the new image and ensures infra + Caddy are up.
2. Runs migrations once (`docker compose run --rm migrate`) — before any cutover.
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
  `IMAGE_TAG=<previous-sha> bash scripts/deploy.sh` on the host (the image is
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
```

- [ ] **Step 3: Verify the docs render and links are intact**

Run: `grep -n "Blue-green deployment" docs/OPERATIONS.md && grep -n "^ROLE=web" .env.example`
Expected: both matches print.

- [ ] **Step 4: Commit**

```bash
git add docs/OPERATIONS.md .env.example
git commit -m "docs(ops): blue-green runbook + expand/contract migration rule

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- **Docker-dependent steps** (Tasks 2–4 build/validate steps) need a running Docker daemon. If unavailable in the execution environment, mark those verification steps blocked and note it — do not skip silently.
- **`actionlint`/`shellcheck`** are optional linters; the steps degrade gracefully if absent.
- The pipeline is only exercised end-to-end when this branch merges to `main` and pushes. Pre-merge, verification is limited to local builds, `compose config`, `caddy validate`, `bash -n`, and YAML parse — all included above.
- The very first real deploy starts blue (seed `active.conf`), then flips to green; both colors come into existence over the first one or two deploys. This is expected.
