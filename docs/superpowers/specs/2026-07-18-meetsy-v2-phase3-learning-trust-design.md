# Meetsy v2 — Phase 3: Learning trust (design)

**Date:** 2026-07-18
**Status:** Design (locked before implementation)
**Umbrella plan:** `docs/superpowers/plans/2026-07-18-meetsy-v2-plan.md` §3 (Phase 3 row) + §4 (N6, N7).
**Predecessors:**
- Phase 0: `2026-07-18-meetsy-v2-phase0-foundations-design.md`
- Phase 1: `2026-07-18-meetsy-v2-phase1-ia-home-history-design.md`
- Phase 2: `2026-07-18-meetsy-v2-phase2-evidence-review-design.md`

---

## 1. Purpose

The learning loop already gates & nudges — but everything about it is invisible unless a pattern has fired. IC engineers see the *nudge chip* on a task but cannot answer:

- "How many patterns has the loop learned?"
- "Is the loop *about to* learn something? Am I two corrections away from being nudged?"
- "Does the loop cover the fields I care about — sprint, not just assignee?"
- "How confident is the loop, and what are the thresholds it's using?"

Phase 3 makes the learning loop legible + expands it to a second field. Four PRs — L (FIELDS expansion), M (cache + gate constants + history endpoint), N (near-gate SSE toast), O (`/learning` page + link repoints) — one atomic Phase-3 commit.

---

## 2. What ships (per PR)

| PR | Slice | Backend | Web |
|---|---|---|---|
| **L** | Expand learning to `sprint` in addition to `assignee`. | `FIELDS = ["assignee", "sprint"]`. Snapshot builds a sprint record path. `applyNudges` reads both. `push.service.computeAdjustments` gains a sprint branch (resolves `confirmed.listId → WorkspacePushConfig.sprintLists[].name`). `CorrectionStat` gains a stable `key` (server-computed). | — |
| **M** | Gate constants + snapshot cache + per-pattern history. | Redis KV cache for `LearningSnapshot` (SETEX + DEL on write). `GET /workspaces/:id/learning/gate` (returns `{ minCorrections, minAgreement, nearGateThreshold }`). `GET /workspaces/:id/learning/patterns/:key/history`. | — |
| **N** | Near-gate SSE toast. | `learning:{workspaceId}` Redis channel + publisher inside `logFieldOverride`. `@Sse` at `/workspaces/:id/learning/stream`. | `useLearningStream` hook + Sonner toast: "One more correction and *predicted → confirmed* will start nudging." |
| **O** | `/learning` workspace page + repoint digest-card link + sidebar. | — | New route with three sections (Active / Building up / Coverage). Pattern rows click → history sheet. Plain-English metric labels. |

Order: L → M (backend + independent) → N (backend + web) → O (web page pulls everything together).

---

## 3. Backend design

### 3.1 Sprint learning (PR-L)

**Grounding.** `LearnField` at `learning.service.ts:13` is `"assignee"` only. `FieldPredictionService.predictForTask` already computes `sprint: FieldPrediction` (`field-prediction.service.ts:205`). Neighbours carry sprint (`field-prediction.service.ts:164`). `TaskAdjustmentsSchema.sprint` is defined but never written (`packages/shared/src/review-result.ts:120`). Only asymmetry: on the CONFIRMED side, `push.service.ts:320` stores `listId` in the `confirmed` bundle, not a resolved sprint name.

**Changes:**

```ts
// learning.service.ts:13-18
type LearnField = "assignee" | "sprint";
const FIELDS: LearnField[] = ["assignee", "sprint"];

export interface LearningSnapshot {
  assignee: FieldAggregate;
  sprint: FieldAggregate;
}

export interface TaskAdjustments {
  assignee?: { from: string; to: string; count: number; agreement: number };
  sprint?: { from: string; to: string; count: number; agreement: number };
}
```

**Sprint record building in `snapshot()`.**

