# Meetsy v2 — Reorganization, Evidence, Learning-Trust, Tuning (Umbrella Plan)

**Date:** 2026-07-18
**Status:** Proposal — product-owner approved 2026-07-18 (audience = IC engineers, full redesign, `WorkspaceMlConfig` approved, learning-loop expanded to include `sprint`).
**Builds on:** `docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md` (Phases 0–3 complete).
**Companion spec (Phase 0):** `docs/superpowers/specs/2026-07-18-meetsy-v2-phase0-foundations-design.md`.

> Phases 0–3 of the 2026-06-27 plan built the *engine*: shared auth, `meetsy` schema, ClickUp write-back, RAG KB, smart-assign + learning loop. This plan (v2) rebuilds the *cockpit*: information architecture, evidence surfacing, learning-loop trust, KB legibility, and per-workspace tunables — with the review UX tuned for **IC engineers checking their assignments** (evidence expanded by default, chips clickable, keyboard-first).

---

## 1. Why now

The platform works. Every task in a run already carries three predictions (sprint / duplicate / owner) plus a nudge chip when the learning gate fires. But four things block trust and adoption:

| Problem | Symptom in code (grounded) |
|---|---|
| **The review page does everything** | `apps/meetsy-web/app/runs/[runId]/*` is ~1200 lines rendering stepper + tasks + push editor + chat + learning inside one route. No home, no history, no way back to a past run except URL memory. |
| **Evidence is computed but not shown** | `assignment.ranked[]` (full owner ranking), `evidenceTaskIds` (up to 5 precedent tasks per candidate), `FieldPrediction.candidates[]` (sim-weighted distribution), `kbContext.sourceId` — all in the API payload, none rendered. Every taskId shown in a chip is dead text; no endpoint resolves it. |
| **The learning loop is invisible until it fires** | The panel at `components.tsx:1021-1024` filters `gatePassed === true` and drops the tail. Users cannot see a pattern building up (2/3 corrections in). Metric labels use jargon (`"Raw model accuracy proxy"`). |
| **The KB is legible only during onboarding** | `GET /workspaces/:id/kb/search` (hybrid RRF) and `GET /workspaces/:id/kb/documents/:docId` exist and have no UI. There is no way to browse or inspect what the model knows. |

Plus a silent-loss bug: `AnalysisRun.result`'s extra keys (`kbContext`, `fieldPredictions`, `duplicates`, `assignment`, `adjustments`) are stripped by `analysis.service.ts:227` on every feedback submit and every chat-added task — so a run's evidence disappears the first time it's touched.

---

## 2. Audience decision (locked)

**IC engineers checking assignments** are the primary user. This changes every downstream call:

- Evidence panels default to **expanded**, not collapsed.
- Every provenance chip (`CU-01H...`) is **clickable → side sheet** with title/owner/status/link.
- Review page gets **keyboard traversal** (j/k between tasks, esc closes sheet).
- Push editor becomes a **secondary tab**, not the default view.
- Nudges are framed as **"here's what your team taught the model"**, not "click accept to be faster."

---

## 3. The six phases (dependency graph)

```
                     ┌─────────────────────┐
                     │ Phase 0             │
                     │ Foundations         │
                     │ (design + backend)  │
                     └──────────┬──────────┘
                                │
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
   │ Phase 1: IA     │  │ Phase 2:        │  │ Phase 3:        │
   │ shell + home +  │  │ evidence-first  │  │ learning trust  │
   │ runs list       │  │ review page     │  │ + tuning        │
   └────────┬────────┘  └────────┬────────┘  └────────┬────────┘
            └──────────┬─────────┴────────┬───────────┘
                       ▼                  ▼
              ┌─────────────────┐  ┌─────────────────┐
              │ Phase 4:        │  │ Phase 5:        │
              │ /kb consolida-  │  │ /tuning surface │
              │ tion            │  │ (owner)         │
              └────────┬────────┘  └────────┬────────┘
                       └────────┬───────────┘
                                ▼
                     ┌─────────────────────┐
                     │ Phase 6:            │
                     │ cross-cutting UX    │
                     │ (dark, keyboard,    │
                     │  a11y, mobile)      │
                     └─────────────────────┘
```

### Phase table

