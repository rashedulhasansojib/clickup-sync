# Meetsy v2 — Phase 2: Evidence-first review page (design)

**Date:** 2026-07-18
**Status:** Design (locked before implementation)
**Umbrella plan:** `docs/superpowers/plans/2026-07-18-meetsy-v2-plan.md` §3 (Phase 2 row) + §4 (R4, N4, N5).
**Predecessors:**
- Phase 0 foundations: `2026-07-18-meetsy-v2-phase0-foundations-design.md`
- Phase 1 IA + history: `2026-07-18-meetsy-v2-phase1-ia-home-history-design.md`

---

## 1. Purpose

The pipeline already computes rich per-task provenance — `assignment.ranked[]`, `evidenceTaskIds`, `FieldPrediction.candidates[]`, `kbContext.sourceId`, top-K kNN neighbours — and the review UI shows almost none of it. IC engineers checking their own assignments cannot answer *"why did the model suggest me?"* without opening ClickUp in a second tab.

Phase 2 makes the review page **evidence-first**: every prediction on a task card is rendered *with its reasons*, every ClickUp task-id chip is clickable → side sheet, and failed pushes finally have a retry path. Four vertical slices (PR-H → PR-K), one atomic Phase-2 commit at the end.

Grounded in the umbrella plan §2 (audience decision) — evidence expanded by default, chips clickable, keyboard-first is a Phase 6 concern.

---

## 2. What ships (per PR)

| PR | Slice | Backend | Web |
|---|---|---|---|
| **H** | Attach top-5 kNN neighbours to `run.result` (N4). | `NeighbourHitSchema` in `@ma/shared`; extend `ReviewResultSchema.neighboursByTask`; slice + persist in `analysis.processor.ts`; preserve in `mergeSignals()`. | — |
| **I** | Push retry queue + dead-letter (N5). | `PushDeadLetter` model + migration; `meetsy-push-retry` BullMQ queue + worker; `POST /runs/:id/push/retry`; dead-letter admin list/resolve endpoints. | — |
| **J** | Evidence panels (the visible payoff). | — | Redesign `TaskSignals` and `KbContextBanner` to render `assignment.ranked[]`, `candidates[]`, `evidenceTaskIds`, `neighboursByTask` — **expanded by default**. |
| **K** | Clickable chips → side sheet. | — | `TaskDetailSheet` component fetching `GET /workspaces/:id/clickup/tasks/:taskId`; wire chips across duplicates, kbContext, evidenceTaskIds, neighbours. Retry-failed-pushes button in `PushSection`. |

Order: H → I (backend) → J → K (web). H and I can be built in parallel by workflow; both are independent of the web side.

---

## 3. Backend design

### 3.1 kNN neighbours (PR-H)

**Grounding.** `field-prediction.service.ts:112` already returns `neighboursByTask: Record<string, Neighbour[]>` and threads it through `analysis.processor.ts:154, :218, :220`. The processor uses it for owner ranking then drops it — the persisted `run.result` at :243-250 excludes it. All that Phase 2 needs is a slice + spread + a schema entry.

**Shared schema (new).** In `packages/shared/src/review-result.ts`:

```ts
export const NeighbourHitSchema = z.object({
  taskId: z.string(),
  sim: z.number(),
  client: z.string().nullable(),
  sprint: z.string().nullable(),
  assignee: z.string().nullable(),
  estimation: z.string().nullable(),
  createdDate: z.string().datetime().nullable(),
  closedDate: z.string().datetime().nullable(),
});
export type NeighbourHit = z.infer<typeof NeighbourHitSchema>;
```

`ReviewResultSchema.extend({ ..., neighboursByTask: z.record(z.string(), z.array(NeighbourHitSchema)).optional() })`. And `ReviewSignals` gets `neighboursByTask` on the picked type so `mergeSignals()` preserves it.

`Neighbour` at `kb/prediction-prior.ts:14` carries `Date | null` for `createdDate`/`closedDate`; when persisted via `Prisma.InputJsonValue` these serialize to ISO strings. `NeighbourHitSchema` uses `z.string().datetime().nullable()` so both the JSON round-trip and any legacy manually-set null both parse.

