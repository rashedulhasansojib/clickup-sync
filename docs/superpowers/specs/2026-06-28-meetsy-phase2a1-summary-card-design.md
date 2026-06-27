# Meetsy Phase 2a.1 — "What We Learned" Onboarding Summary Card (Design Spec)

**Date:** 2026-06-28
**Status:** Draft
**Phase:** Meetsy 2a.1 (after 2a KB slice ✅; before 2b docs / 2c pipeline)
**Plan:** `docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md`
**Depends on:** 2a (KB onboarding embeds tasks); reads Clicksy's mirrored `clickup_tasks` (+ events/time-entries)

---

## Summary

After a workspace is onboarded (2a), show the user a **profile card of the connected
client/team**: who's on the team and what each person historically owns, the main components/areas,
throughput/volume, recurring categories, and where work gets stuck. **Every number is exact
aggregate SQL** over the mirrored ClickUp data; **one** gpt-5.4-mini pass writes a short narrative
on top. Honest by construction — the facts are queryable; only the prose is generated.

**Done when:** `GET /workspaces/:id/kb/summary` returns `{ facts, narrative, generatedAt }` where
`facts` are SQL aggregates (roster+ownership, components, throughput, blockers, clients) and
`narrative` is a single short LLM paragraph; verified on **real Nifty history**.

## Goals / Non-goals
**Goals:** SQL-first facts (cheap, exact, no hallucination) + one LLM narrative; a single endpoint + a card the onboarding UI renders.
**Non-goals:** embedding-cluster themes (v1 derives "areas" from labels/lists; clustering is a later refinement); the improvement metric (2b); per-person dashboards (Phase 3). No new writes to `public`.

## 1. Facts (aggregate SQL over the mirror — no LLM, no hallucination)
All scoped `WHERE workspace_id = :ws AND is_deleted = false`, over `public.clickup_tasks`
(+ `clickup_time_entries`, `clickup_task_events`):
- **Roster + ownership:** distinct assignees (from `assignees_names`/`assignees_emails`); per assignee, their top components (by `list_name`/`folder_name`/`tags`) and open/closed counts → "who historically owns what."
- **Components/areas:** top `list_name`/`folder_name`/`tags` by task volume.
- **Throughput:** tasks created vs closed per week (trend, last N weeks); open vs closed totals; **median cycle time** = `closed_date − created_date` for closed tasks (and, when available, time-in-status from `clickup_task_events`).
- **Recurring categories:** `status` distribution; top `tags`; `client`/`department`/`sprint_name` breakdowns (Clicksy already extracts these).
- **Workload:** tracked hours per user from `clickup_time_entries` (last N days) — current load signal.
- **Blockers:** overdue open tasks (`due_date < now()` and not closed); long-stale (no `updated_date` in N days); reopened (closed→open transitions in `clickup_task_events`).
- **Coverage meta:** total tasks embedded, date range covered, comment-coverage % (`commentsSyncedAt` set).

Each fact is a parameterized query in a `SummaryFactsService` (Prisma `$queryRaw` where needed for
group-bys). Cheap and exact.

## 2. Narrative (ONE gpt-5.4-mini pass)
Feed the computed fact tables + ~50 sampled task titles (recent + high-volume components) to a
single `structured()` call (gpt-5.4-mini, low effort): produce a 1–2 paragraph "here's what this
team works on, who drives which areas, and where things get stuck." The model **summarizes the
provided facts only** (no new numbers); validated against a small zod shape. Cheap (cents).

## 3. Caching
Persist the generated card in `meetsy` (`KbSummary` row per workspace: `facts Json`, `narrative`,
`generatedAt`, `taskCountAtGen`). Regenerate on explicit request or when onboarding completes / the
embedded count moves materially. The card reads from cache; a `?refresh=1` recomputes.

## 4. Endpoint + UI
- `GET /workspaces/:id/kb/summary?refresh=` (any auth; workspace-scoped) → `{ facts, narrative, generatedAt }`.
- meetsy-web onboarding screen renders a **profile card**: roster with ownership chips, top-components bar, throughput sparkline, blockers list, client/dept breakdown (all SQL) + the narrative paragraph (LLM). (UI is a thin add to the onboarding/status view; can land with 2a.1 or just behind the endpoint first.)

## 5. Testing
- **Unit:** each fact query's shape (mock Prisma / a small fixture set); the narrative builder (mock the LLM; assert it's fed the facts + sampled titles and returns the validated shape); cache get/regenerate logic.
- **Live (on real Nifty):** mirror a Nifty space's tasks (Clicksy backfill with the Nifty token), onboard, `GET …/kb/summary` → the roster matches real assignees, components match real lists/folders, throughput/blockers are sane, and the narrative reads true. **This is the first card built on genuine 3-year history.**

## 6. Risks
| Risk | Mitigation |
|---|---|
| Narrative invents numbers | LLM gets only computed facts + titles; prompt forbids new figures; facts shown separately (the source of truth) |
| Assignee parsing (comma-joined names/emails) | Defensive split; fall back to emails; dedupe |
| Cost on big workspaces | Facts are SQL (≈free); ONE LLM call regardless of task count; cache |
| Cycle-time/blockers depend on event history depth | Degrade gracefully (use closed−created when events are thin); label coverage in the card |
| Stale card after new tasks | Regenerate on onboarding/embed-count change or `?refresh=1` |

## 7. Open questions
- Themes via embedding clustering now vs label-derived areas in v1 (lean: label/component-derived areas first; clustering as a refinement).
- How many weeks/days for throughput/workload windows (lean: 12 weeks throughput, 30 days workload — configurable).
