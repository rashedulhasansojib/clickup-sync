# syntax=docker/dockerfile:1

# ── build ─────────────────────────────────────────────────────────────────────
# Install ALL deps (incl. dev + workspace deps), generate the Prisma client,
# compile the backend to dist/, and build the dashboard to apps/web/dist/.
#
# npm ci runs in THIS stage so that:
#   - workspace deps for apps/web are present for `build:web` (no reliance on
#     hoisting), and
#   - `prisma generate` writes the client into THIS stage's node_modules, which
#     the runner then copies — otherwise the container boots with no Prisma
#     client and crashes.
FROM node:22-alpine AS build
WORKDIR /app
# Copy manifests first so `npm ci` is cached until dependencies change.
COPY package*.json ./
COPY apps/web/package.json ./apps/web/
RUN npm ci
COPY . .
# Build-time only: prisma.config.ts resolves env('DATABASE_URL'). `prisma generate`
# never connects, but the var must resolve. The real URL is injected at runtime
# via env_file and does not leak from this stage into the runner.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"
# Meetsy entry-point origin, baked into the SPA at build time (Vite reads
# VITE_* from the env during `build:web`). Drives the sidebar "Meetsy" link and
# the /login round-trip allowlist. Unset ⇒ the link is hidden. Prod value e.g.
# https://meetsy.<your-domain> — supplied as a build-arg by docker-compose.prod.
ARG VITE_MEETSY_WEB_ORIGIN=""
ENV VITE_MEETSY_WEB_ORIGIN=$VITE_MEETSY_WEB_ORIGIN
RUN npm run prisma:generate \
 && npm run build \
 && npm run build:web

# ── runner ────────────────────────────────────────────────────────────────────
# Full node_modules are kept on purpose: `prisma migrate deploy` runs at startup
# and the Prisma CLI + the loader for prisma.config.ts are devDependencies.
# node_modules is copied from `build` so it includes the generated Prisma client.
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