**Slice + persist.** In `analysis.processor.ts` at the `result: { ... }` write (currently lines 243-250), add:

```ts
neighboursByTask: sliceTopN(taskAnalysis.neighboursByTask, 5),
```

`sliceTopN(map, n)` is a pure local helper that maps each task-id key to `neighbours.slice(0, n)` — the array is already sorted DESC by cosine (source of `Neighbour[]` is a pgvector `ORDER BY <=>` query at `field-prediction.service.ts:139`). Dates serialize to ISO strings by JSON (`Date.prototype.toJSON`), matching the schema.

**mergeSignals().** Add `neighboursByTask: source.neighboursByTask` to the `signals` object in `analysis.service.ts:717` so feedback + chat writes preserve it (same failure mode as Phase 0 R2, applied to the new key).

**Bounds check.** Top-5 × ~20 tasks × ~100 bytes per neighbour → ~10 KB per run in `AnalysisRun.result`. Trivial vs. the transcript-sized fields already in `run.result`.

**Where the plan misdirects.** Umbrella plan §4.2 N4 cites `apps/meetsy-api/src/analysis/pipeline/field-prediction.service.ts:70-72`; actual path is `apps/meetsy-api/src/kb/field-prediction.service.ts:70-73`. Spec is authoritative.

### 3.2 Push retry queue + dead-letter (PR-I)

**Problem today.** `push.service.ts:249-266` upserts a `failed` `TaskPush` row on any ClickUp create exception. The row sits there — no retry endpoint, no queue, no dead-letter. The UI's only recourse is "click Push again" which piggybacks on the whole `handlePush` path and passes all pushed-plus-failed tasks through the idempotency check.

**Model.** `PushDeadLetter` in `apps/meetsy-api/prisma/schema.prisma`, `@@schema("meetsy")`:

```prisma
model PushDeadLetter {
  id            String    @id @default(cuid())
  runId         String
  meetsyTaskId  String
  workspaceId   String
  jobId         String    // BullMQ jobId (idempotency across retries)
  payload       Json      // the last ClickUp create payload attempted
  errorMessage  String?
  errorStack    String?
  attemptsMade  Int       @default(0)
  failedAt      DateTime  @default(now())
  retriedAt     DateTime?
  resolvedAt    DateTime?

  @@index([workspaceId])
  @@index([runId])
  @@schema("meetsy")
}
```

Mirrors the Clicksy `DeadLetterJob` at root `prisma/schema.prisma:213` but in `meetsy` schema and scoped to push. `@@index([runId])` so `/runs/:id/push/retry` reads are cheap.

**Queue.** Follow the analysis-queue pattern (`analysis/queue/analysis.queue.ts:23`, `analysis.processor.ts:32`):

```
apps/meetsy-api/src/clickup/push-retry/push-retry.queue.ts       // producer
apps/meetsy-api/src/clickup/push-retry/push-retry.processor.ts   // worker
apps/meetsy-api/src/clickup/push-retry/redis.ts                  // NAME + helpers
```

Queue name: `meetsy-push-retry`. Job data: `{ runId, meetsyTaskId, orgId }`. Job options: `attempts: 4`, `backoff: { type: "exponential", delay: 2000 }`, `removeOnComplete: 100`, `removeOnFail: 100`. Job id: `${runId}:${meetsyTaskId}:${nonce}` — must NOT be deterministic (a retry after another retry must run; BullMQ dedupes on jobId). The nonce is `Date.now().toString(36)` (allowed in server code; the frozen-time constraint is a workflow-script rule).

Worker reads `TaskPush` for the target `(runId, meetsyTaskId)`, must find `status="failed"` (otherwise noop). Calls `push.service.ts`'s create path directly — refactor the per-task branch out of `pushTasks()`'s loop into a public `pushOneTask(runId, meetsyTaskId, ...)` method so the worker doesn't re-implement mapping. On success: `upsert(status:"pushed")` (existing code path). On final BullMQ attempt failure: write `PushDeadLetter` row and leave `TaskPush.status="failed"` intact (dead-lettered = permanent, not lost).