```ts
const records: Record<LearnField, FieldRecord[]> = { assignee: [], sprint: [] };
const sprintName = new Map<string, string>(
  ((config?.sprintLists as Array<{ listId: string; name: string }> | null) ?? [])
    .map((s) => [s.listId, s.name]),
);
// ...
records.sprint.push(
  this.toRecord(
    predFieldValue(predicted.sprint),
    confirmed.listId ?? null,
    sprintName,
    adj.sprint,  // ← Phase 3.2 shape
  ),
);
```

`WorkspacePushConfig` has `sprintLists: Json` (`schema.prisma:194`) — same shape as `assignableMembers`. Selected in the existing snapshot query alongside `assignableMembers`.

**Sprint branch in `push.service.computeAdjustments` (`push.service.ts:349`).** Symmetric to the assignee branch. Resolves the pushed `listId` back to a sprint name via the same config:

```ts
if (nudges.sprint) {
  const confirmedListId = ... ; // task.listId ?? config.targetListId (already computed at :201)
  const confirmedName = (config.sprintLists ?? []).find((s) => s.listId === confirmedListId)?.name ?? null;
  out.sprint = { shown: nudges.sprint.to, accepted: confirmedName === nudges.sprint.to };
}
```

The `sprintLists` field must already be typed in `PushConfigView`; it is (`push-config.service.ts:114`).

**Pattern key.** `CorrectionStat` gets a stable slug so the UI URL isn't hand-built:

```ts
export interface CorrectionStat {
  field: LearnField;
  predicted: string;
  confirmed: string;
  count: number;
  agreement: number;
  gatePassed: boolean;
  key: string;  // ← Phase 3, deterministic base64url of `${field}|${predicted}|${confirmed}`
}
```

Computed once inside `aggregateField()` — no callers touch it.

**Legacy runs.** Rows written before this PR have no `adjustments.sprint`; they simply never contribute to the sprint aggregate's nudge sample. Same posture the assignee field already accepts for pre-2c.3 rows.

**Asymmetry called out (deferred).** `confirmed.listId` is not a stable identity for a sprint name — a workspace could rename a sprint list and every historical row's resolved name shifts. We accept this: it's the same failure mode `assignableMembers` name resolution has for assignees today. Cleanest fix (Phase 5-ish) is to also store the resolved name in `confirmed` at push time; not blocking.

### 3.2 Learning cache (PR-M, part 1)

**Problem.** `LearningService.snapshot(workspaceId)` runs `prisma.fieldOverride.findMany({ where: { workspaceId } })` with no limit. Called twice per push flow (`analysis.processor.ts:225` + `push.service.ts:pushTasks` via `logFieldOverride`), plus once per `/learning` page load. At 10k+ pushes this scans the whole `FieldOverride` table every time.

**Design.**

- Cache in Redis (already available — `createRedis()` from `analysis/queue/redis.ts:24`). Reuse the connection pattern that `KbQueue` uses (`kb/kb.queue.ts:5`).
- Key: `meetsy:learning:snapshot:v1:{workspaceId}`. `v1` in the key so a future snapshot-shape change (e.g. adding a third field) doesn't read a stale cache — new servers write to `v2`, old ones read `v1`, no version-check gymnastics.
- Value: `JSON.stringify(LearningSnapshot)`.
- Write path: `SET ... EX 3600` (1h) — belt & suspenders. The authoritative invalidation is the DELETE below.
- Invalidation: `DEL` inside `logFieldOverride` immediately after the successful `FieldOverride.create()` (`push.service.ts:325-336`). Same catch block — a cache failure logs but never blocks the push.
- Miss path: `snapshot()` falls back to the current findMany + write to cache before returning.
- Test hook: introduce a private `LearningCacheService` provider so tests can inject a mock Redis without spinning ioredis.

**Bounded staleness.** A crashed `DEL` between the DB write and the next read means at most `EX 3600` of stale data. Acceptable: nudges only worsen, they don't break.

### 3.3 Gate constants endpoint (PR-M, part 2)

