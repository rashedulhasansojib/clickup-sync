# Blue-Green CI/CD Redesign — Design

**Date:** 2026-06-18
**Status:** Approved for spec review
**Scope:** Rebuild the Docker image and the GitHub Actions pipeline from scratch, and replace the in-place container recreate with a proper artifact-based blue-green deployment on a single Ubuntu host. Work happens on a feature branch; the pipeline triggers on push to `main` after merge.

---

## 1. Problem statement

The platform is already containerized and already ships an artifact-based pipeline (GHCR image tagged by commit SHA, deployed over SSH on push to `main`). The genuine gap is the deploy step itself: today it runs

```
docker compose pull api && docker compose up -d
```

which recreates the single `api` container **in place** — a brief downtime window, no health-gated cutover, and no instant rollback. That is a recreate-in-place deploy, not blue-green.

This project replaces that with a **health-gated, zero-downtime blue-green cutover with a warm rollback target**, and rebuilds the Dockerfile and workflow cleanly around the new topology — while preserving the non-obvious lessons already encoded in the current files.

---

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Frontend packaging | **Option A** — SPA stays baked into the backend image, served by Nest `ServeStaticModule`. Frontend + API version and flip together. |
| Image registry | **GHCR** — no extra secrets (`GITHUB_TOKEN`), free private images. |
| Runtime secrets | **All in GitHub repository secrets.** CI writes a fresh `.env` onto the host each deploy. |
| Worker/scheduler | **Split out of the web process.** Same image, two run modes via `ROLE` env: `web` (blue-green ×2) and `worker` (singleton). |
| Cutover mechanism | **Caddy `active.conf` snippet flip + graceful `caddy reload`**, health-gated on `/api/health`. |
| Migrations | **One-shot step before cutover.** Removed from container startup. |
| Schema policy | **Forward-only / expand-contract.** Code rollback is instant; schema is not un-migrated. |
| Host model | **Single Ubuntu host**, Docker Compose + Caddy. No cloud load balancer. |
| Trigger | Push to `main` (+ `workflow_dispatch`). |

---

## 3. Container topology

| Container | Runs | Blue-green? | Rationale |
|---|---|---|---|
| `app-web-blue` / `app-web-green` | NestJS API + baked-in SPA, `ROLE=web` | ✅ two instances | User-facing; needs zero-downtime cutover. Idle color stays warm as rollback target. |
| `app-worker` | BullMQ processors + cron scheduler, `ROLE=worker` | ❌ single instance, recreate-in-place | Background work; a few seconds gap is fine, jobs are durable in Redis. Must be a singleton (see §4). |
| `postgres` | Database | ❌ shared state | Both colors share one DB. |
| `redis` | Queue + sessions | ❌ shared state | Both colors share one Redis. |
| `caddy` | TLS + reverse proxy; flips traffic blue↔green | ❌ | The cutover mechanism. |

Both web colors run continuously. A deploy overwrites the **idle** color with the new image, health-checks it, then flips Caddy. The now-idle color keeps the previous version for instant rollback until the next deploy replaces it.

---

## 4. Required app-code change (`ROLE` gating)

Blue-green keeps the **old color alive for the entire rollback window**, not just a blip. If workers + `@nestjs/schedule` cron ran in-process on every web color, the result would be **sustained double-fired cron (double-enqueued backfills)** and old-code job processing during rollback.

Therefore `app.module.ts` must gate background work behind `ROLE`:

- `ROLE=web` (default for web colors): register HTTP, Swagger, `ServeStaticModule`. **Do not** register `ScheduleModule` or the `@Processor` worker classes.
- `ROLE=worker`: register `ScheduleModule` + processors. **Do not** start the HTTP listener (or start it only for a minimal health/metrics port — see §7).

The thing that MUST be a singleton is the **cron scheduler** (double-fire is the real hazard). Gating the processors too is cleaner because it prevents cross-version job processing during rollback. Queue *producers* (controllers that enqueue jobs) stay in the web role; only *consumers* (processors) and the scheduler move to the worker role.

This is a genuine NestJS change and is in scope for this project, not just infra.

