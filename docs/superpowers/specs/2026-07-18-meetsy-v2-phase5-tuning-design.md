# Meetsy v2 — Phase 5: `/tuning` (Owner-only tunables + preview replay) — design

**Date:** 2026-07-18
**Status:** Design (locked before implementation)
**Umbrella plan:** `docs/superpowers/plans/2026-07-18-meetsy-v2-plan.md` §3 (Phase 5 row) + §4.2 (N1, N8).
**Predecessors:**
- Phase 0: `2026-07-18-meetsy-v2-phase0-foundations-design.md`
- Phase 1: `2026-07-18-meetsy-v2-phase1-ia-home-history-design.md`
- Phase 2: `2026-07-18-meetsy-v2-phase2-evidence-review-design.md`
- Phase 3: `2026-07-18-meetsy-v2-phase3-learning-trust-design.md`
- Phase 4: `2026-07-18-meetsy-v2-phase4-kb-consolidation-design.md`

---

## 1. Purpose

Phase 0 landed the *machinery* to make ML tunables per-workspace: the `WorkspaceMlConfig` table, its Zod schemas in `@ma/shared` (`packages/shared/src/ml-config.ts`), `MlConfigService.forWorkspace(...)` with defaults fallback, and an `AnalysisRunSnapshot` freeze on every completed run (`apps/meetsy-api/src/analysis/queue/analysis.processor.ts:270-284`). But no writer, no consumer, and no UI exist today. The pipeline still reads hardcoded constants (`DUP_FLAG = 0.72` in `duplicate-bands.ts:19`; `MIN_CORRECTIONS = 3` in `learning-aggregate.ts:57`; etc.), so `WorkspaceMlConfig` is a table with no callers, and the snapshot writer only ever writes the defaults.

Phase 5 closes the loop:

1. **Persist** — `GET|PUT /workspaces/:id/ml-config` — Owner writes candidate tunables + model routing. GET is open to any authed user (the `/tuning` page needs to render even for read-only viewers).
2. **Consume** — the two runtime call-sites that can be plumbed without a large refactor start reading `WorkspaceMlConfig` instead of the module-level constants: `classifyDuplicates(...)` (band values) and the `LearningService` gate (min-corrections + min-agreement). Other tunables (simFloor, minQualifying, rrfK, novelMaxSimCutoff, linkMinSim) stay hardcoded for now — wiring them requires re-running the KB search or embed pipeline, which is out of scope. The `/tuning` UI marks these fields as *"stored but not yet consumed by runtime"*.
3. **Preview** — `POST /workspaces/:id/ml-config/preview` — replay the last N (default 10, clamped 1..20) completed runs against candidate tunables and return a diff. The only signal we can honestly replay from the frozen `AnalysisRun.result` is **duplicate reclassification**, because per-task `neighboursByTask` is already stored (`analysis.processor.ts:252`). Gate values get a preview against the CURRENT `FieldOverride` history (workspace-wide, not per-run). Other tunables are omitted from the preview payload with a documented reason.
4. **Surface** — `/tuning` route in `meetsy-web` — Owner-only page (Members see the same page in read-only mode). Numeric inputs for tunables, a table of model-routing effort levels, a *Preview* button that opens a diff sheet, a *Save* button that writes via PUT.

Four PRs, one atomic commit — same discipline as Phases 3 & 4.

---

## 2. What ships (per PR)

