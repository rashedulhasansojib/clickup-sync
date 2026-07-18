# Meetsy v2 Phase 1 — IA + Home + History (Design Spec)

**Date:** 2026-07-18
**Status:** Draft — awaiting product-owner approval before implementation
**Phase:** 1 of 6 (see `docs/superpowers/plans/2026-07-18-meetsy-v2-plan.md`)
**Prerequisites:** Phase 0 landed (`feat/meetsy-phase0` commits `35c064b` + `1bc972f`)

---

## Summary

Phase 1 gives Meetsy an information architecture: a persistent left sidebar, a
`/home` landing that shows recent runs plus a per-user learning digest, a
`/meetings` history list with full-text search across past runs, and a
tab-scaffolded `/runs/:id` page (Overview / Push / Chat / Insights) so IC
engineers stop scrolling a ~1200-line single-column view.

The endpoints called out in the v2 plan §4 (`GET /workspaces/:id/runs`,
`GET /workspaces/:id/clickup/tasks/:taskId`) already landed in Phase 0. Phase 1
adds two more: `GET /workspaces/:id/runs/search?q` and
`GET /workspaces/:id/learning/me`. A `tsvector` column + GIN index on `Meeting`
backs the search.

**Phase 1 is "done" when:**

1. Every authenticated user lands on `/home` after login (not the upload form)
   and sees their most recent runs without touching the URL bar.
2. A left sidebar (Home, Meetings, New meeting, KB, Push settings, KB settings)
   is present on every signed-in page; the upload form moves from `/` to
   `/new`.
3. `GET /workspaces/:id/runs/search?q=` returns paginated runs whose meeting
   title, task titles, or transcript match `q`. Search UI lives on `/meetings`
   with a debounced input; empty `q` returns the plain paginated list.
4. `GET /workspaces/:id/learning/me` returns per-user weekly-bucketed override
   / nudge-acceptance counts. The `/home` "Learning digest" card renders it.
5. `/runs/:id` renders the existing sections behind shadcn `Tabs` (Overview /
   Push / Chat / Insights) with no loss of state across tab switches.
6. Existing test suite passes; new tests added below all pass.

## Goals / Non-goals