`GET /workspaces/:id/learning/gate` → `{ minCorrections, minAgreement, nearGateThreshold, fields }`. Fields:

```ts
{
  minCorrections: 3,          // learning-aggregate.ts:51
  minAgreement: 0.6,          // learning-aggregate.ts:52
  nearGateThreshold: 2,       // MIN_CORRECTIONS - 1
  fields: ["assignee", "sprint"],
}
```

`workspaces/:id/learning/gate` is a workspace-scoped path but the values are workspace-independent today. When Phase 5's `/tuning` UI lands, this endpoint can read from `WorkspaceMlConfig` — the shape stays the same, only the source changes. Any authed user.

### 3.4 Per-pattern history endpoint (PR-M, part 3)

`GET /workspaces/:id/learning/patterns/:key/history?limit=50` — chronological list of every `FieldOverride` row matching the pattern key. Powers a side sheet on `/learning`.

**Key decode:** `base64url` decode → `${field}|${predicted}|${confirmed}`.

**Query:** loads the same snapshot the summary uses (cache hit), then filters `snapshot[field].corrections`. To get the actual timeline we do NOT re-scan `FieldOverride` in an ad-hoc way — we augment `aggregateField()` to keep the per-record `createdAt` so a filter yields the pattern's row IDs, then a targeted lookup returns metadata. But that inflates the snapshot cache. **Simpler path:** small keyset-paginated query, indexed on `workspaceId` (already present at `schema.prisma:223`), then in-memory filter by predicted/confirmed after resolving names. At Phase 3 scale (workspace <10k FieldOverride rows) this is fine; at 100k+ we add a computed index. `?limit` defaults to 50, capped at 200.

**Response shape:**

```ts
{
  key: string,
  field: LearnField,
  predicted: string,
  confirmed: string,
  count: number,
  agreement: number,
  gatePassed: boolean,
  entries: Array<{
    runId: string,
    meetsyTaskId: string,
    createdAt: string,        // ISO
    nudgeShown: boolean,      // organic vs nudge-influenced
  }>,
}
```

Auth: any authed. Workspace-scoped via `WorkspaceResolver`.

### 3.5 Near-gate SSE toast (PR-N)

**Channel.** Mirror `kbChannel` (`kb.queue.ts:11`): `learningChannel(workspaceId) = 'meetsy-learning:${workspaceId}'`.

**Event shape:**

```ts
interface LearningEvent {
  workspaceId: string;
  field: LearnField;
  predicted: string;
  confirmed: string;
  count: number;              // new count AFTER this write
  at: number;                 // Date.now()
  kind: "near-gate" | "gate-passed";
}
```

**Trigger.** Inside `logFieldOverride` (`push.service.ts:315`), AFTER the `FieldOverride.create` succeeds AND AFTER the cache invalidation:
1. Rebuild the snapshot (already a warm miss because we just DELed the cache — computed once, then written back).
2. For every field in `FIELDS`:
   - Compute the `predicted/confirmed` from this row.
   - Look up the matching `CorrectionStat` in `snap[field].corrections`.
   - If not found (predicted was abstained / row not eligible): skip.
   - If `count === MIN_CORRECTIONS - 1` and `!gatePassed`: publish `kind: "near-gate"`.
   - If `count === MIN_CORRECTIONS` and `gatePassed`: publish `kind: "gate-passed"`.
3. Publish via a dedicated `IORedis` publisher connection (owned by `LearningStreamService`).

**Best-effort:** any failure logs and returns. A missed toast is user-invisible; the next page load re-derives from the snapshot.

**SSE endpoint.** `@Sse("stream")` on `LearningController`, at `/workspaces/:id/learning/stream`. Uses the same Observable pattern as `analysis.service.ts:streamRun` (own Redis subscriber, teardown on client disconnect). Emits every event received on the channel; no late-subscriber catch-up (events are transient — the `/learning` page rebuilds from the summary on load).

