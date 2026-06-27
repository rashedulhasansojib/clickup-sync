# ──────────────────────────────────────────────────────────────────────────
# apps/api/Dockerfile  —  NestJS + Prisma API
#
# Build context = MONOREPO ROOT (so the pnpm workspace + lockfile are visible):
#   docker build -f apps/api/Dockerfile -t ghcr.io/<owner>/meeting-analyzer-api:<tag> .
#
# Base image choice: node:20-slim (Debian "bookworm"), NOT alpine.
#   Prisma's query engine on alpine needs the `linux-musl-openssl-3.0.x`
#   binary target; with the default schema (no `binaryTargets`) the musl engine
#   is not generated and `prisma migrate deploy` / the client fail at runtime.
#   Debian slim uses the default `debian-openssl-3.0.x` engine that `prisma
#   generate` produces out of the box. Builder and runtime share the SAME base
#   so the generated engine matches.
#
# node_modules strategy: the final stage copies the WHOLE built /app tree from
#   the builder rather than a hand-pruned prod install. This is deliberate:
#     * pnpm makes node_modules/@ma/shared a SYMLINK into packages/shared —
#       a selective copy would break module resolution at runtime.
#     * the generated Prisma client lives under node_modules/.prisma + .pnpm.
#     * the `prisma` CLI (needed by `prisma migrate deploy` at startup) is a
#       devDependency; a prod-only prune would drop it.
#   Copying the whole tree preserves all three. Pruning to a smaller image is a
#   documented later optimization (would require binaryTargets + a deploy stage
#   that keeps the prisma CLI).
# ──────────────────────────────────────────────────────────────────────────

# ---- Stage 1: deps (cached install layer) --------------------------------
FROM node:20-slim AS deps
WORKDIR /app

# OpenSSL is required by the Prisma engine on Debian.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Copy only the manifests + lockfile first so the install layer caches until a
# dependency actually changes. List every workspace package.json.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Every workspace member's manifest (frozen-lockfile needs them all present).
COPY apps/web/package.json apps/web/package.json
COPY apps/meetsy-api/package.json apps/meetsy-api/package.json
COPY apps/meetsy-web/package.json apps/meetsy-web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/clicksy-shared/package.json packages/clicksy-shared/package.json

# Full install (incl. dev deps — needed to build + to run `prisma migrate deploy`).
RUN pnpm install --frozen-lockfile

# ---- Stage 2: builder ----------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable

# Bring in the resolved node_modules from the deps stage, then the source.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/meetsy-api/node_modules ./apps/meetsy-api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .

# Generate the Prisma client FIRST — the TypeScript build imports generated types
# (@prisma/client `User`, `Prisma.InputJsonValue`), so it must exist before build.
# (engine: debian-openssl-3.0.x, used at runtime too.)
RUN pnpm --filter @ma/api exec prisma generate

# Build @ma/shared first (api depends on its dist), then the api.
# `turbo run build --filter=@ma/api...` builds @ma/api AND its workspace deps.
RUN pnpm turbo run build --filter=@ma/api...

# ---- Stage 3: runtime ----------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# Copy the entire built workspace (preserves pnpm symlinks, the generated Prisma
# client, the prisma CLI, dist outputs, and packages/shared/dist).
COPY --from=builder /app ./

# Entry script: runs `prisma migrate deploy` then boots the compiled server.
COPY apps/meetsy-api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Run as the built-in non-root user provided by the node image.
USER node

EXPOSE 4000

# NOTE: env (DATABASE_URL, REDIS_*, AZURE_OPENAI_*, JWT_*, CORS_ORIGINS,
# API_PORT) is injected by the container runtime — we do NOT use the dotenv-cli
# npm scripts here.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
