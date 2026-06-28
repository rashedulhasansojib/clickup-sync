# Meetsy Phase 3 — Smart Assignment + Learning Loop (Design Spec)

**Date:** 2026-06-28
**Status:** Draft — **awaiting product-owner approval before build**
**Phase:** Meetsy 3 (after Phase 2 COMPLETE — 2.0/2a/2a.1/2b/2c.1/2c.2/2c.3 all live-verified)
**Plan:** `docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md` (Phase 3 row)
**Depends on:** 2c.2 (`FieldPredictionService` weak priors incl. the assignee *hint*), 2c.3 (`FieldOverride` log + the HITL push), `KbChunk` history (assignee/component metadata), `SummaryFactsService` (workload + ownership facts), `AssigneeResolverService` (name→member), `WorkspacePushConfig.assignableMembers` (the candidate pool).

---

## Summary

Phase 3 closes the loop. Two capabilities, both **recommendation-only + abstain-first** (never
auto-assign, never auto-apply — the human still confirms every field on the push):

1. **Smart assignment** — turn 2c.2's soft assignee *hint* into a **ranked, evidence-backed owner
   recommendation**: who has historically closed similar work (ownership precedent from the KB), made
   **workload-aware** (who is light this sprint, from open-task counts + tracked hours), restricted to
   the **candidate pool** (`assignableMembers`), and **abstaining when there's no clear owner**.
2. **Learning loop** — consume the `FieldOverride` log (predicted-vs-confirmed, written by 2c.3) as a
   **correction memory**: when users *consistently* override the model the same way, nudge future
   predictions — with a hard minimum support, full transparency ("adjusted from N past corrections"),
   and an honest "is this actually helping?" signal (override-rate trend per field). **It is a
   preference memory, not a trained model** — with sparse data, "not enough to learn yet" is the
   honest and common state.

**THE central honesty risk of this phase** (and the reason the design leads with it): the override log
is *tiny*. A handful of corrections cannot train anything statistically. Any design that presents a
sparse-data nudge as "learned" repeats the answerability-zero / base-rate-echo traps caught throughout
Phase 2. So the loop is deterministic, support-gated, transparent, and measured honestly — or it
doesn't ship.

**Done when:** for an onboarded workspace, the review screen shows a **ranked assignee recommendation
with rationale (ownership + workload) that abstains when thin**; and the field predictions visibly
**incorporate consistent past corrections (support-gated, labelled)**, with a per-field **override-rate
trend** the user can inspect — verified on real Nifty data (and the loop verified to *abstain* when
corrections are sparse, not to fabricate learning).

## Goals / Non-goals
**Goals:** evidence-backed, workload-aware, abstain-first assignment recommendation; a deterministic,
support-gated correction memory over `FieldOverride`; an honest override-rate-trend metric; both fully
HITL; the assignment confirmation itself logged (loop stays closed).
**Non-goals:** auto-assignment / auto-apply of any field; an ML/embedding-trained ranker (deterministic
signals only in v1); cross-workspace learning (per-workspace only); changing the push safety model
(still explicit confirmation, still `TaskPush` idempotency, still test-team-only verification).

## ⭐ Recommended slicing (each its own build + live-verify)
- **3.1 — Smart assignment** (ownership kNN + workload + candidate pool → ranked recommendation +
  abstain + rationale; wired into the run result like 2c.2 predictions). No dependency on override
  volume, so it delivers value immediately.
- **3.2 — Learning loop** (aggregate `FieldOverride` → correction memory → support-gated nudge applied
  to 2c.2 predictions + the override-rate-trend metric + a "what we've learned" view).
Each ends green + live-verified (incl. the abstain/`thin` cases) + journal/RESUME updated.

---

## 1. Smart assignment (3.1)
For each extracted task, produce a **ranked** owner recommendation over the candidate pool:
- **Ownership signal:** the kNN neighbours from 2c.2 already carry `assignee`; aggregate *who closed
  similar work* (weight by similarity; closed tasks weigh more than open) → a per-candidate ownership
  score with the **cited neighbour task ids** as evidence.
- **Workload signal:** per candidate, current **open-task count** + **tracked hours (last N days)**
  from `clickup_tasks` / `clickup_time_entries` (reuse `SummaryFactsService` workload). Used to
  *break ties / down-rank the overloaded* ("X owns this area but is heavily loaded; Y is lighter"),
  **never** as the sole reason to assign.
- **Candidate pool:** restrict to `WorkspacePushConfig.assignableMembers`; map history assignee names
  → members via `AssigneeResolverService`. Anyone not in the pool is never recommended.
- **ABSTAIN** when no candidate has real ownership precedent above the 2c.2 floor (same `SIM_FLOOR` /
  `MIN_QUALIFYING` discipline) — "no clear owner from history" is a first-class result; the user picks.
- **Output:** `result.assignment[taskId] = { ranked: [{clickupUserId, name, ownershipScore,
  openTasks, trackedHours, evidenceTaskIds}], abstain, rationale }`. Recommendation-only — pre-fills
  the existing HITL assignee control; the user confirms (and that confirmation is logged via
  `FieldOverride`, closing the loop).

## 2. Learning loop (3.2) — deterministic correction memory, support-gated
- **Aggregate:** over a workspace's `FieldOverride` rows, per field (`client`/`sprint`/`assignee`),
  group by **(predicted value → confirmed value)** and count. A "correction" = predicted P, confirmed
  C, with P≠C. Build `CorrectionStat { field, predicted, confirmed, count, lastSeen }`.
