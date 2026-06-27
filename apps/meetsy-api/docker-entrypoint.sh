#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────
# API container entrypoint.
#   1. Apply pending Prisma migrations (idempotent — safe on every boot).
#   2. Start the compiled NestJS server directly (NOT the dotenv-cli npm
#      script; env is injected by the container runtime).
#
# Env required at runtime (validated by the app's zod loader — the process
# exits before listening if any is missing):
#   DATABASE_URL, REDIS_HOST, REDIS_PORT,
#   AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT,
#   AZURE_OPENAI_API_VERSION,
#   JWT_ACCESS_SECRET (>=16 chars), JWT_REFRESH_SECRET (>=16 chars),
#   CORS_ORIGINS, API_PORT (default 4000)
# ──────────────────────────────────────────────────────────────────────────
set -e

echo "[entrypoint] Running prisma migrate deploy..."
# Use the prisma CLI resolved within the api workspace, pointed at its schema.
pnpm --filter @ma/api exec prisma migrate deploy

echo "[entrypoint] Starting API server (apps/meetsy-api/dist/main.js)..."
exec node apps/meetsy-api/dist/main.js
