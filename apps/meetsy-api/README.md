# @ma/api

NestJS backend for the meeting-transcript analyzer.

## Phase 1 (walking skeleton) — what's here

- **Prisma + Postgres**: `Org`, `User`, `Meeting`, `AnalysisRun` (every table has `orgId`).
- **Azure OpenAI** (`src/azure`): the only LLM provider; `structured<T>()` helper using
  OpenAI structured outputs (`zodResponseFormat` + `beta.chat.completions.parse`).
  Reasoning model (GPT-5.5) → passes `reasoning_effort`, never `temperature`.
- **Pipeline** (`src/analysis/pipeline`): `normalize` (roster) → `comprehend` →
  `extract` → `assemble`. Stages 3/4/5 (assign/enrich/critic) are Phase-2 seams.
- **Queue** (`src/analysis/queue`): a BullMQ `analysis` queue + a Worker running
  in the same Nest process. Progress is published to Redis `run:{runId}`.
- **Endpoints**: `GET /health`, `POST /meetings`, `POST /meetings/:id/roster`,
  `GET /runs/:id`, `GET /runs/:id/stream` (SSE).

All request/response/domain types come from the `@ma/shared` workspace package.

## Environment

Copy the repo-root `.env.example` to `.env` and fill it in. Required vars:
`DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `AZURE_OPENAI_*`, `API_PORT`, `CORS_ORIGINS`.
Config is zod-validated at boot and fails fast with a readable message if anything is missing.

## Run order

From the repo root (Postgres + Redis via docker-compose):

```bash
docker compose up -d           # 1. start Postgres + Redis
pnpm install                   # 2. install workspace deps
pnpm --filter @ma/shared build # 3. build the shared package (api imports its dist)
pnpm --filter @ma/api db:generate  # 4. generate the Prisma client
pnpm --filter @ma/api db:migrate   # 5. create/apply the DB schema
pnpm --filter @ma/api db:seed      # 6. seed default Org + User (prints their ids)
pnpm --filter @ma/api dev          # 7. start the API (watch mode)
```

## Not implemented yet (Phase 2+)

- Stage 3 assign refinement, Stage 4 enrich, Stage 5 critic loop.
- Feedback-driven re-runs and chat over the result.
- Auth (Phase 4) — until then everything uses the seeded default org.