| Phase | Delivers | Blocking prereqs | Backend footprint |
|---|---|---|---|
| **0 — Foundations** | Signal-loss fix. `WorkspaceMlConfig` + `AnalysisRunSnapshot` migrations. Task-lookup + runs-list endpoints. `ReviewResultSchema` in `@ma/shared`. shadcn/ui + lucide + next-themes + toast provider. | — | ~4 endpoints, 2 tables, 1 shared schema. |
| **1 — IA + Home + History** | Left sidebar, `/home`, `/meetings` list, `/runs/:id` re-scaffolded with tabs (Overview/Push/Chat/Insights). Per-user learning digest. Full-text search across past runs. | Phase 0 | `GET /workspaces/:id/learning/me`, `GET /workspaces/:id/runs/search?q`, tsvector column + GIN index. |
| **2 — Evidence-first review** | Task cards with expanded evidence. Every chip clickable → side sheet. Attach raw top-5 kNN neighbours to `run.result`. Push retry queue. | Phase 0 | Push-retry BullMQ queue + `PushDeadLetter` table + `POST /runs/:id/push/retry`. |
| **3 — Learning trust** | `/learning` workspace page (Active / Building up / Coverage). Expose gate constants in API. Rename jargon metrics. **Expand `FIELDS = ["assignee", "sprint"]`**. Near-gate SSE toast when a pattern is 1 correction from gating. | Phase 0 | `GET /workspaces/:id/learning/patterns/:key/history`, learning cache, `FIELDS` expansion, SSE channel. |
| **4 — /kb consolidation** | Single `/kb` route (Overview / Tasks / Documents / Search / Rebuild). Global ⌘K command palette hits `kb/search`. Retire `/onboarding` full-page redirect (becomes an in-page banner on `/kb`). | Phase 0 | `GET /workspaces/:id/kb/tasks?cursor&filter`. |
| **5 — /tuning (Owner)** | Per-workspace tunables (dup bands, sim floor, gate values, model routing). Preview endpoint replays last-N runs against candidate config. Every past run carries an `AnalysisRunSnapshot` for reproducible preview. | Phase 0 | `GET|PUT /workspaces/:id/ml-config`, `POST /workspaces/:id/ml-config/preview`, `meetsy-ml-preview` BullMQ queue. |
| **6 — Cross-cutting UX** | Dark mode audit, keyboard shortcuts, empty states, skeleton loaders, landmark `<nav>`/`<main>`, focus-ring pass, `prefers-reduced-motion`, mobile-safe review. | Phases 0–5 | — |

---

## 4. Backend changes at a glance

Grouped by "required" (uncovered by audits) vs "new-ideas" (proposed on top of the plan; product-owner welcomed backend additions).

### 4.1 Required (blocking) changes

| # | Change | Phase | File / area |
|---|---|---|---|
| R1 | `.passthrough().parse()` at `loadRunContext` | 0 | `apps/meetsy-api/src/analysis/analysis.service.ts:227` |
| R2 | `mergeSignals(assembled, ctx.result)` before persist in feedback + chat writes | 0 | `analysis.service.ts:295-298`, `:363-367` |
| R3 | `ReviewResultSchema` in `@ma/shared` — extends `AnalysisResultSchema` with 5 optional signal keys, backed by proper Zod for `KbContextHit / TaskPrediction / DuplicateHit / TaskAssignment / TaskAdjustments` | 0 | `packages/shared/src/*` |
| R4 | `SubmitFeedbackResponseSchema.result` and `SendChatResponseSchema.result` switch to `ReviewResultSchema` | 0 | `packages/shared/src/feedback.ts:36,68` |
| R5 | Delete web-side local `ReviewResult` interface; use shared schema | 0 | `apps/meetsy-web/app/runs/[runId]/signals.tsx:70-76` |
| R6 | `WorkspaceMlConfig` model + migration | 0 | `apps/meetsy-api/prisma/schema.prisma` |
| R7 | `GET /workspaces/:id/clickup/tasks/:taskId` — task lookup | 0 | new `TasksLookupController` |
| R8 | `GET /workspaces/:id/runs` — paginated run list | 0 | new endpoint on `AnalysisController` |

### 4.2 New-idea backend additions

