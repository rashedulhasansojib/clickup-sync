# Meetsy Phase 2c — Pipeline Integration (KB context, field prediction, dedup, HITL push) (Design Spec)

**Date:** 2026-06-28
**Status:** **APPROVED 2026-06-28** — build slice-by-slice. Locked decisions: (1) **slice 2c.1 → 2c.2 → 2c.3**, each built + live-verified + committed before the next; (2) 2c.2 predicts **client / sprint·component / due / estimate** (abstain-first); **assignee is a soft hint only** — confident smart-assignment is Phase 3; (3) **all live-verify pushes go to a throwaway list on the test team `90181854711`** (Chishty) — the Nifty production team `3450636` stays READ-ONLY, never written; (4) abstain default = predict only if top-1 neighbour share ≥ 0.5 **and** support ≥ 3; (5) sprint = pick the target **list** (Sprints ClickApp; we never create lists).
**Phase:** Meetsy 2c (after 2a KB ✅, 2a.1 card ✅, onboarding fixes ✅, 2b docs+metric ✅) — the last Phase-2 slice; precedes Phase 3 (smart-assign + learning loop)
**Plan:** `docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md` (Phase 2 table, row 2c)
**Depends on:** 2a (`KbChunk` + `KbSearchService` hybrid retrieval), 2b (`KbDocument` chunks + doc↔task links), Phase 1 (`WorkspacePushConfig`, `TaskMapperService`, `PushService`), the existing analysis pipeline (`analyzeMeeting`→`criticPass`→`enrichTasks`), `SummaryFactsService` cycle-time.

---

## Summary

This is where the KB finally **pays off in the product**: a transcript no longer becomes tasks in a
vacuum — it becomes tasks **grounded in the client's 3-year ClickUp history + uploaded docs**, with
**weak, evidence-backed predictions** for the fields a human still confirms (client, sprint, points,
assignee, due), and **duplicate-awareness** against existing work. The human stays in the loop on
every field; nothing is auto-applied or auto-merged.

Concretely, 2c adds four capabilities, each wired into the **existing** pipeline/push (no fork):
1. **KB context injection** — retrieve relevant history (tasks + 2b docs) and feed it to
   `analyzeMeeting` / `criticPass` / `enrichTasks` so extracted tasks are grounded, de-jargoned, and
   consistent with how this team actually writes work.
2. **Field prediction (weak prior)** — for each extracted task, a kNN-over-history prior +
   LLM-adjudication **clamped to the neighbours' observed range**, surfaced as a **suggestion with
   evidence and a confidence, that ABSTAINS when the signal is thin**. Never a confident point value.
3. **Duplicate detection** — flag likely-duplicate existing tasks (cosine **≥ 0.90 flag**, **0.82–0.90
   suggest**, **never auto-merge**) so the user doesn't re-create existing work.
4. **HITL push extension** — extend the Phase-1 review→push so the user confirms **sprint** (= target
   ClickUp list), **client** (= dropdown custom field, set by option UUID), and **points** (top-level
   `points`), all editable; **every override is logged** as the Phase-3 learning signal.