| PR | Slice | Backend | Web |
|---|---|---|---|
| **T** | Persistence + Owner gate. | `GET|PUT /workspaces/:id/ml-config`. `MlConfigService.upsert(...)`. Zod-validated body (reuse `RunSnapshotPayloadSchema` from `@ma/shared`). PUT requires `OWNER`; GET open to any authed user. Response shape includes `updatedBy` + `updatedAt` for provenance. | — |
| **U** | Runtime consumption of the two plumb-able tunables. | `classifyDuplicates(neighbours, opts)` accepts optional `{ dupFlag, dupSuggest }`; call-site in `field-prediction.service.ts` passes the workspace's tunables. `LearningService.snapshot(...)` reads workspace tunables for `minCorrections` + `minAgreement` (invalidates the cache when `ml-config` PUT lands). No behavior change when config equals defaults. | — |
| **V** | Preview replay endpoint. | `POST /workspaces/:id/ml-config/preview`. Reads last N `AnalysisRunSnapshot` + parent `AnalysisRun` rows for this workspace. For each: reclassifies duplicates on stored `neighboursByTask` (delta count per band); reports skipped tunables with reason. Also recomputes learning gate flags via `LearningService.previewGate(minCorrections, minAgreement)` (workspace-wide, one entry per replayed candidate). Synchronous compute — no queue in this cut (see §5). | — |
| **W** | `/tuning` route. | — | `apps/meetsy-web/app/tuning/page.tsx` — Owner writable, Member read-only. Sections: **Tunables** (numeric inputs with min/max/step derived from `WorkspaceTunablesSchema`), **Model routing** (per-stage effort dropdown; deployment is display-only), **Preview** button opens a `<Sheet>` with per-run delta cards. Save button (Owner only) issues PUT; toast on success/failure. Read-only banner for non-Owners. Sidebar gains a **Tuning** entry (Owner/Admin visibility mirroring `/settings/push`). |