**Endpoint.** `POST /workspaces/:id/runs/:runId/push/retry` on a new `PushRetryController` (co-located with `PushController` in `clickup/`):

```
Auth: any authenticated user (same as PushController)
Body: { taskIds?: string[] }   // optional filter; empty ⇒ retry all `failed`
Response: { enqueued: string[]; skipped: { meetsyTaskId: string; reason: string }[] }
```

Reads `TaskPush` for the run, filters `status="failed"` (optionally intersected with `taskIds`), enqueues one job per row. `skipped` reasons: `not_found`, `not_failed`, `already_queued` (BullMQ waiting/active check).

**Dead-letter admin.** Two Owner/Admin-only endpoints on a new `PushDeadLetterController`:

```
GET  /workspaces/:id/push/dead-letter?limit=&cursor=   // list unresolved
POST /workspaces/:id/push/dead-letter/:id/resolve      // mark resolvedAt
```

No re-enqueue endpoint yet — resolve is the escape hatch. If a workspace acquires enough dead-letters to matter, we build re-enqueue in Phase 6 polish.

**Idempotency.** Every retry re-runs the same ClickUp create call. `push.service.ts` already skips `pushed` rows (line 190). If a ClickUp call succeeded but the response never reached us (network glitch), the retry creates a duplicate ClickUp task — same failure mode as the existing manual re-push. Solving that needs an outbound-idempotency-key that ClickUp doesn't support; not a Phase 2 goal.

### 3.3 Auth + workspace scope

Both new endpoints use the existing global `AuthGuard` (CSRF-enforced) + `WorkspaceResolver.resolve(orgId, id)`. Dead-letter endpoints add `@Roles("owner", "admin")` — visible only to the same role set that sees the run admin surfaces today.

---

## 4. Web design (PR-J + PR-K)

### 4.1 Evidence panel redesign (PR-J)

`signals.tsx:85` (`TaskSignals`) becomes the anchor for the whole evidence surface. It currently renders 4 shallow rows (dupes, prediction chips, adjustment nudge, owner). It'll gain 3 more sections and every existing row gets deeper.

**New structure** (top-to-bottom on each task card):

```
┌─ Duplicate awareness ────────────────────────────┐   red/amber chips → clickable
├─ Suggested fields (sprint/due/estimate) ─────────┤   each shows candidates[]
├─ Owner ranking (assignment.ranked[]) ────────────┤   ordered list; each row shows evidenceTaskIds
├─ Learning-loop nudge (adjustment.assignee) ──────┤   only when gate passed
├─ Similar tasks (top 3 neighboursByTask) ─────────┤   subtle strip; each row → clickable chip + sim %
└─ Grounding (kbContext for THIS task) ────────────┘   optional per-task; usually shown as run-level banner
```

- **Owner ranking**: not just `recommended.name`. Render `assignment.ranked[]` as a compact list (top 3 by default, "show all" toggle when ranked.length > 3). Each row: name, ownership score bar, `evidenceTaskIds` as a horizontal strip of clickable chips.
- **Field candidates**: for each `FieldPrediction`, render `candidates[]` beneath the picked value. Each candidate: `value (n · share%)`. The picked value gets `font-medium`, minority picks marked with a small "clamp" badge (`isModal === false`).
- **Neighbours strip**: `neighboursByTask[taskId]` top-3, chip layout: `[cu-01H... 91%]`. Hover: `assignee · sprint · client`. Click: opens the sheet.

**No "expand" toggle on this container** — evidence is expanded by default per the audience decision. The `<details>` in `KbContextBanner` (`signals.tsx:154`) stays because that's a *run-level* summary and only some viewers care.

**File layout.** `signals.tsx` grows past a comfortable single-file — split it:

```
apps/meetsy-web/app/runs/[runId]/signals/
  index.tsx           // barrel re-exports
  types.ts            // `TaskSignalData`, `signalsForTask`
  chip.tsx            // `Chip`, `PredChip` primitives
  task-signals.tsx    // top-level container
  duplicates-row.tsx  // one file per row
  suggested-row.tsx
  owner-row.tsx       // renders assignment.ranked[]
  nudge-row.tsx
  neighbours-row.tsx
  kb-context.tsx      // KbContextBanner
```

