# Meetsy v2 — Phase 7: Roster memory (design)

**Date:** 2026-07-19
**Status:** Design (locked before implementation) — **awaiting product-owner approval**
**Umbrella plan:** `docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md`
**Predecessors:**
- Phase 3 (v2): `2026-07-18-meetsy-v2-phase3-learning-trust-design.md` — the *task-push-time* learning loop (`FieldOverride` + `LearningService`). Phase 7 is the *roster-confirmation-time* analogue and is deliberately kept **separate** (see §2.3).
- Phase 4 (v2): `2026-07-18-meetsy-v2-phase4-kb-consolidation-design.md` — the `/kb` shell into which the new "Participants" tab plugs.

---

## 1. Purpose

At upload time the roster review step suggests a ClickUp member for each transcript
participant via `AssigneeResolverService` — a deterministic three-tier match
(exact → first-name → prefix; `assignee-resolver.service.ts:20-45`). It is
**stateless**: identical inputs, identical outputs, forever. When it guesses wrong
today, the user fixes it in the UI and the correction is discarded — the *same*
misguess reappears on the next meeting.

Phase 7 closes that loop.

- Every roster confirmation writes a **per-workspace alias → ClickUp member**
  record (or an explicit blocklist).
- Every subsequent upload queries that memory **first**; deterministic heuristics
  only run on aliases the KB has never seen.
- The user sees *why* each suggestion was made (KB-confirmed / heuristic / AI /
  no match) and can inspect + edit the KB directly from `/kb`.

**Done when:** a workspace whose users have corrected roster suggestions on N
meetings never sees the corrected mistakes suggested again; the roster review
screen surfaces each suggestion's source; and `/kb → Participants` lists the
learned aliases with edit/delete/blocklist actions.

## 2. Goals / non-goals

### 2.1 Goals

- Deterministic, per-workspace roster memory that learns from human confirmations.
- Source-labelled suggestions (KB / heuristic / LLM / none) on the roster review UI.
- Inspectable, editable KB via `/kb → Participants`.
- HITL preserved end-to-end — the user always confirms; the KB only pre-fills.

### 2.2 Non-goals

- **Not** a replacement for Stage 0 speaker parsing (VTT parser stays deterministic;
  spec §6 rationale in the reply the user already saw — LLM would be worse and
  more expensive).
- **Not** a statistical learning loop with support gates. Roster memory is a
  phone book: **one confirmation is authoritative**. Contrast the Phase 3 loop
  which needs ≥ `MIN_CORRECTIONS` for support.