Order: T (backend persistence, independent) → U (runtime consumption; safe no-op when config equals defaults) → V (preview endpoint; depends on U's helper shape for `classifyDuplicates`) → W (web; depends on all three).

---

## 3. Backend design

### 3.1 `GET|PUT /workspaces/:id/ml-config` (PR-T)

**Controller:** new `apps/meetsy-api/src/tuning/tuning.controller.ts`. Ships next to the existing KB/analysis controllers rather than into `KbController` — this route is a workspace-tuning surface, not a knowledge-base surface. The controller depends on `MlConfigService` (already lives in `kb/`; keep it there and import — no move needed).

```ts
@Controller("workspaces/:id/ml-config")
export class TuningController {
  constructor(
    private readonly workspaces: WorkspaceResolver,
    private readonly mlConfig: MlConfigService,
  ) {}

  @Get()
  async get(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
  ): Promise<WorkspaceMlConfigView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.mlConfig.viewForWorkspace(workspaceId);
  }

  @Put()
  @Roles("OWNER")
  async put(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RunSnapshotPayloadSchema))
    body: RunSnapshotPayload,
  ): Promise<WorkspaceMlConfigView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.mlConfig.upsert(workspaceId, user.orgId, user.userId, body);
  }
}
```

**View shape:**

```ts
export interface WorkspaceMlConfigView {
  tunables: WorkspaceTunables;   // canonical (defaults-applied)
  models: WorkspaceModels;
  updatedBy: string | null;      // user id or null (default row)
  updatedAt: string | null;      // ISO or null when the row doesn't exist
  isDefault: boolean;            // true iff no row exists (rendering the defaults)
}
```

`isDefault` powers the UI's "using defaults" chip.

**`MlConfigService` additions:**

- `viewForWorkspace(workspaceId)`: existing `forWorkspace(...)` plus row-presence probe (returns `isDefault = !row`; `updatedBy`/`updatedAt` from the row when present).
- `upsert(workspaceId, orgId, updatedBy, payload)`: `prisma.workspaceMlConfig.upsert({ where: { workspaceId }, create: {...}, update: {...} })`. Payload arrives already-validated by `ZodValidationPipe(RunSnapshotPayloadSchema)` so the service can trust its shape. Post-write, invalidates the learning cache (Phase 3's `LearningCacheService`) for this workspace so `minCorrections` / `minAgreement` changes take immediate effect on the next `/learning` read.

**Roles.** `GET` is intentionally not `@Roles(...)`-gated (any authed user in the workspace can view). PUT requires `OWNER`. Members/Admins hitting PUT get a 403 from the global `RolesGuard`.

### 3.2 Runtime consumption (PR-U)

Two runtime call-sites accept per-workspace tunables. Every other constant stays hardcoded for now with a `// TODO(phase-5.x): read from WorkspaceMlConfig` comment so the follow-up path is discoverable.

#### 3.2.1 `classifyDuplicates` — dup bands

Signature change (`apps/meetsy-api/src/kb/duplicate-bands.ts`):

```ts
export interface DuplicateBands {
  dupFlag: number;
  dupSuggest: number;
}

export function classifyDuplicates(
  neighbours: Array<{ taskId: string; sim: number }>,
  bands: DuplicateBands = { dupFlag: DUP_FLAG, dupSuggest: DUP_SUGGEST },
  max = 3,
): DuplicateHit[] { /* same body, uses bands.* */ }
```

The existing exported constants `DUP_FLAG` / `DUP_SUGGEST` stay as the default so existing tests + spec-fixtures don't need to thread a config object through. Call-site update in `field-prediction.service.ts` (the pipeline entry point that computes `duplicates` for each task):

```ts
- const dups = classifyDuplicates(neighbours);
+ const dups = classifyDuplicates(neighbours, {
+   dupFlag: tunables.dupFlag,
+   dupSuggest: tunables.dupSuggest,
+ });
```

`field-prediction.service.ts` gets `tunables` via a new arg on its entry method, wired from `analysis.processor.ts` — the processor already reads `mlConfig.forWorkspace(workspaceId)` for the snapshot writer at line 271; move that call earlier in the run and hand `tunables` to `FieldPredictionService`. Zero cost, one extra passthrough.

#### 3.2.2 `LearningService` — gate values

`LearningService.snapshot(workspaceId, { userId? })` currently reads `MIN_CORRECTIONS` and `MIN_AGREEMENT` as module-level constants (`learning.service.ts:132`). Wire them through `MlConfigService.forWorkspace(workspaceId)`:

```ts
- gatePassed: count >= MIN_CORRECTIONS && agreement >= MIN_AGREEMENT,
+ gatePassed: count >= tunables.minCorrections && agreement >= tunables.minAgreement,
```

The `LearningCacheService` invalidator (Phase 3) already invalidates on `logFieldOverride`; extend it to also invalidate when `MlConfigService.upsert(...)` completes (see §3.1). The `NEAR_GATE_THRESHOLD` in `learning-stream.service.ts` becomes `tunables.minCorrections - 1` (computed per SSE evaluator invocation — the stream service already resolves the workspace from the event payload).

#### 3.2.3 Deferred consumption (stored but not yet consumed)

Marked with a `// TODO(phase-5.x)` inline comment and documented as such in the `/tuning` UI so an Owner isn't misled:

- `simFloor`, `minQualifying` — consumed in `prediction-prior.ts`; wiring requires threading tunables into every `qualifying()` call across `field-prediction.service.ts` + `assignment-rank.ts` + specs. Safe follow-up.
- `closedWeight` — consumed in `assignment-rank.ts:34`; needs the same threading.
- `rrfK` — used in `rrf.ts`; called from `kb-search.service.ts` and `field-prediction.service.ts`. Threading is trivial but touches KB-search callsites too.
- `novelMaxSimCutoff`, `linkMinSim`, `embedBatch` — consumed on the doc-embed side (`novelty.service.ts`, `doc-task-link.service.ts`, `kb.processor.ts`). These affect the KB build path, not the runtime analysis path — wiring is a Phase 5.x follow-up when the doc pipeline learns to reload settings between builds.
- **All model routing (`WorkspaceModels`)** — pipeline stage effort levels are read directly by each stage's `generateJson(...)` call. Runtime consumption is a bigger project (each stage is a class that takes an `AzureChatClient` — we'd need to pass a per-stage `effort` argument through every stage constructor or route the tunable in the Azure client itself). Deferred.

The `/tuning` UI marks deferred fields with a subtle "Applies from Phase 5.x" chip. Saved values still persist and appear in `AnalysisRunSnapshot`, so the snapshot honesty story stays intact.

### 3.3 `POST /workspaces/:id/ml-config/preview` (PR-V)

**Endpoint:**

```
POST /workspaces/:id/ml-config/preview
Body: { tunables: WorkspaceTunables, models: WorkspaceModels, limit?: number }
```

`tunables`/`models` are the *candidate* config to evaluate. `limit` defaults to 10, clamped 1..20. Owner-only (`@Roles("OWNER")`).

**Response:**

```ts
export interface MlConfigPreviewRun {
  runId: string;
  meetingTitle: string | null;
  meetingDate: string | null;
  taskCount: number;              // tasks with neighboursByTask on this run
  duplicates: {
    baseline: { flag: number; suggest: number };  // counts under snapshot bands
    candidate: { flag: number; suggest: number }; // counts under candidate bands
    changed: number;                              // tasks whose classified list differs
  } | null;                       // null when neighboursByTask absent (legacy run)
}

export interface MlConfigPreviewView {
  runs: MlConfigPreviewRun[];
  gate: {
    baseline: { patternsGating: number; patternsNearGate: number };
    candidate: { patternsGating: number; patternsNearGate: number };
  };
  skipped: Array<{ field: string; reason: string }>;
}
```

**Compute path (synchronous):**

1. Resolve workspace, verify Owner.
2. Load last N (default 10) `AnalysisRunSnapshot` joined to `AnalysisRun` for this workspace, `WHERE status = 'completed'`, ordered by `AnalysisRun.createdAt DESC`.
3. For each run: `neighboursByTask = run.result.neighboursByTask` (typed via `ReviewResultSchema.parse(run.result)`; missing keys → skip that run).
4. For each task in `neighboursByTask`:
   - `baselineHits = classifyDuplicates(neighbours, snapshotTunables)`
   - `candidateHits = classifyDuplicates(neighbours, candidateTunables)`
   - Compare hit sets (taskId + band) — count tasks whose sets differ.
5. Aggregate baseline/candidate band counts across the run.
6. Gate preview (single row, not per-run): `LearningService.snapshot(workspaceId, tunablesOverride)` twice — once with current `WorkspaceMlConfig.tunables`, once with candidate — and count patterns whose `gatePassed=true` or `count >= minCorrections - 1`.
7. `skipped` reports every non-replayable field explicitly (each deferred tunable in §3.2.3 plus `models.*`).

**Why synchronous.** Each replayed run is a pure JSON transform over pre-computed `neighboursByTask` arrays (typically ≤ 8 tasks × ≤ 5 neighbours). N ≤ 20 runs → well under 50 ms in profile. No queue infrastructure needed for this cut. §5 documents the queue as deferred.

### 3.4 Prisma / migrations

**None.** Phase 0 already shipped `WorkspaceMlConfig` and `AnalysisRunSnapshot`. Phase 5 only adds writes/reads on those tables.

### 3.5 Module wiring

- New `TuningModule` (or add controller to an existing `KbModule` — but the concern is orthogonal enough to KB that a small `TuningModule` reads better). Provides `TuningController`; imports `KbModule` (for `MlConfigService` + `LearningService` + `LearningCacheService`) and `AnalysisModule` (for `WorkspaceResolver`). Registered in `AppModule.imports`.
- Preview endpoint lives on `TuningController` too (grouped with GET/PUT under the same `workspaces/:id/ml-config` path prefix — the preview is a `POST /preview` sub-route).

---

## 4. Web design

### 4.1 Route & role gating (PR-W)

- New route `apps/meetsy-web/app/tuning/page.tsx`. Client component.
- Sidebar gets a **Tuning** entry with Owner/Admin visibility (`ownerAdminOnly: true`); Members don't see it in the nav — but if they navigate directly (e.g., from a shared link), the page renders read-only (Members can view the config but can't Save/Preview). This matches how `/settings/push` behaves.
- Non-Owner viewers see the same form controls but every input is `readOnly` (native attribute — visually disabled) and the Save + Preview buttons hidden. A blue banner at the top: "*Read-only. Only an Owner can change tunables. Ask [ownerEmail if known] to update.*"