- **Apply (the nudge):** when 2c.2 produces a prediction `P` for a field and there is a correction
  `P→C` with **count ≥ MIN_CORRECTIONS (start 3)** and **dominant agreement** (C is ≥X% of the
  corrections of P), surface `C` as an **adjusted suggestion** *alongside* the raw prediction, clearly
  labelled **"adjusted from N past corrections (you changed P→C N times)."** The raw model output and
  the distribution remain visible — the nudge never silently replaces the evidence, and **never fires
  below the support gate** ("not enough corrections yet").
- **Honest "is it helping?" metric:** per field, the **override rate over time** — of the last K
  pushes, what fraction did the user change the model on? A *falling* override rate is the only honest
  evidence the loop helps; report it per field, never blended, with the sample size shown. A flat/rising
  rate is reported truthfully (the loop isn't helping yet — valid). **No accuracy % is claimed** from a
  handful of rows.
- **"What we've learned" view:** the correction stats + the override-rate trend, per workspace —
  inspectable, honest, and explicitly small-N aware.

## 3. Honesty contract (the spine of this phase)
- **Recommendation, never automation:** assignment + every adjusted field is a *default the human
  confirms*; nothing is auto-assigned or auto-pushed.
- **Support-gated learning:** a correction nudges only at ≥ MIN_CORRECTIONS with dominant agreement;
  below that, the loop **abstains** and says so. Sparse data ⇒ "not enough to learn yet," not a guess.
- **Transparency:** the raw prediction, the distribution, the workload numbers, and the "adjusted from
  N corrections" provenance are all shown. The user can always see *why*.
- **Honest measurement:** override-rate trend per field (never blended, sample size shown); a
  non-improving loop is reported as such. No fabricated accuracy.
- **Workload never overrides ownership:** load breaks ties / flags overload; it is never the lone
  reason to assign someone with no precedent.

## 4. Data model (meetsy only)
- **No raw new table required for corrections** — they're aggregated on read from `FieldOverride`
  (already written by 2c.3). Optionally add a materialized `CorrectionStat` cache later if read cost
  matters; v1 computes on demand (small N).
- `FieldOverride` already captures what the loop needs (predicted bundle + confirmed values). The
  **assignment confirmation** must also be logged — extend the 2c.3 `confirmed` payload to include the
  confirmed `clickupUserId` (already present) so assignment corrections are learnable too.
- Migration only if a `CorrectionStat` cache is added (defer; not in v1).

## 5. Endpoints + UI
- Extend the run result with `assignment[taskId]` (3.1) and `adjustments[taskId]` (3.2 — the
  support-gated nudges), parallel to 2c.2's `fieldPredictions`/`duplicates`.
- `GET /workspaces/:id/learning` — the correction stats + per-field override-rate trend ("what we've
  learned"). Any authed user.
- meetsy-web: the review screen's assignee control shows the ranked recommendation + rationale +
  abstain state; field controls show the "adjusted from N corrections" chip when a nudge fires; a
  small "what we've learned" panel. (Backend-first; UI can follow, per prior phases.)

## 6. Testing
- **Unit:** ownership aggregation (weighted, closed>open, floor/abstain); workload tie-break (overload
  down-ranks but never solely assigns); candidate-pool restriction (non-members never recommended);
  correction aggregation (P→C counts); the support gate (no nudge below MIN_CORRECTIONS; nudge with
  dominant agreement); override-rate-trend math; the abstain paths for both.
- **Live (real Nifty):** for an onboarded workspace, an energy task recommends a real energy owner
  (e.g. Rashedul/Shoabur) **with cited tasks**; a no-precedent task **abstains**; an overloaded top
  owner is **down-ranked** with the lighter candidate flagged. For the loop: seed a few consistent
  `FieldOverride` corrections → confirm a support-gated nudge fires **and** that with too-few/ conflicting
  corrections it **does NOT** fire (the discrimination check — proving the gate, not just the nudge).
  Assignment pushes (if any) go ONLY to a throwaway list on test team `90181854711`.

## 7. Risks
| Risk | Mitigation |
|---|---|
| Sparse override data presented as "learned" | Hard support gate (≥3 + dominant agreement); "not enough to learn yet"; show N; no accuracy % |
| Loop measured dishonestly | Override-rate trend per field, never blended, sample size shown; non-improvement reported truthfully |
| Confident-but-wrong assignment | Abstain-first (floor/MIN_QUALIFYING); evidence cited; recommendation-only; human confirms |
| Workload signal dominates | Load only breaks ties / flags overload; never the sole assignment reason |
| Echo trap (again) — assign the busiest/most-frequent owner regardless | Same SIM_FLOOR + ownership-precedent gate as 2c.2; cite the specific neighbour tasks |
| Auto-applying to production ClickUp | No auto-assign/auto-push; explicit confirm; verification only on test team `90181854711` |

## 8. Open questions (for the approval discussion)
1. **Slice 3.1 → 3.2, or one drop?** (Lean: slice — 3.1 delivers immediately; 3.2 needs override data to accumulate.)
2. **`MIN_CORRECTIONS` + dominant-agreement threshold** — start at **count ≥ 3 and confirmed value ≥ 60% of that prediction's corrections**? (Tunable on real data.)
3. **Workload window** — open-task count + tracked hours over the **last 30 days**? And does "light this sprint" use the current sprint list or a rolling window?
4. **Does Phase 3 ever AUTO-assign** the top recommendation when confidence is very high, or **always** require a human click? (Strong lean: always require the click — matches the project's honesty stance; auto-assign is out of scope.)
5. **"What we've learned" surface** — ship the endpoint only, or also the meetsy-web panel in this phase?

---

**Build gate:** this spec stops here. **No code until the product owner approves** — especially the
support-gate thresholds, the always-HITL stance, and the honest-measurement approach (the opinion-heavy,
honesty-critical parts). On approval: build slice-by-slice (sub-agent-driven) → live-verify each on real
Nifty data, including the *abstain / gate-not-firing* cases → commit/push → update the journal + RESUME.
