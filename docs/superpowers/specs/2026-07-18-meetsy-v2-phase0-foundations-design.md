# Meetsy v2 Phase 0 — Foundations (Design Spec)

**Date:** 2026-07-18
**Status:** Draft — awaiting product-owner approval before implementation
**Phase:** 0 of 6 (see `docs/superpowers/plans/2026-07-18-meetsy-v2-plan.md`)
**Prerequisites:** Meetsy v1 Phases 0–3 complete (see `docs/meetsy/BUILD-JOURNAL.md`)

---

## Summary

Phase 0 unblocks every later v2 phase by (a) fixing a silent-loss bug that deletes evidence from `AnalysisRun.result` on feedback/chat mutations, (b) adding two new Prisma models (`WorkspaceMlConfig`, `AnalysisRunSnapshot`) and their migrations, (c) shipping two new endpoints (task lookup, run list), (d) introducing `ReviewResultSchema` in `@ma/shared` as a real Zod contract for the five signal keys, and (e) laying design-system foundations (shadcn/ui, lucide-react, next-themes, toast) so subsequent phases stop reinventing primitives.

**Phase 0 is "done" when:**

1. `AnalysisRun.result`'s five extra keys (`kbContext`, `fieldPredictions`, `duplicates`, `assignment`, `adjustments`) survive **every** read/write path — including feedback submit and chat-added tasks — with round-trip verified by a service-level test.
2. `ReviewResultSchema` is exported from `@ma/shared` and the web-side local `ReviewResult` interface at `apps/meetsy-web/app/runs/[runId]/signals.tsx:70-76` is deleted in favor of the shared type.
3. `WorkspaceMlConfig` and `AnalysisRunSnapshot` migrations are applied. `WorkspaceMlConfig` has a default-row seeder (values match today's in-code constants). `AnalysisRunSnapshot` writes are wired in `analysis.processor.ts` but no reader yet (Phase 5 consumes).
4. Two new endpoints are live:
   - `GET /workspaces/:id/clickup/tasks/:taskId` returns `{ id, title, status, assigneeName, url, updatedAt }` for any ClickUp task in the workspace's org (soft-scope on `orgId`).
   - `GET /workspaces/:id/runs?limit&offset` returns paginated runs (newest first) with `{ id, meetingId, title, taskCount, pushStatus, status, createdAt }`.
5. `apps/meetsy-web` boots with `next-themes`, a shadcn-style primitive set installed (Button, Dialog, Sheet, Tabs, Toast, Command, DropdownMenu, Skeleton, Tooltip), and `lucide-react` icons. Old `app/ui.tsx` primitives re-export from the new ones during migration.
6. Existing test suite passes; new tests added below all pass.

## Goals / Non-goals

**Goals**
- Zero-loss round-trip of signal keys on `AnalysisRun.result`.
- Real Zod validation of all five signal keys — no more `.passthrough()` widening.
- Reproducible historical debugging via `AnalysisRunSnapshot`.
- One place to add per-workspace ML tunables in the future.
- One design-system source-of-truth for every subsequent phase.

**Non-goals (later phases)**
- Rendering the newly-preserved evidence (Phase 2).
- Reading `WorkspaceMlConfig` from any algorithm (Phase 5).
- Adding a UI for `/tuning`, `/kb`, `/learning`, or `/home` (Phases 1–5).
- Expanding `FIELDS = ["assignee"]` to include `sprint` (Phase 3).
- Touching Clicksy source.

---

## 1. Signal-loss fix (R1–R5)

### 1.1 The leak (grounded in the audit)

Five signal keys are attached at `analysis.processor.ts:240-248` as top-level extras on `AnalysisRun.result`. They survive to `GET /runs/:id` because `analysis.service.ts:199-201` uses `AnalysisResultSchema.passthrough().parse(...)`. **But every mutating path strips them:**

```
   loadRunContext (analysis.service.ts:227)  →  .parse() strips extras
      ↓
   submitFeedback (analysis.service.ts:295-298) writes stripped result
   sendChat        (analysis.service.ts:363-367) writes stripped result (when newTasks > 0)
      ↓
   push.service.ts:158-159 reads .fieldPredictions and gets {} — learning-loop signal silently dies
```

### 1.2 Introduce `ReviewResultSchema` in `@ma/shared` (R3)

Create `packages/shared/src/review-result.ts` (or add to `domain.ts` if that's the house pattern):

```ts
// Zod schemas for the five extra keys — one source of truth.
export const KbContextHitSchema = z.object({
  sourceType: z.enum(["clickup_task", "transcript", "document"]),
  sourceId: z.string(),
  score: z.number(),
  snippet: z.string(),
});

export const PriorCandidateSchema = z.object({
  value: z.string(),
  support: z.number().int().nonnegative(),
  share: z.number().min(0).max(1),
});

export const FieldPredictionSchema = z.object({
  value: z.string().nullable(),
  abstain: z.boolean(),
  support: z.number().int().nonnegative(),
  share: z.number().min(0).max(1),
  isModal: z.boolean(),
  confidence: z.enum(["high", "low"]),
  candidates: z.array(PriorCandidateSchema),
  reason: z.string().optional(),
});

export const DuePredictionSchema = z.object({
  date: z.string().nullable(), // YYYY-MM-DD
  abstain: z.boolean(),
  basedOnClosedTasks: z.number().int().nonnegative(),
  cycleDaysP80: z.number().nullable(),
});

export const TaskPredictionSchema = z.object({
  sprint: FieldPredictionSchema,
  assigneeHint: FieldPredictionSchema,
  estimate: FieldPredictionSchema,
  due: DuePredictionSchema,
  qualifyingNeighbours: z.number().int().nonnegative(),
});

export const DuplicateHitSchema = z.object({
  taskId: z.string(),
  score: z.number(),
  band: z.enum(["flag", "suggest"]),
});

export const AssignmentCandidateSchema = z.object({
  clickupUserId: z.string().nullable(),
  name: z.string(),
  inPool: z.boolean(),
  ownershipScore: z.number(),
  closedSimilar: z.number().int().nonnegative(),
  openTasks: z.number().int().nonnegative(),
  trackedHours30d: z.number(),
  evidenceTaskIds: z.array(z.string()),
});

export const TaskAssignmentSchema = z.object({
  recommended: AssignmentCandidateSchema.nullable(),
  ranked: z.array(AssignmentCandidateSchema),
  abstain: z.boolean(),
  conditionedOnClient: z.boolean(),
  rationale: z.string(),
});

export const FieldAdjustmentSchema = z.object({
  from: z.string(),
  to: z.string(),
  count: z.number().int().nonnegative(),
  agreement: z.number().min(0).max(1),
});

export const TaskAdjustmentsSchema = z.object({
  assignee: FieldAdjustmentSchema.optional(),
  sprint: FieldAdjustmentSchema.optional(), // present in Phase 3 when FIELDS expands
});

// The full review-result contract.
export const ReviewResultSchema = AnalysisResultSchema.extend({
  kbContext: z.array(KbContextHitSchema).optional(),
  fieldPredictions: z.record(z.string(), TaskPredictionSchema).optional(),
  duplicates: z.record(z.string(), z.array(DuplicateHitSchema)).optional(),
  assignment: z.record(z.string(), TaskAssignmentSchema).optional(),
  adjustments: z.record(z.string(), TaskAdjustmentsSchema).optional(),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;
```

Note: all five keys are **optional** — historical runs from Phase 0–3 may not have every key.

### 1.3 Update response schemas (R4)

- `packages/shared/src/api.ts:50` — `RunResponseSchema.result` becomes `ReviewResultSchema.nullable()`.
- `packages/shared/src/feedback.ts:36` — `SubmitFeedbackResponseSchema.result` → `ReviewResultSchema`.
- `packages/shared/src/feedback.ts:68` — `SendChatResponseSchema.result` → `ReviewResultSchema`.

### 1.4 Fix `loadRunContext` + write paths (R1, R2)

```ts
// analysis.service.ts:227
- const parsed = AnalysisResultSchema.parse(run.result);
+ const parsed = ReviewResultSchema.parse(run.result);
```

Introduce a merge helper (colocated with `loadRunContext`):

```ts
function mergeSignals(base: AnalysisResult, source: ReviewResult): ReviewResult {
  const { kbContext, fieldPredictions, duplicates, assignment, adjustments } = source;
  return { ...base, kbContext, fieldPredictions, duplicates, assignment, adjustments };
}
```

Apply in both write branches:

```ts
// analysis.service.ts submitFeedback (~line 295)
- const merged = /* just assembled */ ...;
+ const assembled = assemble(...);
+ const merged = mergeSignals(assembled, ctx.result);
  await this.prisma.analysisRun.update({ where: { id: runId }, data: { result: merged as Prisma.InputJsonValue }});

// analysis.service.ts sendChat (~line 363)
- ... same
+ const assembled = assemble(ctx.result.overview, ctx.roster, ctx.tasks.concat(newTasks));
+ const merged = mergeSignals(assembled, ctx.result);
```

### 1.5 Drop web-side local interface (R5)

- Delete `interface ReviewResult` at `apps/meetsy-web/app/runs/[runId]/signals.tsx:70-76`.
- Import `ReviewResult` from `@ma/shared` at that file and at `components.tsx:281, :731`.
- Replace the `as ReviewResult` casts — the type on `RunResponse.result` is now `ReviewResult | null` directly, so no cast needed.

### 1.6 Update `push.service.ts:158-159`

Currently reads via raw cast:
```ts
const predictions = (run.result as { fieldPredictions?: ... } | null)?.fieldPredictions ?? {};
```
Replace with the shared schema:
```ts
const parsed = run.result ? ReviewResultSchema.parse(run.result) : null;
const predictions = parsed?.fieldPredictions ?? {};
```

### 1.7 `stage6-assemble.ts:39` — leave strict

Assemble stays `AnalysisResultSchema.parse(...)` on its output. Merging is the caller's responsibility (§1.4), keeping the assembly function pure and evidence-agnostic.

---

## 2. New Prisma models (R6, N1)

### 2.1 `WorkspaceMlConfig`

Written in Phase 0, **read** by Phase 5. Seeded per workspace on first login (or lazily by the Phase 5 GET endpoint).

```prisma
model WorkspaceMlConfig {
  workspaceId String   @id @map("workspace_id")
  orgId       String   @map("org_id")
  tunables    Json     // Zod-validated: { dupFlag, dupSuggest, simFloor, minQualifying,
                       //                  closedWeight, minCorrections, minAgreement,
                       //                  rrfK, embedBatch, ... }
  models      Json     // { clamp: { deployment, effort }, narrative: {...}, judge: {...},
                       //   pipeline: { analyze: {effort}, critic: {effort}, enrich: {effort} } }
  updatedBy   String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([orgId])
  @@schema("meetsy")
}
```

Note: `workspaceId` is the PK (one config per workspace). No cross-schema FK — soft reference per the audit convention (`workspace.resolver.ts:26-29` handles cross-org denial).

### 2.2 `AnalysisRunSnapshot` (N1)

Written when a run completes; read by Phase 5's preview replay. Append-only.

```prisma
model AnalysisRunSnapshot {
  runId       String   @id
  workspaceId String   @map("workspace_id")
  tunables    Json     // frozen copy of WorkspaceMlConfig.tunables at run time
  models      Json     // frozen model routing
  createdAt   DateTime @default(now())

  @@index([workspaceId])
  @@schema("meetsy")
}
```

Write path (Phase 0 wires; Phase 5 reads): in `analysis.processor.ts` immediately after the `analysisRun.update({ ..., status: "completed", result: ... })` at lines 235-254, add:

```ts
const mlConfig = await this.mlConfig.forWorkspace(workspaceId); // reads WorkspaceMlConfig
await this.prisma.analysisRunSnapshot.create({
  data: {
    runId,
    workspaceId,
    tunables: mlConfig.tunables as Prisma.InputJsonValue,
    models: mlConfig.models as Prisma.InputJsonValue,
  },
});
```

If `WorkspaceMlConfig` doesn't exist yet for a workspace, snapshot the **hardcoded defaults** (from the const inventory in the plan §4).

### 2.3 Migration

Follow the house convention (`YYYYMMDDHHMMSS_meetsy_<phase>_<slug>`):
- `20260718120000_meetsy_v2_phase0_foundations/migration.sql`
- Hand-authored per the "HAND-AUTHORED. Do NOT apply here" header on existing meetsy migrations.
- Contains both tables + indices + a header comment linking to this spec.

### 2.4 Zod for the `tunables` and `models` JSON blobs

To avoid silent drift, add validation in `@ma/shared`:

```ts
export const WorkspaceTunablesSchema = z.object({
  dupFlag: z.number().min(0).max(1).default(0.72),
  dupSuggest: z.number().min(0).max(1).default(0.64),
  simFloor: z.number().min(0).max(1).default(0.5),
  minQualifying: z.number().int().positive().default(3),
  closedWeight: z.number().positive().default(2),
  minCorrections: z.number().int().positive().default(3),
  minAgreement: z.number().min(0).max(1).default(0.6),
  rrfK: z.number().int().positive().default(60),
  novelMaxSimCutoff: z.number().min(0).max(1).default(0.6),
  linkMinSim: z.number().min(0).max(1).default(0.75),
});

export const StageRoutingSchema = z.object({
  deployment: z.string(),
  effort: z.enum(["low", "medium", "high"]).default("medium"),
});

export const WorkspaceModelsSchema = z.object({
  pipeline: z.object({
    normalize: StageRoutingSchema,
    analyze: StageRoutingSchema,
    critic: StageRoutingSchema,
    enrich: StageRoutingSchema,
    refine: StageRoutingSchema,
    chat: StageRoutingSchema,
  }),
  narrative: StageRoutingSchema,
  clamp: StageRoutingSchema,
  judge: StageRoutingSchema,
});
```

Default values match today's in-code constants exactly — see the audit inventory (`kb/prediction-prior.ts:44-46`, `kb/duplicate-bands.ts:19-21`, `kb/learning-aggregate.ts:51-52`, `kb/assignment-rank.ts:34`, `kb/rrf.ts:9`, `kb/novelty.service.ts:29`, `kb/doc-task-link.service.ts:21`).

---

## 3. New endpoints (R7, R8)

Both follow the conventions the audit uncovered: `/workspaces/:id/...`, resolve via `this.workspaces.resolve(user.orgId, id)`, return `<Name>View` DTOs, no `@Roles(...)` (read-only, any authenticated user).

### 3.1 `GET /workspaces/:id/clickup/tasks/:taskId` (R7)

**Purpose:** resolve a ClickUp task id (surfaced in duplicate chips, `evidenceTaskIds`, kbContext) to human-readable metadata. Enables clickable chips in Phase 2.

**Controller:** new `apps/meetsy-api/src/clickup/tasks-lookup.controller.ts`:

```ts
@Controller("workspaces/:id/clickup/tasks")
export class TasksLookupController {
  constructor(
    private readonly workspaces: WorkspaceResolver,
    private readonly lookup: TasksLookupService,
  ) {}

  @Get(":taskId")
  async get(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Param("taskId") taskId: string,
  ): Promise<ClickUpTaskLookupView | null> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.lookup.forWorkspace(workspaceId, taskId);
  }
}
```

**Service:** reads the read-only `public.clickup_tasks` mirror (already exposed to Meetsy per Phase 0 v1 grant script). Soft-scoped by joining to `public.workspace_spaces` to prove the task belongs to a space visible to this workspace's org.

**View shape:**
```ts
export interface ClickUpTaskLookupView {
  id: string;              // ClickUp task_id
  title: string;
  status: string | null;
  assigneeName: string | null;
  url: string | null;      // constructed from CLICKUP_TEAM_ID + task_id
  updatedAt: string;       // ISO
}
```

Returns `null` (200) if the task is not found in the mirror. Never throws NotFoundException — a chip pointing at a task that predates the KB sync is expected.

### 3.2 `GET /workspaces/:id/runs` (R8)

**Purpose:** paginated run list. Powers Phase 1's `/home` recent-runs + `/meetings` history.

**Query params:** `limit` (default 20, clamped 1–100), `offset` (default 0), `status` (optional filter: `queued|running|completed|failed`).

**Controller:** add to existing `AnalysisController`:

```ts
@Get("workspaces/:id/runs")
async listRuns(
  @CurrentUser() user: AuthPrincipal,
  @Param("id") id: string,
  @Query("limit") limitParam?: string,
  @Query("offset") offsetParam?: string,
  @Query("status") statusParam?: string,
): Promise<RunListView> {
  const workspaceId = await this.workspaces.resolve(user.orgId, id);
  const limit = Math.min(Math.max(Number.parseInt(limitParam ?? "20", 10) || 20, 1), 100);
  const offset = Math.max(Number.parseInt(offsetParam ?? "0", 10) || 0, 0);
  const status = statusParam ? RunStatusSchema.parse(statusParam) : undefined;
  return this.analysis.listRuns(workspaceId, { limit, offset, status });
}
```

**View shape:**
```ts
export interface RunListItem {
  id: string;
  meetingId: string;
  meetingTitle: string;
  meetingDate: string | null;
  status: "queued" | "running" | "completed" | "failed";
  pushStatus: "not_configured" | "not_pushed" | "partial" | "pushed" | null;
  taskCount: number | null;
  createdAt: string;
}
export interface RunListView {
  items: RunListItem[];
  total: number;
  limit: number;
  offset: number;
}
```

**Index requirement:** add `@@index([workspaceId, createdAt(sort: Desc)])` on `AnalysisRun` in the Phase 0 migration.

---

## 4. Design system foundations

### 4.1 Packages to add (`apps/meetsy-web/package.json`)

- `@radix-ui/react-*` (transitive via shadcn)
- `class-variance-authority`, `clsx`, `tailwind-merge` (shadcn utilities)
- `lucide-react` (icons)
- `next-themes` (theme provider)
- `sonner` (toast — shadcn's default)
- `cmdk` (⌘K palette; installed here so Phase 4 doesn't require another package add)

### 4.2 shadcn primitives to install

Copy into `apps/meetsy-web/components/ui/` following shadcn's CLI conventions: `button`, `dialog`, `sheet`, `tabs`, `dropdown-menu`, `command`, `tooltip`, `skeleton`, `toast` (via sonner), `input`, `select`, `label`, `checkbox`, `radio-group`, `separator`.

**Not adding in Phase 0:** `data-table`, `calendar`, `form` — later phases will pull as needed.

### 4.3 Preserve `app/ui.tsx` during migration

Keep the file, but re-export from the new primitives so existing callers don't break in one big-bang change:

```ts
// app/ui.tsx (transitional shim)
export { Button } from "@/components/ui/button";
export { Card, CardContent, CardHeader } from "@/components/ui/card";
// ...etc
export { PriorityBadge, Tag, Spinner, ErrorBanner } from "./ui-legacy";
```

Move today's `Button`, `Card`, `ErrorBanner`, `Spinner`, `Tag`, `PriorityBadge` implementations to `app/ui-legacy.tsx`. Each subsequent phase migrates a few callers to the new shadcn primitives and eventually deletes `ui-legacy.tsx`. Phase 0 does **not** attempt a big-bang migration.

### 4.4 Theme provider + dark mode

- Add `<ThemeProvider attribute="class" defaultTheme="system">` in `app/layout.tsx` wrapping `<AppShell>`.
- `<html>` gains `suppressHydrationWarning` (next-themes requirement — additive to the existing `<body suppressHydrationWarning>`).
- No theme toggle UI in Phase 0 (Phase 6 adds it to the header); the system preference drives it. Sanity-check contrast tokens: green (success), amber (warning), red (danger), blue (info), violet (learning), zinc (neutral) — all need dark variants.

### 4.5 Toast provider

Mount `<Toaster />` (from `sonner`) inside `SignedInShell` above `AppShell`. Expose a `toast()` helper via re-export. Existing inline banners (`ErrorBanner`) stay in place — Phase 1 migrates the noisy ones.

---

## 5. Testing

Following the audit's convention (service-level unit tests, no controller specs, colocated `*.spec.ts`).

### 5.1 Signal round-trip test (blocking)

New file `apps/meetsy-api/src/analysis/analysis.service.signal-roundtrip.spec.ts`:

```
1. Seed a completed AnalysisRun with all 5 signal keys attached.
2. Call submitFeedback with a downvote (no LLM refine — mocked).
3. Read run.result from DB.
4. Assert: kbContext, fieldPredictions, duplicates, assignment, adjustments are all present and deep-equal to the pre-mutation values.
5. Repeat for sendChat with newTasks.length > 0 (mocked LLM).
```

This is the acceptance test — Phase 0 is not done until this passes.

### 5.2 `ReviewResultSchema` shape test

New file `packages/shared/src/review-result.spec.ts`:
- Parses a fixture that includes all 5 keys.
- Parses a fixture with none of them (historical run).
- Rejects malformed data (e.g., `duplicates[taskId]` not an array).

### 5.3 Endpoint smoke tests

Service-level (following `analysis.service.workspace-scope.spec.ts`):
- `TasksLookupService.forWorkspace` — returns null for unknown taskId; returns metadata for a seeded ClickUp task; returns null for a task in another org.
- `AnalysisService.listRuns` — pagination, status filter, workspace scoping.

### 5.4 Migration test

- Fresh DB → apply migration → `WorkspaceMlConfig` and `AnalysisRunSnapshot` tables exist with the expected columns and indices.
- `AnalysisRun` gets its new `(workspaceId, createdAt DESC)` index.

### 5.5 Web-side smoke

- `apps/meetsy-web` boots with the new packages.
- `next-themes` toggles a class on `<html>` when `document.documentElement.classList` is inspected in test.
- Existing pages render (no visual regression from the re-exported primitives).

---

## 6. Rollout order (single PR or split?)

Recommend splitting into three sequential PRs to keep review manageable:

1. **PR-A: signal-loss fix** — `ReviewResultSchema` + `loadRunContext` fix + `mergeSignals` + response schema updates + web-side interface deletion + round-trip test.
2. **PR-B: Prisma models + endpoints** — `WorkspaceMlConfig` + `AnalysisRunSnapshot` migration + `analysis.processor.ts` snapshot write + task-lookup endpoint + runs-list endpoint + tests.
3. **PR-C: design system foundations** — packages, shadcn primitives, transitional shim in `app/ui.tsx`, ThemeProvider, Toaster.

PR-A is the highest-risk (touches persistence). PR-B and PR-C are independent and can land in either order after PR-A.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `ReviewResultSchema.parse` rejects historical `AnalysisRun.result` rows because a field the old code didn't emit is now required | All five signal keys are **optional** on `ReviewResultSchema`. Fixture test covers a legacy row. |
| Migration adds `AnalysisRun` index on a very large table → downtime | Use `CREATE INDEX CONCURRENTLY` in the hand-authored SQL (Prisma supports via raw SQL migration). |
| `next-themes` hydration mismatch with the existing Grammarly workaround | Add `suppressHydrationWarning` on `<html>` (next-themes doc-recommended); keep the existing `<body suppressHydrationWarning>`. |
| shadcn's Tailwind config assumes v3, current app is Tailwind v4 | Verify shadcn init command supports v4; if not, use the community v4-compatible primitive set (documented on shadcn's site) or hand-adapt the primitives. |
| `AnalysisRunSnapshot` write fails and blocks run completion | Wrap in try/catch — snapshot is nice-to-have. Log failure to `sync_job_logs` (or equivalent), never fail the run. |
| Old `app/ui.tsx` re-export shim ships broken imports | Snapshot test that renders each existing page under the shim; visual diff is caught in CI. |

---

## 8. Open questions (resolve during implementation, not blocking approval)

- **Where does `WorkspaceMlConfig` default row live?** Lean: lazy-created by `GET /workspaces/:id/ml-config` (Phase 5) — Phase 0 does not need a default row. The snapshot write in `analysis.processor.ts` reads-or-defaults.
- **Which `@ma/shared` file houses the new schemas?** Lean: new file `packages/shared/src/review-result.ts` re-exported from the package index. Keeps `domain.ts` from growing further.
- **PR ordering for the toast provider vs. existing `ErrorBanner`.** Lean: install Toaster in PR-C; leave `ErrorBanner` untouched until Phase 1 migrates callers explicitly.
- **Do we take a snapshot of the current hardcoded constants in seed data?** Lean: yes — a fixture file `apps/meetsy-api/src/kb/ml-config.defaults.ts` exports the current values with citations to their source files. Both the migration seeder (if we ever add one) and the Phase 5 default reader reference this one file.
