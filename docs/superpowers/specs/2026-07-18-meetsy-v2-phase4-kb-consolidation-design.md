# Meetsy v2 — Phase 4: `/kb` consolidation (design)

**Date:** 2026-07-18
**Status:** Design (locked before implementation)
**Umbrella plan:** `docs/superpowers/plans/2026-07-18-meetsy-v2-plan.md` §3 (Phase 4 row) + §4 (no new N-numbered addition; single required endpoint).
**Predecessors:**
- Phase 0: `2026-07-18-meetsy-v2-phase0-foundations-design.md`
- Phase 1: `2026-07-18-meetsy-v2-phase1-ia-home-history-design.md`
- Phase 2: `2026-07-18-meetsy-v2-phase2-evidence-review-design.md`
- Phase 3: `2026-07-18-meetsy-v2-phase3-learning-trust-design.md`

---

## 1. Purpose

The knowledge base is real: `GET /workspaces/:id/kb/search` (hybrid RRF), `GET /workspaces/:id/kb/documents` (upload + honest metric), `GET /workspaces/:id/kb/summary` ("what we learned"), `GET /workspaces/:id/kb/status` (embedding progress) — all built by Phase 2a/2a.1/2b/2c and never surfaced together. The KB is inspectable only during the seven-step first-run onboarding wizard at `/onboarding`, and re-embeddable only from the deeply-buried `/settings/kb`. Users cannot browse what the model knows.

Two consequences today:

- **KB is a black box for anyone past the first-run.** After onboarding, `/onboarding` never renders again (the `KbGate` in `AppShell.tsx:130` only redirects there when status ≠ `ready`), so `SummaryStep`'s "what we learned" facts + narrative are seen exactly once. Documents live in a nested step inside the wizard; there is no route the user can bookmark.
- **The seven-step wizard is heavy for a one-shot flow that must never rerun.** Users route through it once, and the codebase carries two callers of the same building blocks (`app/onboarding/steps.tsx` shared between `/onboarding/page.tsx` and `/settings/kb/page.tsx`) plus a full-page redirect gate that has one job: catch idle workspaces.

Phase 4 replaces both routes with **one canonical KB surface**, `/kb`, with five tabs — Overview (summary + status), Tasks (paginated embedded-task list), Documents (upload + list), Search (`kb/search` explorer), Rebuild (re-embed the same `KbBuildPanel` the wizard uses). The `/onboarding` full-page redirect retires — an idle KB is signaled by an **in-page banner on `/kb`** (with the same "Start onboarding" affordance the wizard's step 5 has). A **global ⌘K palette** wires the sidebar to the same `kb/search` endpoint from anywhere in the app.

Four PRs — P (backend `/kb/tasks` endpoint), Q (`/kb` shell + Overview/Documents/Search/Rebuild tabs), R (Tasks tab wired to PR-P + retire `/onboarding`), S (global ⌘K palette in `AppShell`) — one atomic Phase-4 commit.

---

## 2. What ships (per PR)

| PR | Slice | Backend | Web |
|---|---|---|---|
| **P** | Paginated embedded-task list. | `GET /workspaces/:id/kb/tasks?cursor&filter&limit`. Returns the ClickUp tasks that have at least one `KbChunk` row for this workspace, most-recently-updated first, with `?filter=<query>` narrowing on task name / client / assignee via a case-insensitive `ILIKE`. Cursor is `updatedDate|taskId` (stable across ties). Any authed user. | — |
| **Q** | `/kb` shell + four tabs (Overview / Documents / Search / Rebuild). | — | New route `apps/meetsy-web/app/kb/page.tsx` with shadcn `<Tabs>`. Overview reuses `FactsSummary` (moved out of `/onboarding/steps.tsx` into `app/kb/facts-summary.tsx`) + status card. Documents tab reuses the wizard's `DocumentsStep` body (extracted). Search tab: a search box + result list backed by `api.kbSearch`. Rebuild tab: the same `KbBuildPanel` + scope/range form the settings page has today. |
| **R** | Tasks tab + retire `/onboarding`. | — | New Tasks tab wired to `GET /kb/tasks` with keyset paging + a debounced filter box. `KbGate` (`AppShell.tsx:130`) stops redirecting; if status ≠ `ready`, `/kb` renders an idle **banner** with a "Start onboarding" button that flips into `KbBuildPanel`. `/onboarding/page.tsx` deleted; `/onboarding/steps.tsx` moves to `app/kb/steps.tsx` (single-caller). Sidebar's "Learning" stays; **new "Knowledge base" entry** replaces the buried `/settings/kb` link. Old `/settings/kb` route stays but redirects to `/kb?tab=rebuild` (one-line `redirect()` — external bookmarks don't break). |
| **S** | Global ⌘K palette. | — | `apps/meetsy-web/components/nav/command-palette.tsx` — shadcn `<CommandDialog>` mounted inside `AppShell`. `⌘K` (or `Ctrl+K`) toggles. Two groups: **Navigation** (Home / Meetings / Learning / Knowledge base / Push settings if OWNER/ADMIN) and **Search knowledge base** (debounced `api.kbSearch(workspaceId, q)` — each hit navigates to `/kb?tab=search&q=...`; source hits with a `taskId` open the existing `TaskDetailSheet`). |