**Web hook.** `useLearningStream(workspaceId)` mirrors `useRunStream` — EventSource with `withCredentials: true`; on message, calls `toast(...)` from Sonner (already mounted in `AppShell`). Two toast variants:
- `near-gate` → "One more correction and *Alice → Bob* will start nudging." (subtle, informational)
- `gate-passed` → "The loop learned: *Alice → Bob* — future runs will suggest it." (success tone)

Mounted at `AppShell` level so the toast fires wherever the user is (spec §8 wants it visible during a push). Streams are terminated on workspace switch.

### 3.6 Metric renames (backend contract vs UI labels)

**API shape stays.** `LearningSummaryView.fields[]` continues to expose `rawOverrideRate` / `nudgeAcceptanceRate` / `rawSample` / `nudgeSample` — the honest terms for anyone reading the code. Backwards-compat guaranteed for `LearningPanel` at `components.tsx:1066`.

**UI-facing labels only** (PR-O):

| API field | User-facing label |
|---|---|
| `rawOverrideRate` | "Predictions you changed" |
| `rawSample` | "predictions" |
| `nudgeAcceptanceRate` | "Suggestions you accepted" |
| `nudgeSample` | "suggestions" |
| `MIN_CORRECTIONS` | "corrections to learn" |
| `MIN_AGREEMENT` | "consistency needed" |