---

## 5. The artifact

- One Docker image per commit, built once, pushed to GHCR tagged `:<sha>` and `:latest`.
- The **same image** runs as web (`ROLE=web`) and worker (`ROLE=worker`) — one artifact, two commands.
- The SPA is built into the image at build time (`build:web`) — no separate frontend artifact.

### Dockerfile (rebuilt, lessons preserved)

Multi-stage `build` → `runner`, carrying forward the current file's hard-won decisions:

- `npm ci` in the build stage so `apps/web` workspace deps exist for `build:web` (no reliance on hoisting).
- `prisma generate` runs in the build stage and the generated client is copied into the runner — otherwise the container boots with no client.
- Full `node_modules` kept in the runner on purpose: `prisma migrate deploy` and the `prisma.config.ts` loader are devDependencies.
- Build-time `DATABASE_URL` placeholder so `prisma.config.ts` resolves (it never connects at build time); the real URL is injected at runtime.
- The default `CMD` runs the web role; the worker service overrides the command. **Migrations are no longer in the startup command** (moved to §6 step 3).

---

## 6. Deploy sequence (on the host, orchestrated by the workflow)

```
quality gate (lint, unit tests, build, build:web)   ─┐
e2e gate (real PG + Redis, prisma deploy, e2e)       ─┴─► both must pass
        │
build-and-push ─► image:<sha> + :latest to GHCR      (the artifact)
        │
deploy (SSH to host):
  1. write fresh .env from GitHub secrets (atomic: write .env.tmp, then mv)
  2. sync docker-compose.prod.yml + Caddyfile + scripts to host (server keeps its own state)
  3. docker login ghcr + docker compose pull (image:<sha> via IMAGE_TAG)
  4. ONE-SHOT migration:
       docker compose run --rm migrate     # runs `prisma migrate deploy`, must exit 0
  5. read active.conf → CURRENT color; TARGET = the other color
  6. docker compose up -d app-web-<TARGET>     # idle color, new image
  7. HEALTH-GATE: poll app-web-<TARGET>:3000/api/health until healthy or timeout
       → on failure: abort, do NOT flip, exit non-zero (old color still serving)
  8. FLIP: rewrite active.conf → <TARGET>; docker exec caddy caddy reload
  9. docker compose up -d app-worker          # recreate worker on new image (singleton)
 10. docker image prune -af --filter "until=168h"
```

Properties:
- Migration runs **once**, **before** any traffic moves.
- If the new color fails health check, **traffic never moves** and the deploy fails loudly.
- Worker is updated only after the web color is confirmed healthy and live.
- `concurrency: deploy-production, cancel-in-progress: false` — never two deploys at once.

### The migration one-shot

A dedicated compose service (e.g. `migrate`, `profiles: ["tools"]` so it never starts with `up`) built from the same image, command `npm run prisma:deploy`, on the compose network so it reaches `postgres`. Invoked explicitly with `docker compose run --rm migrate`. Idempotent (`migrate deploy`).

---

## 7. Health gating

- Web colors expose `/api/health` (existing `@nestjs/terminus` endpoint).
- The deploy script polls the **target** color's health endpoint on the internal compose network (via `docker exec caddy wget -qO- http://app-web-<TARGET>:3000/api/health`, or an equivalent one-shot curl container) with a bounded retry loop (e.g. ~30 attempts × 2s) before flipping.
- Compose `healthcheck` blocks remain on each service for `docker compose` visibility, but the **flip decision** is driven by the explicit script poll, not by compose alone.
- Worker role: either no HTTP server, or a minimal liveness check; it is not health-gated for cutover because it is a singleton recreate.

---

## 8. Cutover & rollback model

**Cutover:** `Caddyfile` does `import /etc/caddy/active.conf`; `active.conf` holds exactly one line, `reverse_proxy app-web-<color>:3000`. Flipping = rewrite that file + `docker exec caddy caddy reload` (graceful; in-flight requests drain, zero dropped connections). The file is the single source of truth for the live color and survives reboots.