Order: P (backend, independent) → Q (web shell, no delete) → R (wire Tasks + retire onboarding) → S (palette, orthogonal).

---

## 3. Backend design

### 3.1 `GET /workspaces/:id/kb/tasks` (PR-P)

**Grounding.** The KB embeds ClickUp tasks into `KbChunk` (`schema.prisma:293`) with `sourceType='clickup_task'` and `sourceId=<clickUpTaskId>`. Task metadata lives in the read-only `public.clickup_tasks` mirror (`schema.prisma:546`). A "browseable task list for the KB" = the join of the two, deduped on `sourceId` (a task can have multiple chunks — chunk 0, 1, 2 …).

**Endpoint:**

```
GET /workspaces/:id/kb/tasks?cursor=<opaque>&filter=<q>&limit=<n>
```

- `cursor` (optional): opaque keyset cursor. First page omits it.
- `filter` (optional): case-insensitive substring match against `taskName`, `client`, or `assigneesNames`.
- `limit` (optional): default 50, capped 100.

**Response:**

```ts
{
  tasks: Array<{
    taskId: string;
    taskName: string;
    url: string | null;
    status: string | null;
    client: string | null;
    assigneesNames: string | null;  // ClickUp gives us a comma-separated string
    updatedDate: string | null;     // ISO
    chunkCount: number;             // how many KbChunk rows point at this task
  }>;
  nextCursor: string | null;         // null when the page is the last
  total: number;                     // matches the current filter, workspace-scoped
}
```

**Query shape.**