Existing imports (`components.tsx` line 361 imports `<TaskSignals>` from `./signals`) resolve via the barrel — no touch to callers.

### 4.2 TaskDetailSheet + clickable chips (PR-K)

**Chip primitive.** New `TaskChip` component in `apps/meetsy-web/components/tasks/task-chip.tsx`:

```tsx
<TaskChip
  taskId="86abc123"
  workspaceId={ws}
  tone="blue"
  onClick /* handled internally */
/>
```

Internally: renders `<button>` (not `<span>` — a chip that opens something IS interactive), calls `openTaskSheet(taskId)` from the shared sheet context. Falls back to `<span>` when `workspaceId` is falsy (defense — a task-id chip without ws scope is nonsensical but shouldn't crash).

**Sheet.** `apps/meetsy-web/components/tasks/task-detail-sheet.tsx`:

```tsx
const { open, taskId, close } = useTaskSheet();
// ...
<Sheet open={open} onOpenChange={(v) => v ? undefined : close()}>
  <SheetContent side="right" className="max-w-md">
    <SheetHeader>…</SheetHeader>
    <TaskDetailBody workspaceId={ws} taskId={taskId} />
  </SheetContent>
</Sheet>
```

`TaskDetailBody` fetches once on mount via new `api.getClickupTask(workspaceId, taskId)`, which hits `GET /workspaces/:id/clickup/tasks/:taskId` (Phase 0 endpoint, `tasks-lookup.controller.ts`). States:

- **Loading** — Spinner + skeleton fields.
- **Not found** (null response) — "This ClickUp task isn't in your workspace's KB — probably archived or from another workspace."
- **Loaded** — title, `StatusPill(status)`, `assigneeName`, `updatedAt`, external-link button (`url`).

The response schema (`ClickUpTaskLookupViewSchema` at `packages/shared/src/api.ts:62-70`) already carries everything we need; no new fields.

**Context provider.** `TaskSheetProvider` mounted inside the runs page so a chip anywhere in the tree can call `openTaskSheet(id)`. State lives in the provider; only one sheet visible at a time. Multiple clicks re-target it (drop the current, load the new — same fetch cycle). Close on Escape (Radix default).

**Wire-up sites** (all in signals row files after PR-J):
1. `DuplicatesRow` — every `d.taskId` chip.
2. `KbContextBanner` — each hit's `sourceId` when `sourceType === "clickup_task"`.
3. `OwnerRow` — each `evidenceTaskIds` chip on every ranked candidate.
4. `NeighboursRow` — every neighbour chip.

### 4.3 Retry-failed-pushes button (PR-K, cont.)

`components.tsx:947-958` — right-aligned button row in `PushSection`. Add a secondary button:

```tsx
{hasFailed && (
  <Button
    variant="secondary"
    onClick={handleRetryFailed}
    disabled={retryPending}
  >
    Retry failed ({failedCount})
  </Button>
)}
```

`hasFailed`: derived from `status.pushes.some(p => p.status === "failed")`. `handleRetryFailed`: `await api.retryPush(runId)` then refresh status (`fetchStatus()`). A toast on success reports the enqueued count; on server error, an `ErrorBanner` in-context (same pattern as `handlePush`).

New API client method (`apps/meetsy-web/lib/api.ts`, next to `pushRun`):

```ts
async retryPush(runId: string, taskIds?: string[]) {
  return this.postJson<{ enqueued: string[]; skipped: {meetsyTaskId: string; reason: string}[] }>(
    `/runs/${runId}/push/retry`,
    { taskIds: taskIds ?? [] },
  );
}
```

### 4.4 What we do NOT ship in Phase 2

- **Per-row retry button.** Adds another button per `TaskPushRow` — noisy. The bulk retry covers the common case.
- **Dead-letter UI.** Two admin endpoints (§3.2) are shipped so the mechanism is complete, but the admin surface is Phase 4 (KB consolidation touches the same admin nav).
- **Neighbours as their own tab.** The strip on the task card is enough for IC engineers checking one task at a time. A "similar tasks across the whole run" view is a Phase 3 candidate.

---

## 5. Test plan

Backend (Jest):
- **kNN plumbing.** New spec `analysis.service.merge-signals.spec.ts`: given a `ReviewResult` with `neighboursByTask`, `mergeSignals(base, source).neighboursByTask` is preserved verbatim.
- **kNN slicing.** New spec `analysis.processor.neighbours-slice.spec.ts`: `sliceTopN({a: 10-neighbours, b: 3-neighbours}, 5)` returns `{a: 5, b: 3}` with the original ordering.
- **`NeighbourHitSchema`.** Add to `packages/shared/src/*` alongside existing tests: a full round-trip (Prisma-shaped ISO date string → parse → object → JSON.stringify → parse) round-trips without loss.
- **`PushDeadLetter` write.** New spec `push-retry.processor.spec.ts`: on 4th attempt failure, one `PushDeadLetter` row is written; `TaskPush.status` stays `failed`.
- **`POST /runs/:id/push/retry`.** New spec `push.service.retry.spec.ts`: given 3 failed pushes and a `taskIds` filter of 2, only the intersection is enqueued; the third is reported as `skipped`.

Web (Vitest smoke — the codebase's convention is API-side jest + web-side manual verify + typecheck; keep):
- Typecheck + lint against `apps/meetsy-web` covering the new signals split.
- Manual: `next build` skipped per the meetsy-web-next-build-dev-footgun memory.

---

## 6. Rollout

1. Migration `20260718200000_meetsy_v2_phase2_push_dead_letter` — creates `PushDeadLetter` table. Hand-authored (schema + migration in one PR).
2. All four PRs land in one atomic Phase-2 commit (Phase 1 precedent).
3. `docs/meetsy/BUILD-JOURNAL.md` — PR-H/I/J/K entries dated 2026-07-18 + phase status `DONE`.

The migration is UNAPPLIED at commit-time — same footing as Phase 1's `20260718150000_meetsy_v2_phase1_run_search` (see operational leftovers in the Phase 1 exit note).

---

## 7. Risks

- **Dead-letter never reads back.** If the admin surface (§4.4 deferral) never lands, dead-lettered pushes are invisible. Mitigation: `PushDeadLetter` rows count as observability data; a workspace log-hunt can find them via `SELECT * FROM meetsy."PushDeadLetter" WHERE "workspaceId"=…`. Same escape hatch Clicksy already relies on for `DeadLetterJob`.
- **Retry storms.** A misconfigured workspace push (wrong list id, revoked ClickUp token) will fail every task 4×. Mitigated by BullMQ exponential backoff, but the RCA is user-visible only in the dead-letter admin. Acceptable pre-Phase-4.
- **Signals split refactor.** Splitting `signals.tsx` into a directory is mechanical but touches every import. Guarded by the barrel + `signals/index.tsx` re-exports.
- **`Neighbour.createdDate` / `closedDate` ISO round-trip.** If a legacy run's persisted JSON has a non-ISO date (unlikely — every write path goes through `Prisma.InputJsonValue` which stringifies via `Date.prototype.toJSON`), `ReviewResultSchema.parse()` will fail at load. Mitigation: schema uses `z.string().datetime().nullable()` which accepts ISO 8601; if we ever see a broken row, we widen to `z.string().nullable()` and log a warning (defer to when we see it, not preemptively).

---

## 8. Open questions

- **Where does `TaskSheetProvider` mount?** Cleanest: `apps/meetsy-web/app/runs/[runId]/page.tsx` (scoped to a single run view). Alternative: `AppShell` so any future page can open a sheet. Lean: page-level for Phase 2 — hoist to AppShell in Phase 4 when `/kb` also wants it.
- **Do we expose the dead-letter list in the UI in Phase 2?** No — see §4.4. Endpoints ship so the mechanism is complete; UI is Phase 4.
- **Neighbours-by-task on legacy runs.** Runs completed before this PR have no `neighboursByTask`; the UI simply doesn't render the strip. No backfill.