### 4.2 Layout

```
┌─ Tuning ────────────────────────────────────────────────┐
│  [read-only banner if not Owner]                         │
│                                                          │
│  Tunables                     ┌──────────────────────┐   │
│  ─────────                    │  Preview & Save      │   │
│  Duplicate detection          │  ┌────────────────┐  │   │
│    dupFlag       [0.72] +/-   │  │ Preview last N │  │   │
│    dupSuggest    [0.64] +/-   │  │ [10 ▾]         │  │   │
│                               │  └────────────────┘  │   │
│  Similarity                   │                       │   │
│    simFloor      [0.50] •     │  [Preview]  [Save]   │   │
│    minQualifying [3]    •     │                       │   │
│                               │  Last saved: —        │   │
│  Learning gate                │  by (default)         │   │
│    minCorrections [3]         │                       │   │
│    minAgreement   [0.60]      │                       │   │
│                                                          │
│  Model routing (deferred)     ...                        │
└──────────────────────────────────────────────────────────┘
```

Two-column on desktop (`md:grid-cols-[2fr_1fr]`), stacked on mobile. Numeric inputs are `<Input type="number" step={inputStep(field)} min={0} max={maxFor(field)} />` with min/max derived from the Zod schema. Deferred-consumption fields (`•`) get a tooltip: *"Stored but not yet used by runtime. Applies from Phase 5.x."*

