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