Two-table join, keyset paged on `(updatedDate, taskId)` for a stable tiebreaker (both `updatedDate` and `taskId` can appear on multiple rows if a task was embedded with a null-updated date; the composite key breaks ties without a sort key that isn't the index):

```sql
-- Distinct tasks that have at least one KbChunk in this workspace, filtered.
SELECT ct.task_id, ct.task_name, ct.url, ct.status, ct.client,
       ct.assignees_names, ct.updated_date, COUNT(kc.id) AS chunk_count
FROM public.clickup_tasks ct
JOIN meetsy.kb_chunks kc
  ON kc.source_type = 'clickup_task' AND kc.source_id = ct.task_id
WHERE kc.workspace_id = $1
  AND ct.is_deleted = false
  AND ($filter IS NULL OR (
       ct.task_name ILIKE $filter
    OR ct.client ILIKE $filter
    OR ct.assignees_names ILIKE $filter
  ))
  AND ($cursor IS NULL OR (
       ct.updated_date < $cursor_updated
    OR (ct.updated_date = $cursor_updated AND ct.task_id < $cursor_taskId)
  ))
GROUP BY ct.task_id
ORDER BY ct.updated_date DESC NULLS LAST, ct.task_id DESC
LIMIT $limit + 1;
```

- Filter parameter is `%q%`, computed server-side; `q` is trimmed and length-capped at 100 chars in the controller.
- Rows with `updated_date = NULL` come last (Postgres default `NULLS LAST` for `DESC`); the cursor treats NULL as a sentinel — we page NULLs with the `taskId` tiebreaker alone once the cursor's `updated_date` is null.
- `LIMIT + 1` peek: if the extra row came back, the last row's `(updated_date, taskId)` is the `nextCursor`; we drop the extra before returning.

**Cursor encoding.** `base64url(JSON.stringify({u: iso-or-null, t: taskId}))`. Malformed → 400. Older clients that hand back a v1 cursor unchanged after a schema tweak get a 400 rather than silent skew.

**Total count.** A separate `SELECT COUNT(DISTINCT task_id)` with the same filter. Cheap at Phase 4 scale (workspace <10k KbChunk); when a workspace scales past that we cache the count for 60s.

**Prisma vs raw SQL.** Prisma's `groupBy` doesn't support the `LIMIT+1` keyset shape cleanly and its `count.distinct` doesn't compose with keyset paging without two round-trips. Use `prisma.$queryRawUnsafe` for the paged query + a `prisma.$queryRawUnsafe` for the count. Both parameterised via Prisma's tagged template to avoid injection.

**Auth.** Any authenticated user; workspace-scoped via `WorkspaceResolver` (same pattern as every other `KbController` endpoint).

**Tests (`kb.controller.tasks.spec.ts`):**

1. First page: returns 50 rows for a workspace with 100 KbChunk tasks; `nextCursor` non-null; `total` matches the seeded count.
2. Second page (using PR-1's `nextCursor`): returns the next 50, no overlap, `nextCursor` null.
3. Filter narrows: `?filter=alice` returns only tasks whose name/client/assignee contains "alice" (case-insensitive).
4. Deleted tasks excluded: seeded `is_deleted=true` rows don't appear even if chunks exist.
5. Cursor malformed → 400.
6. Wrong workspace → 404 (WorkspaceResolver).

---

## 4. Web design

### 4.1 The `/kb` shell (PR-Q)

**Route.** `apps/meetsy-web/app/kb/page.tsx` — client component. Reads `?tab=` from `useSearchParams()`, defaulting to `overview`. Uses shadcn `<Tabs>` from `components/ui/tabs.tsx`.

**Role gate.** Members can read Overview / Tasks / Documents / Search. Only Owner/Admin sees the Rebuild tab (mirrors `/settings/kb`'s Owner/Admin gate). If a Member deep-links `?tab=rebuild`, the tab is silently omitted; the shell falls back to Overview.

**Layout.**

```
Page header ─ "Knowledge base" + workspace name + status tag (Ready | Building… | Idle | Error)
Tabs ─ [Overview] [Tasks] [Documents] [Search] [Rebuild*]
────────────────────────────────────────────────────────────────
Idle banner (rendered ABOVE tab contents when status.status !== "ready"):
  "Your knowledge base isn't set up yet. Start onboarding to embed your
   ClickUp task history — only takes a few minutes."
  [Start onboarding]  ← Owner/Admin only; Member sees a read-only note.
────────────────────────────────────────────────────────────────
{tab contents}
```

**Tab bodies.**

- **Overview**: reuses `FactsSummary` + `formatWhen` (extracted verbatim from `app/onboarding/page.tsx:493-739` into `app/kb/facts-summary.tsx`). Above it: the same `StatusCard` from `app/settings/kb/page.tsx:166` (also extracted → `app/kb/status-card.tsx`), showing embedded count, last built, scope, range.
- **Tasks** (PR-R wires the data — Q ships an "empty tab" placeholder that becomes real in R).
- **Documents**: extracts the `DocumentsStep` body from `app/onboarding/page.tsx:748-890` into `app/kb/documents-tab.tsx`. Same upload / list / delete calls (`api.kbListDocuments` · `api.kbUploadDocument` · `api.kbDeleteDocument`). Loses the "Finish"/"Skip" wizard footer.
- **Search**: a `<Input>` with a debounced (300ms) trigger that calls `api.kbSearch(workspaceId, q, 20)`. Results render as a card list — `{sourceType chip · title · score · snippet}` — and a click on a `clickup_task` hit opens the existing `TaskDetailSheet` from `components/tasks/task-detail-sheet.tsx`. Reads `?q=` on mount so the palette (PR-S) can deep-link.
- **Rebuild** (Owner/Admin): the current `KbSettings` body from `app/settings/kb/page.tsx:91-125` extracted into `app/kb/rebuild-tab.tsx` — `StatusCard` + `UpdateForm` (spaces / sub-scope / range) + `KbBuildPanel`.

**Where the shared pieces live.** Everything the tabs need moves into `apps/meetsy-web/app/kb/*.tsx` — the tab bodies (`overview-tab.tsx`, `tasks-tab.tsx`, `documents-tab.tsx`, `search-tab.tsx`, `rebuild-tab.tsx`) plus the small extracts (`facts-summary.tsx`, `status-card.tsx`). `app/kb/steps.tsx` receives the moved `onboarding/steps.tsx` verbatim (PR-R deletes the old path).

**Tab-URL sync.** Setting a tab pushes `router.replace(`/kb?tab=${tab}`)` — shallow, no server round-trip. This makes tabs bookmark-friendly and lets ⌘K palette (PR-S) deep-link into Search with a query string.

### 4.2 Retire `/onboarding` full-page redirect (PR-R)

**Grounding.** `AppShell.tsx:130-189` (`KbGate`) currently redirects any non-`/onboarding` route to `/onboarding` when `status ≠ ready`. `/onboarding/page.tsx` renders the seven-step wizard. PR-R inverts this: `KbGate` becomes a no-op (renders children unconditionally), and the KB idle state is signaled from `/kb` itself.

**Changes.**

- **`AppShell.tsx`** — `KbGate` is deleted. `SignedInShell` renders `children` directly. The KB status fetch that lived inside `KbGate` moves inside `/kb/page.tsx` (where it was going to fetch anyway).
- **`/onboarding/page.tsx`** — deleted.
- **`/onboarding/steps.tsx`** — moved to `app/kb/steps.tsx` (single caller after PR-R: `rebuild-tab.tsx`). All imports across the repo updated.
- **`/settings/kb/page.tsx`** — replaced with a one-line `redirect("/kb?tab=rebuild")` (Next.js server `redirect` from `next/navigation`). External bookmarks don't break; the settings sidebar entry is retired.
- **`sidebar.tsx`** — the `SETTINGS` array loses its `{ href: "/settings/kb", ... }` entry. `PRIMARY` gains `{ href: "/kb", label: "Knowledge base", icon: Database }` (or a `BookOpen` / `Database` lucide icon — whichever reads best under the "Meeting Analyzer" logo).

**Idle-state UX on `/kb`.** When `kbStatus.status !== "ready"`:

- Member: read-only note "The knowledge base isn't set up yet. Ask an Owner or Admin to configure it."
- Owner/Admin: banner with a "Start onboarding" button. Click flips the Overview tab body into a `<KbBuildPanel>` seeded with `range: "3m"` and no scope (the wizard's "range-only onboard" default). Rebuild tab remains available with the fuller scope picker.

**Why this is safe.** `KbGate`'s only job was catching the first-run. That job now lives inside `/kb`. The other gate we care about — the auth gate — remains outermost in `AppShell` and is untouched. No other route depends on `KbGate` returning `<Spinner>` mid-decision; every other page already handles its own workspace-null / status-null states (see `learning/page.tsx`, `meetings/page.tsx`, etc.).

**Landing after signup.** Post-signup, Clicksy redirects the user to `/home` (unchanged). If a user hits `/home` before onboarding, `/home` renders normally (its data endpoints tolerate an unbuilt KB — `me` learning digest returns zeros). The visible "Knowledge base" sidebar entry with the idle banner surfaces the missing setup organically, no forced redirect.

### 4.3 Tasks tab data flow (PR-R)

**Route params.** `?tab=tasks&filter=<q>&cursor=<c>` — filter is echoed to the URL so browser back is honest. Cursor stays local (never in URL — it's opaque and rotates).

**Hook.** `useKbTasks(workspaceId, filter)` — internally uses a small paginator. On mount / filter change, fetches page 1 and stores the returned `nextCursor`; a "Load more" button fetches the next page and appends. Filter input is debounced 300ms and cancels in-flight requests via an `AbortController`.

**Row action.** Click → open `TaskDetailSheet` (the existing side sheet from Phase 2's PR-K). The sheet already knows how to render a ClickUp task by `taskId` in a workspace.

**Empty states.**

- KB idle (`status !== "ready"`): tab renders "Tasks appear here once onboarding embeds them" (no fetch).
- Ready + zero rows: "No tasks embedded yet. Run Rebuild to include a wider range."
- Ready + filter with no matches: "No embedded tasks match '{query}'. Clear filter to browse everything."

### 4.4 Global ⌘K command palette (PR-S)

**Grounding.** `cmdk` is installed and shadcn's `command.tsx` is already generated (`apps/meetsy-web/components/ui/command.tsx:4`). No new deps.

**Mount point.** `apps/meetsy-web/components/nav/command-palette.tsx`, rendered inside `SignedInShell` in `AppShell.tsx` next to `<Toaster>`. Owns its open state via a shared context or a keydown handler on `window` for `⌘K` / `Ctrl+K`.

**Groups.**

1. **Go to** — static nav entries: Home, New meeting, Meetings, Learning, Knowledge base. Owner/Admin sees Push settings + Knowledge base rebuild (`/kb?tab=rebuild`). Selecting → `router.push(href)`, close palette.
2. **Search knowledge base** — dynamic. As the user types in `<CommandInput>`, calls `api.kbSearch(workspaceId, q, 8)` debounced 250ms. Each hit is a `<CommandItem>` labeled `{sourceType icon · title · score}`. Selecting a `clickup_task` hit → `router.push("/kb?tab=search&q=" + encodeURIComponent(q))` and closes; a `document` hit → `router.push("/kb?tab=documents")`. (We don't jump the user directly into the task detail sheet from the palette — the palette closes first, then the search tab renders in-context and the user can click the row for the sheet. Keeps the palette a nav shortcut, not a data view.)

**Empty states.** No workspace resolved yet → palette input disabled with placeholder "Loading workspace…". No query → only the "Go to" group renders (search list stays empty). Query with no hits → "No matches" `<CommandEmpty>`.

**Keyboard.** `⌘K` / `Ctrl+K` toggles. `Esc` closes (shadcn default). Enter selects. Arrow keys navigate (cmdk default).

**Persistence.** Palette state is ephemeral (no `?q=` in URL). Reopening starts blank.

---

## 5. Migration & shared-package changes

- **No Prisma schema changes.** PR-P reads existing tables (`KbChunk` + `ClickupTask`) via raw SQL. No new migration files. The two prior unapplied migrations (`20260718150000_meetsy_v2_phase1_run_search` + `20260718200000_meetsy_v2_phase2_push_dead_letter`) still ride `prisma migrate deploy` on the next deploy.
- **No `@ma/shared` changes.** The `/kb/tasks` response is Meetsy-internal (only the web app calls it); its DTO lives in `apps/meetsy-api/src/kb/kb.dto.ts` (Zod schema, but not exported to shared).

---

## 6. Tests

- **API**: `kb.controller.tasks.spec.ts` — 6 tests as enumerated in §3.1.
- **Web**: no jest suite in `apps/meetsy-web` (per Phase 3's pattern; verification is typecheck + `next lint`). New tabs must be typecheck-clean and lint-clean; visual verification is manual.

Existing test counts hold (`53 suites / 293 tests` after Phase 3). PR-P adds one new suite → target **54 suites / 299 tests**.

---

## 7. Verify path

Same discipline as Phase 3:

- `pnpm --filter @ma/api typecheck`
- `pnpm --filter @ma/web typecheck`
- `pnpm --filter @ma/web lint`
- `npx jest` inside `apps/meetsy-api`

`next build` intentionally skipped (see `meetsy-web-next-build-dev-footgun` memory).

---

## 8. Landmines (called out early)

- **`KbGate` deletion.** Everything currently relies on `KbGate` to catch first-run. Grep every page under `apps/meetsy-web/app` for hard `router.replace("/onboarding")` or path checks against `/onboarding` before deleting. Only `AppShell.tsx` should touch onboarding paths today; PR-R must audit and remove any strays.
- **Legacy `/settings/kb` link in emails / docs.** The redirect handles it, but the sidebar and any in-app help text needs to point to `/kb?tab=rebuild`.
- **`redirect()` inside a client component.** `/settings/kb/page.tsx` becomes a **server component** so `next/navigation`'s `redirect()` works; the current file is `"use client"`. Rewrite it fully as a server component that only calls `redirect()`.
- **Palette + workspace switch races.** The palette lives INSIDE `SignedInShell` (which is inside `WorkspaceProvider`), so `useWorkspace()` is safe. But `kbSearch` calls inside the palette must use the CURRENT `activeWorkspaceId` — reader hook, not a captured closure. Otherwise a workspace switch mid-open would fire the search against the previous workspace.
- **Filter injection.** `%q%` for `ILIKE` — Prisma's tagged raw template escapes it, but the caller must NOT string-concatenate the filter into the SQL. Everything goes through `$queryRaw` parameter placeholders.
- **Cursor stability under insert traffic.** ClickUp comments/updates rewrite `updated_date` on the mirrored task, which can push a task forward past the current cursor. Consequence: a task the user has already seen may re-appear on a later page. Acceptable for a browse UI; documented in the tab's help text ("browsing embedded tasks — sorted by most recent update").

---

## 9. Deferred (Phase 4+ candidates)

- **KB search facets.** Right now `/kb/search` returns hits unfiltered; a Phase 4+ pass could add `?sourceType=clickup_task|document` and expose those as chips above the results list.
- **Task drilldown → embedding provenance.** The Task tab links to `TaskDetailSheet`; a future pass could show WHICH chunk of the task is embedded + its score against a given query.
- **Palette history.** Recent searches are not persisted; Phase 6 (cross-cutting UX) could add local-storage backing.
- **`kb/search` result excerpt highlighting.** The API returns snippets; the palette + search tab could bold the matched span.
- **Sidebar re-arrangement.** Once Phase 5 lands, "Push settings" + "Knowledge base rebuild" together outweigh "primary" nav entries and the sidebar may want a two-column layout.