### 4.3 Preview sheet

Clicking **Preview** issues `POST /ml-config/preview` with the current form state as the candidate. Response opens a shadcn `<Sheet side="right">` with:

- **Duplicates delta** — one card per replayed run: title, date, `baseline → candidate` flag/suggest counts, count of tasks whose classification changed.
- **Learning gate delta** — one card summarizing baseline vs candidate patterns-gating + near-gate.
- **Skipped** — a small `<details>` with the list of non-replayable fields + reasons (from the API).

The sheet is *informational only* — no Save inside it. The Owner returns to the form, adjusts, previews again, then Saves.

### 4.4 Save

Save → `PUT /ml-config` with the current form state → toast success, re-fetch (rehydrate `updatedBy`/`updatedAt`). Validation errors from the server (Zod) surface as inline field errors.

### 4.5 Web API helpers

New in `apps/meetsy-web/lib/api.ts`:

```ts
export interface WorkspaceMlConfigView {
  tunables: WorkspaceTunables;
  models: WorkspaceModels;
  updatedBy: string | null;
  updatedAt: string | null;
  isDefault: boolean;
}

export interface MlConfigPreviewView {
  runs: MlConfigPreviewRun[];
  gate: { baseline: GateSummary; candidate: GateSummary };
  skipped: Array<{ field: string; reason: string }>;
}

api.mlConfig = {
  get: (workspaceId) => request(`/workspaces/${workspaceId}/ml-config`),
  put: (workspaceId, body) => request(`/workspaces/${workspaceId}/ml-config`, { method: "PUT", body }),
  preview: (workspaceId, body) => request(`/workspaces/${workspaceId}/ml-config/preview`, { method: "POST", body }),
};
```

Types shared: `WorkspaceTunables` / `WorkspaceModels` are already exported from `@ma/shared`. Import them into `lib/api.ts`.

---

## 5. Deferred / out of scope

- **`meetsy-ml-preview` BullMQ queue.** The umbrella plan calls it out. Kept out of this cut because the preview payload is synchronous-cheap (§3.3). Wire the queue when preview grows to include tunables that require re-embedding or re-running the KB search (e.g., `simFloor`, `rrfK`). At that point: `POST /ml-config/preview` enqueues, returns `{ jobId }`, and a `GET /ml-config/preview/:jobId` polls result. Journal the deferral explicitly.
- **Full runtime consumption of every tunable.** See §3.2.3 — five tunables plus all model routing are stored-but-not-consumed in this cut. Follow-up phases wire them.
- **Model routing edits actually affecting runs.** The stage `effort` values need to be threaded through each pipeline stage's constructor (or the Azure client itself) before edits take effect. Phase 5 stores them; the runtime still uses hardcoded per-stage effort. UI marks the section as Phase 5.x.
- **Config change audit trail.** The `updatedBy` + `updatedAt` on the row is the audit today. A dedicated `MlConfigHistory` table (append-only history of prior values) is deferred until an incident asks for it.

---

## 6. Landmines & mitigations