**Goals**
- IA that ICs can navigate without URL memory (v2 §6.1).
- Search across a growing run history (v2 §4 N2).
- Personal learning trend surface (v2 §4 N3).
- Room for later phases to add tabs (`Insights` becomes the evidence surface in
  Phase 2, `Push` tab is a hook for the retry queue in Phase 2, `Learning`
  card links out to Phase 3's full page).

**Non-goals (later phases)**
- Rendering `assignment.ranked[]`, `evidenceTaskIds`, or
  `FieldPrediction.candidates[]` — that's Phase 2.
- Expanding `FIELDS = ["assignee"]` to include `sprint` — Phase 3.
- Cross-workspace search — always scoped by active workspace.
- Real-time (SSE) updates on `/home`. Poll on mount + focus is enough.
- ⌘K palette — installed in Phase 0 but wired in Phase 4.
- Dark-mode toggle in the header — Phase 6.

---

## 1. Sidebar shell (PR-D)

### 1.1 Replace `AppShell`'s brand row with a two-column layout

Today `AppShell` renders a horizontal `<Brand>` header with the workspace
switcher + a couple of settings links, then `<main class="mx-auto max-w-5xl
px-6 py-8">`. Phase 1 replaces that with:

```
┌────────────────────────────────────────────────────────────┐
│  ┌─Sidebar─────┐  ┌─Content───────────────────────────────┐│
│  │ Brand       │  │ (page-specific top bar, if any)       ││
│  │             │  │                                       ││
│  │ ▸ Home      │  │  {children}                           ││
│  │ ▸ New       │  │                                       ││
│  │ ▸ Meetings  │  │                                       ││
│  │ ▸ KB        │  │                                       ││
│  │ ─────────   │  │                                       ││
│  │ Workspace ▾ │  │                                       ││
│  │ ─────────   │  │                                       ││
│  │ Settings    │  │                                       ││
│  │  Push       │  │                                       ││
│  │  KB         │  │                                       ││
│  │ ─────────   │  │                                       ││
│  │ email@…     │  │                                       ││
│  └─────────────┘  └───────────────────────────────────────┘│
└────────────────────────────────────────────────────────────┘
```

**Files touched:**
- `apps/meetsy-web/app/AppShell.tsx` — rewrite `SignedInShell` layout.
- `apps/meetsy-web/app/layout.tsx` — no change beyond Phase 0.
- **New:** `apps/meetsy-web/components/nav/sidebar.tsx` — a `Sidebar` component
  that renders the nav sections + workspace switcher + user email.

The sidebar is **sticky top-0**, `w-64` on `md+`, and collapses to an off-canvas
`Sheet` (using `@/components/ui/sheet` from Phase 0) on mobile. Mobile trigger
is a `<button>` with a `lucide-react` `Menu` icon in a slim top bar.

**Auth gate + KbGate stay outermost.** The sidebar renders inside the same
`SignedInShell` block that today owns `<WorkspaceSwitcher>` and `<KbGate>`, so
the load-bearing behavior (children unmounted until `me()` resolves, keyed
remount on workspace switch) is preserved verbatim.

### 1.2 Nav items

| Item | Href | Icon (lucide) | Roles |
|---|---|---|---|
| Home | `/home` | `Home` | All authed users |
| New meeting | `/new` | `Plus` | All authed users |
| Meetings | `/meetings` | `ListChecks` | All authed users |
| KB | `/settings/kb` | `Database` | Owner / Admin (same gate as today's link) |
| Push settings | `/settings/push` | `Send` | Owner / Admin |

`KB` reuses the existing `/settings/kb` route rather than introducing `/kb` now
— the KB consolidation route belongs to Phase 4.

Active-route highlighting uses `usePathname()` + a `startsWith` check (so
`/runs/:id` doesn't highlight anything, but `/settings/kb/documents` still
highlights KB).

### 1.3 `/` becomes a redirect

Move the upload form file `apps/meetsy-web/app/page.tsx` → `apps/meetsy-web/app/new/page.tsx`.
Replace `app/page.tsx` with a client-side `useEffect(() => router.replace("/home"), [])`
+ a `Spinner` fallback (same pattern as the `KbGate` redirect). Server-side
redirects can't run inside the client-gated `AppShell` — we already do the auth
check client-side, so a client `router.replace` is consistent.

### 1.4 Import migration

The moved `app/new/page.tsx` still imports from `@/app/ui`; leave those imports
as-is (they route through the Phase-0 `ui.tsx` → `ui-legacy` shim). This spec
does **not** migrate any caller to shadcn — Phase 1 introduces `Sidebar` as a
brand-new component that uses `@/components/ui/*` directly, and every other
page keeps the legacy look.

---

## 2. `/home` (PR-D + PR-F)

### 2.1 Layout

```
Recent runs                     Learning digest
────────────                    ────────────────
[Card row × 5]                  Weekly accuracy sparkline
                                Overrides / week (last 6w)
                                Nudge acceptance (last 6w)
"View all →" /meetings          "See patterns →" /settings/kb (Phase 3 upgrades)
```

Two-column on `md+`, stacked on mobile.

### 2.2 Recent-runs card

Reuses `api.listRuns(workspaceId, { limit: 5, offset: 0 })` (already exported
from `lib/api.ts` — verify then wire, don't re-implement).

Each card shows: meeting title, meeting date (or "no date"), status pill,
push-status badge (`not_pushed | partial | pushed`), task count, relative
`createdAt`. Whole card is `<Link href={`/runs/${item.id}`}>`.

Empty state: "No runs yet. **Analyze a meeting →** `/new`."

### 2.3 Learning-digest card (PR-F)

Calls the new `GET /workspaces/:id/learning/me` (§4). Renders three rows for
the current user only:

- **Weekly accuracy** — a `Sparkline`-style sequence of 6 dots; each dot is
  the `1 - overrideRate` for that week, colored zinc/green by direction.
- **Corrections** — total per week (small bar chart, 6 bars).
- **Nudge acceptance** — `accepted / shown` per week; abstains ("no nudge
  shown that week") render as an empty ring.

The card links to `/settings/kb` for now (Phase 3's `/learning` route replaces
that link).

Empty state (no overrides yet): "No corrections logged yet. As you review runs
and push tasks, we'll show a weekly trend here."

### 2.4 Sparkline component

New: `apps/meetsy-web/components/charts/sparkline.tsx`. Zero deps — hand-drawn
SVG rectangles/circles. Six data points is the sweet spot for visual density
vs. noise; do not pull in a charting lib for this. The signature:

```ts
export function Sparkline({
  data,
  format,
  className,
}: {
  data: Array<{ label: string; value: number | null }>;
  format?: (v: number) => string;
  className?: string;
}): JSX.Element;
```

---

## 3. `/meetings` history + search (PR-D + PR-E)

### 3.1 Layout

```
Meetings                                    [🔎 search meetings]

Filter: All | Pushed | Not pushed | Failed
────────────────────────────────────────────
[Row: title · date · status · push · tasks]
[Row: … ]
[Row: … ]

← Prev  · Page N ·  Next →
```

`limit=20` per page (matches the endpoint default). Query-string state:
`?q=…&status=…&page=N`.

### 3.2 Search UX

- Debounced 300ms on the input; empty `q` uses the plain
  `GET /workspaces/:id/runs` endpoint.
- Non-empty `q` calls the new `GET /workspaces/:id/runs/search?q=…&limit&offset&status=…`.
- Loading state: keep last results, show a `Spinner` over the top of the list
  (`opacity-50 pointer-events-none`).
- No-results state (with query): "No runs match **{q}**." + a "Clear search"
  link that resets `?q=`.

### 3.3 Row shape

Same fields as the `/home` card row. Row is `<Link href={`/runs/${id}`}>`.
Push status is a colored badge (`not_pushed=zinc`, `partial=amber`, `pushed=green`).

### 3.4 Deep-link behavior

The initial render reads the query-string, so pasting a link to
`/meetings?q=OAuth` opens the correctly-filtered view. Every filter change
`router.replace()`s the query-string (does not push history entries — filter
churn shouldn't fill the back stack).

---

## 4. Runs search endpoint (PR-E)

### 4.1 `GET /workspaces/:id/runs/search?q&limit&offset&status`

**Purpose:** full-text search over the workspace's run history. Backs `/meetings?q=…`.

**Query params:**
- `q` — required, 1–200 chars. Whitespace-trimmed. Empty → 400.
- `limit` — default 20, clamped 1–100 (same as `listRuns`).
- `offset` — default 0, clamped ≥0.
- `status` — optional (`queued|running|completed|failed`), unknown → dropped.

**Response:** `RunListView` — reuses the existing schema. This is not a
new type — same rows, same total, same pagination shape. The client can render
search results with the same component that renders the plain list.

### 4.2 Implementation

New method on `AnalysisService`:

```ts
async searchRuns(
  workspaceId: string,
  opts: { q: string; limit: number; offset: number; status?: RunStatus },
): Promise<RunListView>
```

The query joins `AnalysisRun ↔ Meeting` on `meetingId` and filters where
`Meeting.tsv @@ plainto_tsquery('english', $q)`, ordered by
`ts_rank_cd(Meeting.tsv, plainto_tsquery('english', $q)) DESC, AnalysisRun.createdAt DESC`.

Prisma doesn't type `tsvector` (see the KbChunk precedent — `tsv` is DB-only
on `KbChunk`). Same treatment here: use `$queryRaw`/`$queryRawUnsafe` for the
search branch, then batch-fetch the same push-status extras the plain
`listRuns` already computes.

**Why not a Prisma extension?** No stable path; the raw approach mirrors
`KbSearchService` (`kb.service.ts` in Phase 2). Keep the pattern.

### 4.3 Search corpus: which columns feed the tsvector?

Attribute Meeting.tsv from:
- `Meeting.title` (weight `A`)
- `Meeting.transcript` (weight `C`)
- **Not** `AnalysisRun.result.tasks[].title` — task titles live in a JSONB
  field of a different table, and syncing them into a tsvector requires either
  a materialized view or a trigger. Phase 1 defers that; the transcript already
  contains the task discussion verbatim. If we hit the "user searched for a
  task title but the transcript summarized it" gap in practice, Phase 2 or 3
  adds a `Meeting.taskTitles TEXT[]` sync + folds it into the tsvector.

### 4.4 Migration

New hand-authored SQL under
`apps/meetsy-api/prisma/migrations/YYYYMMDDHHMMSS_meetsy_v2_phase1_run_search/migration.sql`:

```sql
-- Meetsy v2 Phase 1 — full-text search over meeting transcripts.
-- HAND-AUTHORED. Emits DDL for the `meetsy` schema ONLY. Do NOT apply here.
--
-- `tsv` is DB-only (Prisma can't model tsvector). Generated column pattern —
-- Postgres 12+ recomputes on every INSERT/UPDATE without a trigger, and the
-- GIN index means search is O(log n). Weights: title=A (highest), transcript=C.

ALTER TABLE "meetsy"."Meeting"
  ADD COLUMN "tsv" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("transcript", '')), 'C')
  ) STORED;

CREATE INDEX "Meeting_tsv_idx" ON "meetsy"."Meeting" USING GIN ("tsv");
```

Prisma schema gains a **comment-only** hint (matching the `KbChunk` precedent
at schema line ~252):

```prisma
model Meeting {
  ...
  // v2 Phase 1 — a `tsv` tsvector column exists in DB (generated from title+transcript)
  // with a GIN index; Prisma can't model tsvector so it's DB-only. See migration
  // 20260718150000_meetsy_v2_phase1_run_search.
}
```

Backfill is automatic (generated column). Zero rows need updating.

### 4.5 Controller

Adds a sibling method on `AnalysisController`:

```ts
@Get("workspaces/:id/runs/search")
async searchRuns(
  @CurrentUser() user: AuthPrincipal,
  @Param("id") id: string,
  @Query("q") q?: string,
  @Query("limit") limitParam?: string,
  @Query("offset") offsetParam?: string,
  @Query("status") statusParam?: string,
): Promise<RunListView> { ... }
```

Same clamping as `listRuns`. Empty/whitespace-only `q` → `throw new BadRequestException`.

### 4.6 Web API

```ts
// apps/meetsy-web/lib/api.ts
searchRuns(workspaceId, { q, limit, offset, status }): Promise<RunListView>
```

Client parses the response through `RunListViewSchema` (reused).

---

## 5. Per-user learning digest endpoint (PR-F)

### 5.1 `GET /workspaces/:id/learning/me`

**Purpose:** answer "is the model getting better at predicting **me**?" A
per-user, weekly-bucketed rollup of the same signals the workspace-wide
summary at `GET /workspaces/:id/learning` reports.

The `LearningController` already exists. Add one endpoint alongside `summary`:

```ts
@Get("me")
async me(@CurrentUser() user: AuthPrincipal, @Param("id") id: string): Promise<LearningMeView> {
  const workspaceId = await this.workspaces.resolve(user.orgId, id);
  return this.learning.meSummary(workspaceId, user.userId);
}
```

### 5.2 View shape

```ts
// packages/shared/src/learning.ts
export interface LearningMeWeek {
  weekStart: string;         // ISO date (Monday, UTC)
  overrides: number;         // FieldOverride rows this user pushed this week
  agreements: number;        // predicted == confirmed
  nudgesShown: number;       // adjustments.assignee.shown != null
  nudgesAccepted: number;    // adjustments.assignee.accepted === true
}
export interface LearningMeView {
  userId: string;
  totalOverrides: number;
  weeks: LearningMeWeek[];   // last 6, oldest first, zero-padded (weeks with 0 pushes show 0s)
}
```

### 5.3 Data source: join FieldOverride → TaskPush

`FieldOverride` does not carry a `userId` column today (schema.prisma:202-220).
Every `FieldOverride` is written by `PushService.logFieldOverride` from inside
`PushService.push`, which is invoked with the current user's id and creates a
`TaskPush` row (`pushedBy` column) at line 236 of schema. **A single query
joins `FieldOverride` → `TaskPush` on `(runId, meetsyTaskId)`** and filters by
`TaskPush.pushedBy = $userId`.

Nested `include` in Prisma cannot cross the composite key, so use `$queryRaw`
for the join. Aggregate in JS (bucket by ISO week of `FieldOverride.createdAt`,
sum by bucket). The workspace-wide `LearningService.summary` already loads
FieldOverride rows one at a time — this endpoint's per-user filter is
strictly less work.

**Alternative considered — add `userId` to FieldOverride:** simpler to query
but adds a migration + a write-time change + a "old rows have null userId"
back-compat branch. The join is cheap enough for the 10k-row scale the
learning cache in v2 §4 N6 targets; defer the denormalization to when the
learning-cache work happens.

### 5.4 Tests

Service-level, colocated `learning.service.me-summary.spec.ts`:
- Zero overrides → all six weeks zeroed, `totalOverrides === 0`.
- Overrides span 8 weeks → only the last 6 returned, oldest first.
- Same run pushed by two users → `me(userA)` and `me(userB)` see disjoint
  numbers even though `runId` matches.

---

## 6. `/runs/:id` tabbed scaffold (PR-G)

### 6.1 Structure

Wrap today's `page.tsx` body sections in shadcn `Tabs`:

| Tab | Content (today) | Phase-1 change |
|---|---|---|
| Overview | `ResultsSection` | render as-is |
| Push | `PushSection` | render as-is |
| Chat | `ChatPanel` | render as-is |
| Insights | (nothing yet) | placeholder card: "Learning + evidence surface — coming in Phase 3." |

Default active tab: `Overview`. The URL fragment (`#push`) selects a tab if
present; on tab change we `router.replace(#tab)` so a shared link opens on the
right tab.

### 6.2 State preservation

Chat history + in-flight fetches must not restart on tab switch. shadcn `Tabs`
mounts every `TabsContent` by default and toggles visibility via
`data-state="inactive"` — nothing to add. Verify manually: switch to `Push`,
`Chat`, back to `Overview`; chat history and open menus stay put.

### 6.3 Stepper visibility

The `PipelineStepper` renders **above** the tabs (outside them). While a run
is not settled, only the stepper + spinner show and the tabs are hidden. Once
`result` lands, the tabs appear.

### 6.4 Files touched

- `apps/meetsy-web/app/runs/[runId]/page.tsx` — wrap `ResultsSection` /
  `PushSection` / `ChatPanel` in `<Tabs>`. ~30 lines diff.
- No changes to `components.tsx` or `signals.tsx`.

---

## 7. Rollout order

Ship as four sequential PRs on `feat/meetsy-phase0` (the branch still owns v2
work until v2 lands on `main`):

1. **PR-D — sidebar + /home + /meetings history (frontend only)**
   Uses existing `listRuns`. No backend changes.
2. **PR-E — runs search backend + UI**
   Migration + endpoint + `/meetings` search box wiring.
3. **PR-F — per-user learning digest backend + /home card**
   Endpoint + `/home` `Learning digest` card.
4. **PR-G — /runs/:id tabbed scaffold**
   Frontend-only, tabs wrap the existing sections.
5. **PR-H — verify + BUILD-JOURNAL entry**
   Not a code PR — journal update + full verify table.

PR-D is safe to land first (frontend only, no schema); PR-E is highest risk
(new migration on a possibly-populated table); PR-F depends on nothing new
and can go before or after PR-E; PR-G is purely cosmetic.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| The generated `tsvector` column can't be added to a huge `Meeting` table without a lock | Zero rows today at deploy time (Meetsy is still onboarding). If it grows before Phase 1 ships, split into `ALTER TABLE ... ADD COLUMN` (nullable) + `UPDATE` batch + `SET NOT NULL` — but Postgres 12+ generated columns are populated inline, so a large-table migration is unavoidable regardless. Ship early. |
| Prisma introspects the generated `tsv` column and tries to manage it | Never run `prisma migrate dev` for meetsy-api — hand-authored migrations only, per the `0001_init` header. `prisma db pull` would surface `tsv`; if it does, mark it `@ignore` in the model. |
| `router.replace()` on debounced search causes a history-stack war | Use `router.replace()` for filter/query changes (documented in §3.4). Only page-shape route changes (`push /new`) use `router.push`. |
| The sidebar takes screen real estate and the run-review page needs it back | The sidebar is a fixed 256px on `md+`; the run page's content column drops from `max-w-5xl` to `max-w-4xl` to compensate. Verify visual on the review page after PR-G. |
| Tabs mount every panel — `ChatPanel`'s `useEffect` fires eagerly even if the user never opens Chat | Already true today (the panel mounts unconditionally in page.tsx). No regression. |
| `me()` join query is O(N) FieldOverrides — hurts at 10k+ | The workspace-wide summary already reads every FieldOverride per call (§5.3). Same order. The Redis learning cache in v2 §4 N6 is the fix; it lives in Phase 3. |
| The `Meeting.tsv @@ plainto_tsquery` search returns weak matches on short queries | Fold `websearch_to_tsquery` in later if users complain — `plainto_tsquery` is the safe default (no special-char handling to worry about). |

---

## 9. Testing

Following the audit's conventions (service-level unit tests, colocated
`*.spec.ts`; controller tests avoided).

### 9.1 Search endpoint (blocking)

New `apps/meetsy-api/src/analysis/analysis.service.search-runs.spec.ts`:
- Seed two meetings A (`title:"OAuth planning"`) and B
  (`transcript:"we shipped Grafana"`), each with one completed run.
- `searchRuns(ws, {q:"oauth",limit:20,offset:0})` returns A only.
- `searchRuns(ws, {q:"grafana",...})` returns B only.
- Empty `q` → thrown validation (guarded in controller, so this test is a
  service-level guard: assert the service does not fall back to
  unfiltered `findMany` if q is empty).
- Cross-workspace isolation: seed WS2 with a matching meeting; `searchRuns(WS1)`
  does not return it.

### 9.2 Learning-me endpoint (blocking)

New `apps/meetsy-api/src/kb/learning.service.me-summary.spec.ts` — cases
enumerated in §5.4.

### 9.3 Migration test

- Fresh DB → apply migration → `SELECT tsv FROM meetsy."Meeting"` returns a
  tsvector (verifiable via `pg_typeof`).
- INSERT a Meeting with `title:"OAuth"` → `SELECT tsv @@ plainto_tsquery('oauth')`
  returns true.
- GIN index exists: `SELECT indexname FROM pg_indexes WHERE tablename='Meeting'
  AND indexname='Meeting_tsv_idx'`.

### 9.4 Web-side smoke

- `/home` renders 5 recent runs from a seeded API mock.
- `/meetings?q=oauth` fires exactly one debounced request 300ms after keystrokes stop.
- `/runs/:id#push` opens on the Push tab.
- Sidebar's active-route highlight matches the current pathname's prefix.

---

## 10. Open questions (resolve during implementation, not blocking approval)

- **Search rank vs. recency ordering.** Lean: `ts_rank_cd DESC, createdAt DESC`
  — rank first (relevance) with recency as the tiebreaker. Watch for the
  "most recent match sinks behind an older, more relevant one" case; if it
  becomes a complaint, swap to `createdAt DESC, ts_rank_cd DESC`.
- **`/home` empty-state UX for a signed-up user with no data.** Lean: instead
  of the two empty cards, show a single centered call-to-action:
  "Welcome to Meetsy — [Analyze your first meeting]."
- **Sidebar collapse on desktop.** Not in Phase 1. Add if the review page's
  content column feels cramped after PR-G ships.
- **Should the tab hash be `?tab=push` or `#push`?** Lean: `#push` — it's
  local to the client, doesn't need to survive a server reload, and doesn't
  pollute the query-string that search + filter own.