The umbrella plan §1 called out `"Raw model accuracy proxy"` at `components.tsx:1024` — that label is replaced on `/learning` and on the digest card; the inline `LearningPanel` is kept as-is (it's inside the push section, a compact audit surface — not primary UX).

---

## 4. Web design (PR-O)

### 4.1 `/learning` route

`apps/meetsy-web/app/learning/page.tsx` — client-side. Three stacked sections, all reading `api.getLearning(workspaceId)` + `api.getGate(workspaceId)` on mount.

**Header:** total corrections across fields, active gates count, coverage summary.

**Section 1 — Active** (patterns that gate today):

```
Assignee            corrections   agreement
────────────────────────────────
Alice → Bob         5             83%      →
Chisty → Rashedul   3             100%     →

Sprint (empty state: "The loop hasn't gated a sprint pattern yet — patterns need 3 corrections with ≥60% consistency.")
```

Each row clickable → `TaskDetailSheet` reused? No — a new `PatternHistorySheet` reused pattern (`components/tasks/task-sheet-context.tsx` pattern with a `pattern-sheet-context.tsx` sibling would be overkill; instead a plain local `useState` for the currently-open pattern key + a controlled `<Sheet>`). Sheet body: pattern description, gate status, then a chronological list from `getPatternHistory(workspaceId, key)`.

**Section 2 — Building up** (near-gate, `count >= 1 && !gatePassed`):

```
Alice → Bob              ●●○   2 of 3 corrections
Sprint-24 → Sprint-25    ●○○   1 of 3 corrections
```

Progress bar shows `count / MIN_CORRECTIONS` per row.

**Section 3 — Coverage** (per field): pretty printout of `rawSample` / `nudgeSample` / `unresolved` with plain-English labels. A "the loop has seen 47 assignee predictions; 12 nudges shown, 8 accepted" style.

### 4.2 Digest-card link repoint (PR-O, part 2)

`apps/meetsy-web/components/learning/digest-card.tsx:117` — "See patterns →" href changes from `/settings/kb` to `/learning`.

### 4.3 Sidebar nav (PR-O, part 3)

`apps/meetsy-web/components/nav/sidebar.tsx` — add "Learning" between "Meetings" and the settings section, using a `Brain` or `Sparkles` lucide icon. Not Owner/Admin-gated — any authed user sees their workspace's loop.

### 4.4 What we do NOT ship in Phase 3

- **Rename `rawOverrideRate` in the API shape** — a mechanical rename would break the still-live `LearningPanel` in `components.tsx`. Rename in UI labels; kill the jargon at the source when Phase 5 tuning replaces the panel.
- **Per-user near-gate toasts** — toasts fire workspace-wide; a nudge earned by another user's correction still teaches the whole workspace, so the notice is workspace-scoped.
- **Backfill historical `adjustments.sprint`** — PR-L only writes forward. Past rows will have empty sprint nudge samples; the aggregate handles that gracefully (`nudgeSample` skew stays honest).

---

## 5. Test plan

Backend (Jest):
- **`learning-aggregate.ts`** unchanged pure logic; existing tests still pass with the added `field` + `key` fields on `CorrectionStat` (extend fixtures).
- **`learning.service.snapshot.spec.ts`** — new spec: given a rows fixture spanning both fields, snapshot returns two aggregates with the right corrections. Sprint's confirmed side resolves via `sprintLists`. Unresolved fallback covered.
- **`learning.service.cache.spec.ts`** — new spec: hitting `snapshot` twice with an injected fake Redis reads DB once + cache once. `logFieldOverride` DELs the cache. Cache read failure falls through to DB.
- **`learning.service.gate.spec.ts`** — new spec: gate endpoint returns `{minCorrections:3, minAgreement:0.6, nearGateThreshold:2}`.
- **`learning.service.history.spec.ts`** — new spec: given 5 rows for a pattern, history returns them chronologically with `nudgeShown` per row.
- **`push.service.retry-log-adjustments-sprint.spec.ts`** — new spec: `computeAdjustments` emits a sprint branch when `nudges.sprint` is set + confirmed listId resolves.
- **`learning-stream.service.spec.ts`** — new spec: near-gate publisher fires exactly once when a pattern crosses to count=2, not fires at count=1 or 3.

Web: typecheck + lint (per the `meetsy-web-next-build-dev-footgun` memory).

---

## 6. Rollout

Order:
1. PR-L (backend expansion) — new columns not required; only schema addition is `key` on `CorrectionStat` which is a wire-format extension.
2. PR-M (cache + gate + history) — introduces `LearningCacheService`, `LearningStreamService` doesn't exist yet but the cache is standalone.
3. PR-N (near-gate SSE) — needs cache from M (snapshot-after-write path uses cache warm-miss).
4. PR-O (`/learning` page) — consumes all three.

Single atomic Phase-3 commit at the end (Phase 1/2 precedent).

**No migration** — Phase 3 is Redis + endpoints + wire-format extensions, no schema changes.

---

## 7. Risks

- **`sprintLists` mutation.** A workspace renaming a sprint list changes the resolved name — historical rows silently reclassify. Documented in §3.1; mitigation deferred.
- **Cache write race.** Two concurrent pushes both DEL cache, both rebuild; last writer wins. Acceptable — rebuilds are idempotent + `EX 3600` bounds staleness.
- **SSE proliferation.** Each open `/learning` page holds an EventSource. Nest's `@Sse` decorator handles teardown; the KB stream (`kb.controller.ts:99`) already survives production. Same rate expected here.
- **Pattern key collisions.** `base64url("assignee|Alice|Bob")` and `base64url("assignee|Ali|ce|Bob")` differ because `|` is preserved in base64url. Safe.
- **Cache invalidation misses.** If `DEL` errors while `SET` succeeds, we get up to `EX 3600` of stale reads. Log + move on; no correctness bug.

---

## 8. Open questions

- **Should sprint history rely on `confirmed.listId` OR store the resolved name too?** Lean: leave as-is for now, mirror the assignee-name-resolution pattern. Cleanup in Phase 5.
- **`AppShell` toast placement.** Sonner's `Toaster` is already mounted at `AppShell` (`apps/meetsy-web/app/AppShell.tsx`). The `useLearningStream` hook mounts inside `WorkspaceProvider` so switching workspaces re-subscribes. Correct posture.
- **Empty-state copy.** "The loop hasn't learned a pattern yet" — vs — "3 more corrections and the loop starts learning." Lean: use the latter when there's ≥1 building-up pattern; the former when there are zero corrections of any kind.