| Landmine | Mitigation |
|---|---|
| **`WorkspaceMlConfig` row missing → PUT semantics.** First PUT for a workspace must create, not update. | Use `prisma.workspaceMlConfig.upsert(...)` — creates on first PUT, updates otherwise. `updatedBy` populated on create; `createdAt` auto-set. |
| **`AnalysisRunSnapshot` absent on legacy runs.** Runs completed before Phase 0's snapshot writer landed have no snapshot. Preview must skip cleanly. | The `AnalysisRun`↔`AnalysisRunSnapshot` join uses `LEFT JOIN`; runs with no snapshot fall back to `DEFAULT_TUNABLES` for the baseline compare (documented in the response — the UI marks these as "using defaults as baseline"). |
| **`neighboursByTask` absent from `run.result`.** Runs completed before v2 Phase 2 shipped `sliceNeighbours(...)` don't have this field. Preview must skip. | Per-run: if `neighboursByTask` is missing or empty after `ReviewResultSchema.parse`, the run's `duplicates` field in the response is `null` (the UI renders "no per-task neighbours captured on this run — skipped for duplicate delta"). Gate delta is unaffected (workspace-wide). |
| **Validation drift between shared schema and web form.** The Owner can enter `dupFlag = 5` in the numeric input; the server rejects; the UI shows a stale form. | The form's `min`/`max`/`step` are derived at build time from `WorkspaceTunablesSchema` via a small `zodToFieldMeta()` helper in `lib/tuning-form.ts`. Server rejection still surfaces as inline errors via a `ZodError`-friendly toast. |
| **Cache staleness after PUT.** After a PUT, `LearningService.snapshot(...)` must return the new gate values on the next request. | PR-U's `MlConfigService.upsert(...)` calls `LearningCacheService.invalidate(workspaceId)` in the same transaction. Verified in `ml-config.service.upsert.spec.ts`. |
| **Concurrent PUTs from two Owners.** `updatedAt` alone doesn't stop last-write-wins. | Accept last-write-wins for this cut (matches how `/settings/push` behaves today). Follow-up if it bites: add an `If-Match: <updatedAt>` conditional; return 412 on mismatch. Document as known. |
| **Preview endpoint replays large `neighboursByTask` arrays.** Slow if the run had 40 tasks × 20 neighbours each. | `sliceNeighbours(...)` already caps at 5 per task at write time (`analysis.processor.ts:252`). Preview also clamps `limit` at 20 runs. Total work: ≤ 4 KB of pure math per preview call. |
| **Owner types values below Zod default's `min: 0` (e.g., `dupFlag = -0.1`).** Native `<Input type=number min=0 max=1>` still lets typing "-0.1" through some browsers. | Server-side Zod parse is the source of truth; server errors surface inline. Form-side `<Input>` also clamps on blur via a small hook. |
| **New sidebar entry crowds the nav.** Owner/Admin already see "Push settings" — adding "Tuning" pushes vertical density. | Group both under a `Settings` section header (already exists in the sidebar — `SETTINGS[]` array). Same visibility rules. |

---

## 7. Verification

Following the discipline set by Phase 3/4:

- **API tests (PR-T)**: `tuning.controller.spec.ts` — GET returns defaults when no row; PUT rejects non-Owner (403 via `RolesGuard`); PUT with malformed body 400; PUT creates then updates; GET after PUT returns the persisted values with `isDefault=false`.
- **API tests (PR-U)**: `duplicate-bands.spec.ts` — new tests: `classifyDuplicates` respects `bands` arg and matches legacy behavior when `bands` omitted. `learning.service.gate.spec.ts` — extend to prove `LearningService.snapshot(...)` reads `minCorrections`/`minAgreement` from `MlConfigService`.
- **API tests (PR-V)**: `ml-config-preview.service.spec.ts` — replay a fixture run (`AnalysisRunSnapshot` + `AnalysisRun` with `neighboursByTask`) against candidate bands; verify baseline/candidate counts + `changed` counts; verify legacy-run skip path returns `duplicates: null`.
- **Web smoke (PR-W)**: `next lint` clean; `tsc --noEmit` clean. No jest tests (matches the Phase 4 pattern where web is verified only via typecheck + lint).
- **Cross-cutting**: `next build` intentionally NOT run (see `meetsy-web-next-build-dev-footgun` memory).

Total delta expected: **+3 test files, ~15 new tests** (see PR-T/U/V above).

---

## 8. Success criteria

Phase 5 is done when:

1. Any authed user can `GET /workspaces/:id/ml-config` and see the current per-workspace config or the defaults if none saved.
2. An Owner can `PUT /workspaces/:id/ml-config` with a valid `RunSnapshotPayload`; Members/Admins get 403.
3. `classifyDuplicates(...)` and the `LearningService` gate check read the workspace's tunables (verified by unit tests injecting a non-default config).
4. `POST /workspaces/:id/ml-config/preview` returns a delta report for the last N runs; runs with no `neighboursByTask` are `duplicates: null` in the response; the `skipped` list documents every non-replayable field.
5. `/tuning` renders for Owners with editable form + Preview sheet + Save; for Members read-only.
6. `BUILD-JOURNAL.md` documents the atomic Phase 5 commit + verify counts.
7. `meetsy-ml-preview` BullMQ queue is deferred explicitly in the journal (with the reason from §5).