| # | Idea | Phase | Rationale |
|---|---|---|---|
| N1 | `AnalysisRunSnapshot` (frozen `mlConfig` + model routing per run) | 0 (migration) / 5 (write path) | Without it, `/tuning`'s "preview last N runs" is a lie — past runs used different constants. Also enables honest "this run used gpt-5.5 high" display. |
| N2 | Full-text search across past runs (`tsvector` on `Meeting.transcript` + `AnalysisRun.result.overview` + task titles) | 1 | ICs ask "which meeting talked about OAuth again?" |
| N3 | Per-user learning digest (`GET /workspaces/:id/learning/me`) with weekly bucketed accuracy | 1 & 3 | Personal accuracy trend answers "is the model getting better at predicting me?" |
| N4 | Attach raw top-5 kNN neighbours per task to `run.result.neighboursByTask` | 2 | Currently thrown away at `field-prediction.service.ts:70-72`. The strongest per-task provenance the pipeline computes. |
| N5 | Push retry queue + dead-letter | 2 | Failed pushes have no retry path today; row is stuck with `status="failed"`. |
| N6 | Learning cache (Redis, invalidated on `logFieldOverride`) | 3 | `LearningService.snapshot()` loads *every* FieldOverride per call — will hurt at 10k+ pushes. |
| N7 | Near-gate SSE toast when pattern crosses `count === MIN_CORRECTIONS - 1` | 3 | Combines with UI progress meter — delightful for ICs who feel the model is a black box. |
| N8 | `POST /workspaces/:id/ml-config/preview` (replay last N runs) | 5 | Makes tuning safe: preview the impact of a threshold change before committing. Needs N1. |

### 4.3 Deferred (mentioned so they can be pulled back)

- Cross-run task linking ("this task in run A is a continuation of task in run B").
- Full comment threads on tasks (feature creep).
- Realtime multi-user editing of a run (over-engineered for meeting-per-day cadence).
- Org-wide prediction dashboards (the workspace-level `/learning` page already covers).

---

## 5. Rough sequencing

```
   Week 1-2   Phase 0     backend leak fixes + design system + endpoints + migrations
   Week 3     Phase 1     sidebar + home + history + search
   Week 4-5   Phase 2     evidence-first review page (the big one)
   Week 6     Phase 3     learning trust + sprint learning + near-gate SSE
   Week 7     Phase 4     /kb consolidation
   Week 8     Phase 5     /tuning + preview replay
   Week 9     Phase 6     polish: dark, keyboard, a11y, mobile
```

Each phase gets its own formal spec under `docs/superpowers/specs/` before implementation, following the pattern set by the 2026-06-27 phase specs.

---

## 6. Success criteria (v2 is done when)

1. A user lands on `/home` after login, sees their recent runs, and can navigate to any past run without URL memory.
2. Every prediction chip on a task card is **clickable** and opens a side sheet with the past ClickUp task's title/status/owner/URL.
3. `assignment.ranked[]`, `evidenceTaskIds`, and `FieldPrediction.candidates[]` are **visibly rendered**, not tooltip-only.
4. A user can see patterns **building up** in the learning loop (2/3 corrections, near-gate), not just active nudges.
5. The learning loop covers both `assignee` and `sprint`.
6. An Owner can adjust duplicate bands / sim floor / gate values from `/tuning`, preview the impact against last-N historical runs, and save without a deploy.
7. `/kb` is one route with search, browse, upload, and rebuild all in tabs.
8. Feedback + chat mutations no longer strip evidence from `AnalysisRun.result`.
9. Dark mode works end-to-end; keyboard traversal (j/k) works on the review page.

---

## 7. Documentation discipline (unchanged from v1)

- Every phase gets its own spec under `docs/superpowers/specs/`.
- `docs/meetsy/BUILD-JOURNAL.md` is append-only and updated as part of every implementation PR.
- `CLAUDE.md`'s Meetsy pointer is updated to list this plan first when the task touches v2 surfaces.

---

## 8. Open questions (resolve during implementation, not blocking approval)

- **Where does `AnalysisRunSnapshot` write?** Cleanest: inside `analysis.processor.ts:235-254` (the completed-run write), snapshotting `WorkspaceMlConfig` at that moment. Historical runs before Phase 5 get no snapshot — preview endpoint gracefully skips them.
- **Learning cache TTL vs. hard invalidation.** Lean: hard invalidation on `logFieldOverride` write; no TTL (cache is only expensive to rebuild, not stale-sensitive).
- **`ReviewResultSchema` extension pattern.** Lean: `AnalysisResultSchema.extend({...})` producing a new named schema in `@ma/shared`, so future signal keys are added there once.
- **Global ⌘K palette location.** Lean: mount inside `AppShell` (adjacent to `WorkspaceSwitcher`); Command component from shadcn/ui.
