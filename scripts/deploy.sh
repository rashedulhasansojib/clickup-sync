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
$COMPOSE --profile tools run --rm migrate

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
  # Probe from INSIDE the caddy container (app-web-* is only reachable on the
  # compose network). Use `compose exec` (service name) not `docker exec` — the
  # real container is named <project>-caddy-1, so `docker exec caddy` would fail.
  if $COMPOSE exec -T caddy wget -qO- "http://app-web-$TARGET:3000/api/health" >/dev/null 2>&1; then
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
$COMPOSE exec -T caddy caddy reload --config /etc/caddy/Caddyfile

echo "==> Updating worker (singleton, recreate-in-place)"
$COMPOSE up -d --force-recreate app-worker

echo "==> Pruning images older than 7 days"
docker image prune -af --filter "until=168h" || true

echo "==> Deploy complete. Live color: $TARGET"