**Rollback:**
- **Within/just after a deploy:** rewrite `active.conf` back to the previous color + reload — instant, because the old color is still running the previous version.
- **After the next deploy has overwritten the idle color:** redeploy the previous SHA from GHCR (`workflow_dispatch` with a tag input, or re-run the old commit's deploy).
- **Schema is forward-only:** rollback flips *code*, never un-migrates. This is why migrations must be expand/contract (§9).

---

## 9. Migration discipline (expand/contract)

Blue and green share one Postgres, and the old color must keep working against the new schema during the rollback window. Therefore migrations are **backward-compatible only**:

- **Expand** first: add nullable columns / new tables / new indexes; deploy code that writes both old and new where needed.
- **Contract** later, in a separate deploy, once no running color depends on the old shape: drop/rename.
- A destructive change (`DROP COLUMN`, rename) in the same deploy that introduces its replacement **breaks the rollback guarantee** and is disallowed by this design.

This is a permanent discipline introduced by adopting blue-green, documented in `docs/OPERATIONS.md`.

---

## 10. Secrets & configuration

- **GitHub repository secrets** hold both deploy creds (`SSH_HOST`, `SSH_USER`, `SSH_KEY`, `SSH_PORT`, `DEPLOY_PATH`) and **all runtime app secrets** (`DATABASE_URL`/`POSTGRES_PASSWORD`, `REDIS_URL`, `CLICKUP_API_TOKEN`, `CLICKUP_WEBHOOK_SECRET`, `ADMIN_API_KEY`, SMTP creds, `DOMAIN`, etc.).
- The deploy job renders these into a `.env` file on the host each deploy (write to a temp file, then atomic `mv`), used by `env_file:` in compose. The `.env` is never committed and never baked into an image layer (`.dockerignore` already excludes it).
- GHCR auth uses the ephemeral, job-scoped `GITHUB_TOKEN` forwarded into the SSH session — no long-lived registry secret on the box; `docker logout` after pull.

---

## 11. Files added / changed

**New / rewritten:**
- `Dockerfile` — rebuilt multi-stage, web-role default CMD, no startup migration.
- `docker-compose.prod.yml` — `app-web-blue`, `app-web-green`, `app-worker`, `migrate` (profile), `postgres`, `redis`, `caddy`.
- `Caddyfile` — `import /etc/caddy/active.conf`.
- `active.conf` — initial `reverse_proxy app-web-blue:3000` (seed file shipped to host).
- `scripts/deploy.sh` — host-side orchestration (steps 5–10): read color, start idle, health-gate, flip, recreate worker, prune. Keeps the workflow YAML thin and the logic testable/reviewable.
- `.github/workflows/deploy.yml` — `quality` → `e2e` → `build-and-push` → `deploy` (renders `.env`, syncs files, runs `scripts/deploy.sh`).

**Changed app code:**
- `src/app.module.ts` (+ a small bootstrap branch in `src/main.ts`) — `ROLE` gating of `ScheduleModule` + processors and the HTTP listener.

**Docs:**
- `docs/OPERATIONS.md` — blue-green runbook: how cutover works, how to roll back, expand/contract migration rule.

---

## 12. Out of scope

- Multi-host / cloud load balancers, autoscaling.
- Switching registries away from GHCR.
- Per-org data isolation (Spec 2) and any feature work.
- Automated post-deploy smoke tests beyond the `/api/health` gate (could be a follow-up).

---

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Both colors run cron → double backfills | `ROLE` gating makes the scheduler a singleton (`app-worker` only). |
| Destructive migration breaks rollback | Expand/contract discipline, documented; reviewed per-migration. |
| Health check passes but app is actually broken | Health-gate is a floor, not a guarantee; instant flip-back is the safety net. Optional smoke-test follow-up noted. |
| `.env` render leaks secrets into logs | Render via file redirection, never `echo` secret values; rely on Actions secret masking; atomic `mv`. |
| Worker restart drops in-flight jobs | BullMQ jobs are durable in Redis with attempts/backoff; recreate re-picks them up. |
| GHCR pull auth on host | Ephemeral `GITHUB_TOKEN` forwarded per deploy, `docker logout` after. |