Plus **pre-analysis incremental remap**: before analysing a meeting, ensure the workspace KB is
current (the 2a worker's cursor + content-hash incremental embed; upsert-only, no full re-index).

**Done when:** uploading a transcript for an onboarded workspace produces review-ready tasks that
(a) show retrieved-history context, (b) carry abstain-aware field suggestions with evidence,
(c) flag probable duplicates, and (d) push with confirmed sprint/client/points into ClickUp — all
verified on real Nifty data, with **no task created in production without explicit confirmation**.

## Goals / Non-goals
**Goals:** ground the pipeline in the KB; honest weak field prediction (abstain-first); dupe-awareness;
HITL sprint/client/points on the push; override logging for Phase 3; incremental remap before analysis.
**Non-goals (Phase 3+):** the learning loop that *consumes* the override log to improve predictions;
fully-automatic assignment; auto-merge of duplicates; multi-workspace rollout. No new writes to
`public`. No confident point-predictions. No bypass of human confirmation on the ClickUp write.

## ⭐ Recommended slicing (each its own build + live-verify, per the spec-driven discipline)
2c is large; build + live-verify in three slices under this one umbrella spec:
- **2c.1 — Context injection + incremental remap** (retrieval broadened to include 2b docs; injected
  into analyze/critic/enrich; remap-before-analyze). Lowest risk, immediately visible.
- **2c.2 — Field prediction + duplicate detection** (kNN priors + clamped LLM + abstain; dupe flags).
- **2c.3 — HITL push extension** (sprint/client/points config + mapper + review UI + override log).
Each slice ends green + live-verified + journal/RESUME updated before the next.

---

## 1. KB context injection (2c.1)
- **Retrieval:** generalize `KbSearchService.search` to accept a `sourceTypes` filter so it can return
  **tasks AND documents** (today it hard-filters `sourceType='clickup_task'` — the 2b-deferred bit).
  Add a `retrieveContext(workspaceId, queryText, { k, sourceTypes })` that returns ranked snippets +
  provenance (task id / document id).
- **Where injected (existing stages, unchanged signatures + an optional `context` arg):**
  - `analyzeMeeting` — retrieve on the meeting summary/topics; inject "how this team describes similar
    work" so titles/descriptions match house style and jargon resolves.
  - `criticPass` — inject likely-duplicate/related tasks (see §3) so the critic can flag overlap.
  - `enrichTasks` — inject the matched-task neighbours so estimates/tags/components are consistent.
- **Honesty:** injected context is **reference, not ground truth** — prompts say "use as context; do
  not invent facts not in the transcript." Provenance is retained so the UI can show "grounded in
  task X / doc Y."

## 2. Field prediction — weak prior, abstain-first (2c.2)
For each extracted task, predict the **fields a human confirms**: `client`, `component/sprint`,
`assignee`, `estimate`, `dueDate`. Mechanic (per the locked research):
- **kNN prior:** embed the task card, fetch its K nearest **historical task** chunks (existing
  `KbChunk` metadata already carries `client`/`component`/`assignee`/`status`/`taskUpdatedAt`). Derive
  a prior = the distribution of each field across neighbours (e.g. client = the modal client among
  the K nearest, with its support count).
- **LLM adjudication CLAMPED to the neighbour range:** the LLM may only choose among values the
  neighbours actually exhibit (it cannot invent a client/sprint that doesn't exist in history). For
  `dueDate`, the range is **p50/p80 of cycle-time** for similar tasks (reuse `SummaryFactsService`'s
  `percentile_cont` over `closed_date − created_date`), anchored at the meeting date.
- **ABSTAIN when thin:** if the neighbours are few or disagree (e.g. support < a threshold, or top-1
  share < a margin), the prediction is **"unknown — not enough similar history"**, NOT a guess. This
  is the single most important honesty rule of the slice.
- **Surface as suggestion + evidence + confidence:** every prediction shows the neighbour tasks it
  came from and a confidence; it is a **default the user can change**, never auto-applied. Correlation
  is weak (~0.34, recorded) — present as a hint, not a fact.

## 3. Duplicate detection (2c.2)
For each extracted task, hybrid-search existing tasks; classify by top cosine similarity:
- **≥ 0.90 → flag** ("very likely already exists: task X") — surfaced prominently; user decides.
- **0.82–0.90 → suggest** ("possibly related: task X") — softer hint.
- **< 0.82 → ignore.** **Never auto-merge / never auto-skip the push.** Shown in the review UI with a
  link to the existing ClickUp task.

## 4. HITL push extension (2c.3)
Extend Phase-1 `WorkspacePushConfig` + `TaskMapperService` + the review screen:
- **Config additions (per workspace):** the **client dropdown** custom-field id + its options
  (`{ optionId(UUID), name }`, fetched from ClickUp's `type_config.options`); the **sprint** model =
  selectable target **lists** (Sprints ClickApp = a sprint is its list — no Sprint API); whether
  **points** (top-level `points`) is enabled. Stored on `WorkspacePushConfig` (new JSON columns) or a
  sibling table; populated via a "refresh ClickUp field options" admin action.
- **Mapper additions (`TaskMapperService.map`):** when confirmed, add `custom_fields: [{ id, value:
  optionUUID }]` for client, set top-level `points`, and route the create to the chosen sprint **list**
  (the push already targets a list id — sprint selection picks which list).
- **Review UI:** the Phase-1 PushSection gains editable **sprint / client / points** controls
  pre-filled from §2 predictions (with the abstain/evidence affordances) + the §3 duplicate flags.
- **Override logging (the Phase-3 seed):** a new `meetsy.FieldOverride` row per (run, task, field)
  capturing `predicted` vs `confirmed` (+ the evidence/confidence). This is the training signal Phase 3
  consumes — write it now even though nothing reads it yet.
- **Safety:** the existing `TaskPush` idempotency + audit stays; **no ClickUp write without explicit
  user confirmation** (hard rule — this is production ClickUp).

## 5. Pre-analysis incremental remap (2c.1)
Before analysing a meeting for an onboarded workspace, trigger the 2a `meetsy-kb` incremental embed
(cursor + content-hash; upsert-only) so the KB reflects the latest mirrored tasks/comments. Reuses the
existing worker + the just-landed robustness; no full re-index. Degrades gracefully if Clicksy is
unreachable (embed what's mirrored), exactly like onboarding.

## 6. Data model (meetsy only)
- `WorkspacePushConfig`: + `clientFieldId String?`, `clientOptions Json?` (`[{optionId,name}]`),
  `sprintLists Json?` (`[{listId,name}]`), `pointsEnabled Boolean @default(false)`.
- `FieldOverride` (new): `id, runId, meetsyTaskId, workspaceId, field, predicted Json?, confirmed Json?,
  confidence Float?, evidence Json?, createdAt` — append-only override log. `@@index([workspaceId, field])`.
- No change to `KbChunk` (its metadata already supports the kNN prior). Migration via the operator flow.

## 7. Endpoints + UI
- `POST /workspaces/:id/push-config/refresh-fields` — fetch the list's custom fields + sprint lists from
  ClickUp, populate client options / sprint lists (Owner/Admin).
- Extend the run/review payload with: retrieved-context provenance, per-task field **predictions**
  (value|abstain + evidence + confidence), and **duplicate flags**.
- Extend `POST /runs/:id/push` to accept confirmed `sprintListId` / `clientOptionId` / `points` per task
  and to write `FieldOverride` rows.
- meetsy-web review screen: context chips, prediction defaults with "why" popovers + an explicit
  "unknown" state, duplicate warnings, and sprint/client/points controls.

## 8. Honesty contract (carried from prior phases)
Predictions are **weak priors**: shown as range + evidence + confidence, **abstaining when thin** —
never a confident point-prediction. Duplicates are **flagged, never auto-merged**. The KB is
**context, not ground truth**. The ClickUp write **always** requires explicit human confirmation.
Overrides are logged but **not yet acted on** (that's Phase 3).

## 9. Testing
- **Unit:** retrieval `sourceTypes` filter; kNN prior aggregation (modal/abstain logic on fixtures);
  the clamp ("LLM can't pick a non-neighbour value"); abstain thresholds; due p50/p80 from cycle-time;
  dupe classification bands (≥0.90 / 0.82–0.90 / <0.82); mapper additions (client custom_field by UUID,
  points, sprint-list routing); `FieldOverride` write on push.
- **Live (real Nifty):** for an onboarded workspace, upload a real transcript → tasks show retrieved
  Nifty history; field predictions match real clients/components **or abstain** (verify a deliberately
  out-of-distribution task abstains); a near-duplicate of an existing task is **flagged**; a push with
  confirmed sprint/client/points lands in a **throwaway test list** (NOT a production list) with the
  client custom-field + points set, and `FieldOverride` rows recorded. **No production task created
  without explicit confirmation.**

## 10. Risks
| Risk | Mitigation |
|---|---|
| Field prediction looks confident but is weak (~0.34) | Abstain-first; show evidence + confidence; clamp to neighbour range; never auto-apply |
| LLM invents a client/sprint not in history | Hard clamp — choices restricted to neighbour-observed values / configured options |
| Auto-creating duplicate/unwanted ClickUp tasks in PRODUCTION | Never auto-merge; explicit confirm required; live-verify only into a throwaway list; idempotent `TaskPush` |
| Stale field options (client dropdown / sprint lists change) | Explicit "refresh ClickUp field options" action; re-fetch on demand |
| Retrieval injects misleading context | Provenance shown; prompts treat context as reference, not truth; "don't invent" guard |
| Scope creep (2c is huge) | Sliced 2c.1/2c.2/2c.3, each its own build + live-verify |

## 11. Open questions (for the approval discussion)
1. **Slice it (2c.1 → 2c.2 → 2c.3) or one drop?** (Lean: slice — matches the discipline + de-risks.)
2. **Abstain thresholds** — start at: predict only if top-1 neighbour share ≥ 0.5 **and** support ≥ 3,
   else abstain. OK as the v1 default (tunable on real data)?
3. **Which fields to predict in 2c.2** — client + component/sprint + due for sure; also assignee +
   estimate, or defer assignee to Phase 3 (smart-assign)? (Lean: predict client/sprint/due/estimate;
   leave confident assignment to Phase 3, but offer an abstain-aware assignee *hint*.)
4. **Sprint model** — confirm sprint = pick the target **list** (Sprints ClickApp; no Sprint API), and
   that "current sprint" is just the most recent sprint list (we never create lists).
5. **Live-verify push target** — confirm pushes during verification go to a **throwaway test list on
   the test team `90181854711`**, never the Nifty production team `3450636`.

---

**Build gate:** this spec stops here. **No code until the product owner approves** — especially the
slicing, the abstain thresholds, which fields to predict, and the live-verify push-target safety. On
approval: build slice-by-slice (sub-agent-driven) → live-verify each on real Nifty data (writes only to
a throwaway list) → commit/push → update the journal + RESUME.