- **Not** cross-workspace learning (people move companies; aliases don't).
- **Not** an ML/embedding model — deterministic lookups only in v1. An LLM
  fallback lives at the resolver's *bottom* tier, not inside the KB.

### 2.3 Why *not* fold into `FieldOverride` / `LearningService`

The Phase 3 loop is designed around statistical support:
`(field, predicted, confirmed, count, agreement)` gated at `count ≥ 3`. Roster
memory is structurally different:

| Dimension | Phase 3 (task-push) | Phase 7 (roster) |
|---|---|---|
| Grain | Per task, per field | Per participant string, per workspace |
| Authority | Nudge fires only above support gate | One confirmation is authoritative |
| Direction | Predict → confirm (statistical) | Alias → member (lookup) |
| Read timing | Push time (after analysis) | Upload time (before analysis) |
| UI | "Adjusted from N corrections" chip | Badge on the roster chip |

Overloading `FieldOverride` with a fake "field=participant" would drag support-gate
semantics onto a lookup that doesn't need them, and confuse the `/learning` page
which is explicitly about statistical patterns. Roster memory earns its own model
and its own tab.

---

## 3. What ships (per PR)

| PR | Slice | Backend | Web |
|---|---|---|---|
| **A** | Model + write path (silent learning). | `ParticipantAlias` model + migration; `RosterMemoryService.learnFromConfirmation()`; wired into `confirmRoster` (diff against saved `meeting.roster`). No user-visible change yet. | — |
| **B** | Suggest-time read integration. | Extend `suggestClickupMembers` with a KB-first tier + return a `source` tag per participant. Extend `@ma/shared` `Participant` type with `source`. | — |
| **C** | Source badges + learn toast. | — | Roster review chip shows source badge (`KB · confirmed 4×` / `Heuristic` / `AI guess` / `No match`); "Never match this name" action; toast on confirm summarising what was learned. |
| **D** | `/kb → Participants` tab + endpoints. | `GET/POST/PATCH/DELETE /workspaces/:id/participant-aliases`; optional CSV bulk-import (Owner/Admin). | New tab in the `/kb` shell: paginated table, row actions, empty state, bulk-import. |
| **E** *(optional)* | LLM fallback with KB context. | New resolver tier called only when KB + heuristic both miss; small structured Azure call with `known mappings` blob for grounding. Defer if A–D land the target UX. | — |

Order: **A → B → C → D**, each ends green + live-verified + journal updated. E only if the miss rate stays high after D on real Nifty data.

---

## 4. Backend design

### 4.1 Prisma model (PR-A)

```prisma
model ParticipantAlias {
  id            String   @id @default(cuid())
  workspaceId   String   @map("workspace_id")
  alias         String   // NORMALIZED: lowercased, single-spaced, punctuation-stripped
  aliasRaw      String   @map("alias_raw")     // original casing for display
  clickupUserId String?  @map("clickup_user_id") // null = blocklist row
  source        AliasSource
  confirmations Int      @default(1)
  lastSeenAt    DateTime @default(now()) @map("last_seen_at")
  createdBy     String   @map("created_by")   // user id (audit)
  createdAt     DateTime @default(now())      @map("created_at")
  updatedAt     DateTime @updatedAt            @map("updated_at")

  @@unique([workspaceId, alias], name: "workspace_alias_unique")
  @@index([workspaceId])
  @@map("participant_aliases")
  @@schema("meetsy")
}

enum AliasSource {
  user_confirmed
  user_corrected
  user_blocklisted
  admin_seeded

  @@schema("meetsy")
}
```

Normalization is the same helper the resolver already uses:
```ts
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "");
```
(Extended from `assignee-resolver.service.ts:48-50` with punctuation stripping so `Dan L.` and `Dan L` collapse.)

**Migration.** New file `apps/meetsy-api/prisma/migrations/20260719120000_meetsy_phase7_roster_memory/migration.sql`. **No public DDL** — meetsy-role has no CREATE on public (Phase 0 constraint). Apply live as the `meetsy` role.

### 4.2 `RosterMemoryService` (PR-A + PR-B)

New module `apps/meetsy-api/src/roster/`:

```ts
type SuggestionSource = "kb" | "heuristic" | "llm" | "none";

interface SuggestionResult {
  clickupUserId: string | null;
  source: SuggestionSource;
  confirmations?: number; // only when source === "kb"
}

class RosterMemoryService {
  async suggest(workspaceId: string, name: string): Promise<SuggestionResult | null>;
  async learnFromConfirmation(input: {
    workspaceId: string;
    userId: string;
    suggested: Participant[]; // what we told the user (with source tag)
    confirmed: Participant[]; // what the user picked
  }): Promise<{ learned: number; corrected: number; blocklisted: number }>;
}
```

**`suggest()`** does the pure KB lookup:
1. `SELECT * FROM participant_aliases WHERE workspace_id = ? AND alias = norm(name) LIMIT 1`.
2. Row with non-null `clickupUserId` → `{clickupUserId, source: "kb", confirmations}`.
3. Row with null `clickupUserId` → `{clickupUserId: null, source: "kb"}` (blocklist — caller respects and does NOT fall through to heuristic).
4. No row → `null` (caller falls through).

**`learnFromConfirmation()`** is pure code — no LLM (see the diagram already shared with the user). Per participant, compute the *action* by comparing `suggested[i]` and `confirmed[i]` for each `(alias, clickupUserId)` pair covered by `displayName` + `aliases[]`:

| Case | Action | Write |
|---|---|---|
| `suggested.clickupUserId === confirmed.clickupUserId && confirmed !== null` | KEPT | UPSERT: `clickupUserId = confirmed`, `source = user_confirmed` (or unchanged if already `admin_seeded`), `confirmations += 1`, `last_seen_at = now()` |
| `suggested.clickupUserId !== confirmed.clickupUserId && confirmed !== null` | CORRECTED | UPSERT: `clickupUserId = confirmed`, `source = user_corrected`, `confirmations = 1`, `last_seen_at = now()` |
| `confirmed === null` AND the participant chip was explicitly blocklisted | BLOCKLIST | UPSERT: `clickupUserId = null`, `source = user_blocklisted`, `confirmations = 1` |
| everything else (unchanged null) | NO-OP | — |

Writes happen inside a single Prisma transaction. Errors log + swallow — never block the meeting from progressing to analysis (mirrors `suggestClickupMembers`' best-effort posture at `analysis.service.ts:149-153`).

### 4.3 Wiring — read path (PR-B)

Extend `AnalysisService.suggestClickupMembers` (`analysis.service.ts:130-154`):

```ts
for (const p of roster) {
  for (const name of [p.displayName, ...p.aliases]) {
    // 1. KB
    const kb = await this.rosterMemory.suggest(workspaceId, name);
    if (kb?.source === "kb") {
      p.clickupUserId = kb.clickupUserId;                  // may be null (blocklist)
      p.clickupName   = kb.clickupUserId ? nameById.get(kb.clickupUserId) ?? null : null;
      p.source        = "kb";
      p.confirmations = kb.confirmations ?? undefined;
      break;
    }
    // 2. Heuristic (unchanged assignee-resolver.service.ts)
    const matchedId = this.assigneeResolver.resolve(name, members);
    if (matchedId) {
      p.clickupUserId = matchedId;
      p.clickupName   = nameById.get(matchedId) ?? null;
      p.source        = "heuristic";
      break;
    }
  }
  if (!p.source) p.source = "none"; // PR-E can flip this to "llm" if we ship it
}
```

The `Participant` type in `@ma/shared` gains `source?: SuggestionSource; confirmations?: number` — additive, existing consumers keep working.

### 4.4 Wiring — write path (PR-A)

`confirmRoster` (`analysis.service.ts:160-186`) is the only new call site:

```ts
const before = ParticipantSchema.array().parse(meeting.roster ?? []);
// existing update stays: save body.roster JSON
await this.prisma.meeting.update({ ... });

// Learn (best-effort, non-blocking).
this.rosterMemory
  .learnFromConfirmation({ workspaceId, userId: user.id, suggested: before, confirmed: body.roster })
  .then((stats) => this.logger.log(`Roster learned: ${JSON.stringify(stats)}`))
  .catch((err) => this.logger.warn(`Roster learn failed: ${(err as Error).message}`));
```

The `.then()` handler returns the stats block to the HTTP response so the UI can toast:
```ts
return { runId: run.id, learned: stats }; // extends existing ConfirmRosterResponse
```

### 4.5 KB browser endpoints (PR-D)

Under `/workspaces/:id/participant-aliases`, workspace-scoped via `WorkspaceResolver`:

| Verb | Path | Body/Query | Roles |
|---|---|---|---|
| `GET` | `` | `?cursor=…&limit=50&search=…` | any authed |
| `POST` | `` | `{alias, aliasRaw, clickupUserId \| null}` | Owner, Admin |
| `PATCH` | `/:id` | `{clickupUserId \| null}` | Owner, Admin |
| `DELETE` | `/:id` | — | Owner, Admin |
| `POST` | `/import` | CSV: `alias,clickup_email` | Owner |

All mutations write `AdminAuditLog` (reuses the interceptor already in Clicksy; Meetsy has a parallel pattern via `FieldOverride` for now — TBD in the write-audit follow-up).

### 4.6 Not in v1 (deferred)

- **`NegativeAssociation`** ("alias X should not map to member Y") — only matters for multi-member ambiguity beyond the blocklist row. Fold in later if we see it in practice.
- **Materialized KB context blob** for the LLM fallback (PR-E). Built on demand in E.

---

## 5. Web design

### 5.1 Roster review chip (PR-C)

The current roster review UI (from Phase 1 frontend + subsequent polish) already renders each participant as a chip with a member dropdown. This PR adds:

```
┌──────────────────────────────────────────────────────────────┐
│ Dan L.                                                        │
│  ─ Assign to ─                                                │
│  [ Daniel Kim ▼ ]        ⭐ KB · confirmed 4×                  │
│                                                               │
│  or [ Never match this name ]                                 │
└──────────────────────────────────────────────────────────────┘
```

Badge variants:
- ⭐ `KB · confirmed N×` — dark-mode-safe amber (matches Phase 6 palette)
- 🔍 `Heuristic match` — muted blue
- ✨ `AI guess` — yellow (only when PR-E ships)
- ⚪ `No match` — gray

Interaction:
- Changing the dropdown to a *different* member queues a CORRECTED write.
- Clicking "Never match this name" queues a BLOCKLIST write and clears the dropdown.
- Confirming the roster (existing "Continue" button) fires POST /roster; on 200 shows a Sonner toast: **"Learned 2 new mappings, corrected 1."**

Accessibility: badge is a `<span role="status">` next to the dropdown; screen readers announce the source and confirmation count.

### 5.2 `/kb → Participants` tab (PR-D)

Consolidates into the existing `/kb` shell (Phase 4 v2). New tab between `Documents` and `Search`.

```
Participants (workspace-scoped)

  Alias                Member                Source           Confirmations   Last seen         Actions
  ─────────────────────────────────────────────────────────────────────────────────────────────────────
  dan l                Daniel Kim            corrected         3               2 days ago         Edit · Delete · Blocklist
  sarah k              Sarah Khan            confirmed         7               yesterday          Edit · Delete · Blocklist
  nifty it             (blocklist)           blocklisted       —               1 week ago         Edit · Delete
  jd                   James Doe             admin-seeded      1               today              Edit · Delete · Blocklist

  Search [   ]       [+ Add mapping]       [Import CSV]
```

- Empty state: "No aliases learned yet. Confirm a roster to start teaching your workspace."
- Owner/Admin see the Edit/Delete/Blocklist column; Members read-only.
- CSV import format: `alias,clickup_email` (two columns, headerless). Email → clickupUserId via existing `/clickup/members`.

### 5.3 What we do NOT ship

- No `/participants` top-level page — the tab in `/kb` keeps the workspace-knowledge surface consolidated (Phase 4 rationale).
- No live-sync SSE for the KB browser — data changes are user-driven and rare; a page refresh is fine.

---

## 6. Test plan

Backend (Jest, mirrors prior phases):

- **`roster-memory.service.diff.spec.ts`** — pure diff function: KEPT / CORRECTED / BLOCKLIST / NO-OP cases + display-name-vs-alias overlap.
- **`roster-memory.service.suggest.spec.ts`** — KB hit (non-null), KB hit blocklist (null, do not fallthrough), KB miss (null return).
- **`roster-memory.service.learn.spec.ts`** — integration with a real Prisma test DB: upsert semantics, `confirmations += 1` on repeat, `user_corrected` overrides prior `user_confirmed`.
- **`analysis.service.suggest-clickup-members.spec.ts`** — extend existing (if any): KB tier fires first, blocklist short-circuits, heuristic still works when KB is empty.
- **`participant-alias.controller.spec.ts`** — CRUD + Owner/Admin gating + CSV import validation.

Web: typecheck + `next lint` per the `meetsy-web-next-build-dev-footgun` memory. No unit tests on the badge component (matches prior phases).

**Live verification (real Nifty data):**
1. Upload transcript with participants Dan L., Sarah K., Nifty IT.
2. Confirm the roster with intentional corrections (Dan L. → Daniel Kim; Nifty IT → blocklist).
3. Re-upload a transcript with the same three names.
4. Verify: Dan L. now suggests Daniel Kim with `KB · confirmed 1×`; Nifty IT auto-blocklists; Sarah K. still shows `Heuristic` if unchanged.
5. Verify `/kb → Participants` lists all three rows with correct source tags.
6. Confirm the same misguess never resurfaces — the discrimination check.

---

## 7. Rollout

1. **PR-A** (backend, silent learning). Deploy — KB starts filling.
2. **PR-B** (backend, KB-first read). Deploy — suggestions start honoring KB.
3. **PR-C** (web, badges + toast). Deploy — users see the loop closing.
4. **PR-D** (web, KB browser). Deploy — users get direct control.
5. **PR-E** (optional).

Single atomic Phase-7 commit at the end (prior phase precedent).

**Migration.** Applied as the `meetsy` role first (per Phase 0/1/2 protocol). `_prisma_migrations` in `meetsy` schema.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| A user makes a mistaken correction → the KB learns it → future runs echo the mistake. | KB is browsable + editable in `/kb → Participants`. `updated_at` + `created_by` audit tells you who did what. Delete/Edit is one click. |
| Alias collisions: two members share a first name; the KB "picks" whichever the first user chose. | The KB is per-workspace and driven by human confirmation — this is the *desired* semantic. If workspace has ambiguity, users see it in `/kb` and can Edit. |
| A workspace renames a member → old alias stays mapped to a stale clickupUserId. | `clickupUserId` FK is soft — a stale id just fails to resolve at push time; the UI shows "unknown member" and the user re-picks (which corrects the KB). |
| Race on concurrent confirmations for the same alias. | `@@unique([workspaceId, alias])` + `UPSERT` — last writer wins. Same posture as `WorkspacePushConfig`. |
| Best-effort learn failure hides bugs. | Warn-log with alias + workspace; admin can inspect. |
| CSV import lets an admin seed junk. | Import writes `admin_seeded` source; regular deletion is one click; import is Owner-only. |

---

## 9. Open questions

1. **Should PR-A backfill from historical `Meeting.roster` JSONs on migration?** — Lean: **no**. Historical rosters don't distinguish "user confirmed X" from "system suggested X and user didn't touch it" — false confidence. Users can bulk-import CSV in PR-D instead.
2. **Should the `/kb Participants` tab surface the raw `AliasSource` enum or a friendlier label?** — Lean: friendlier ("You confirmed" / "You corrected" / "You blocklisted" / "Admin added").
3. **Should confirmation count decay?** — Lean: **no** in v1. Simpler mental model. If an alias goes stale (member leaves), the user edits or deletes.
4. **Should PR-E ship in Phase 7 or a follow-up?** — Depends on measured KB miss rate after PR-D goes live. Default: defer.
5. **Toast copy on confirm** — "Learned N mappings" vs "Meetsy will remember N mappings" vs "N mappings saved to workspace memory". Lean: the middle one (product voice).

---

**Build gate:** this spec stops here. **No code until the product owner approves** — especially the "roster memory is a lookup, not a statistical loop" stance in §2.3, the model shape in §4.1, and the `/kb Participants` UX in §5.2. On approval: build PR-A → PR-B → PR-C → PR-D (sub-agent-driven per prior phases) → live-verify each on real Nifty data → commit/push → update the build journal.
