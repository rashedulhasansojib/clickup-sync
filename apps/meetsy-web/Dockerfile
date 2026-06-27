# ──────────────────────────────────────────────────────────────────────────
# apps/web/Dockerfile  —  Next.js 15 (App Router, standalone output)
#
# Build context = MONOREPO ROOT:
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://<domain>/api \
#     -t ghcr.io/<owner>/meeting-analyzer-web:<tag> .
#
# !! GOTCHA: NEXT_PUBLIC_API_URL is BAKED INTO THE BUNDLE AT BUILD TIME.
#    The browser uses it (apps/web/lib/api.ts reads process.env.NEXT_PUBLIC_API_URL).
#    It MUST be passed as a --build-arg; setting it only at runtime has NO effect.
#    Consequently the web image is domain-specific — rebuild per domain.
#
# node:20-slim used to match the API toolchain; alpine would also work for web
# (no Prisma engine), but we keep one base for consistency.
# ──────────────────────────────────────────────────────────────────────────

# ---- Stage 1: deps -------------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Every workspace member's manifest (frozen-lockfile needs them all present).
COPY apps/web/package.json apps/web/package.json
COPY apps/meetsy-api/package.json apps/meetsy-api/package.json
COPY apps/meetsy-web/package.json apps/meetsy-web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/clicksy-shared/package.json packages/clicksy-shared/package.json

RUN pnpm install --frozen-lockfile

# ---- Stage 2: builder ----------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app
RUN corepack enable

# The public API base URL the browser will call — baked into the client bundle.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/meetsy-web/node_modules ./apps/meetsy-web/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .

# Build @ma/shared (web resolves it to dist via transpilePackages), then web.
# `--filter=@ma/web...` builds @ma/web AND its workspace deps (@ma/shared).
RUN pnpm turbo run build --filter=@ma/web...

# ---- Stage 3: runtime ----------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Next standalone bundle layout for a monorepo:
#   .next/standalone/                -> minimal server + traced node_modules
#   .next/standalone/apps/web/server.js
#   static assets must be placed alongside the server manually.
COPY --from=builder /app/apps/meetsy-web/.next/standalone ./
COPY --from=builder /app/apps/meetsy-web/.next/static ./apps/meetsy-web/.next/static
# NOTE: apps/web has no public/ directory at the time of writing, so it is not
# copied (a COPY of a missing path would fail the build). If you add
# apps/web/public/ later, add:
#   COPY --from=builder /app/apps/web/public ./apps/web/public

USER node

EXPOSE 3000

# server.js lives under apps/meetsy-web/ inside the standalone output.
CMD ["node", "apps/meetsy-web/server.js"]
