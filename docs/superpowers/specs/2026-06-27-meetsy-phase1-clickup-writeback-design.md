# Meetsy Phase 1 — ClickUp Write-Back (Design Spec)

**Date:** 2026-06-27
**Status:** Draft — awaiting product-owner approval before implementation
**Phase:** 1 of 4 (see `docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md`)
**Depends on:** Phase 0 (complete + live-verified — `docs/meetsy/BUILD-JOURNAL.md`)

---

## Summary

Phase 1 makes Meetsy **actually create ClickUp tasks**. The transcript pipeline already
produces per-person, evidence-grounded, ClickUp-ready tasks (title, description,
acceptance criteria, priority, due date, tags). Phase 1 closes the loop: a human
reviews/edits those tasks, picks the real ClickUp assignee, and **pushes them into a
target ClickUp list** via the workspace's stored ClickUp token — with an idempotent
audit trail.

This is the **visible win** of the integration and deliberately needs **no embeddings/RAG**
(Phase 2) and **no smart-assignment scoring** (Phase 3). The "assignment" here is the
pipeline's existing roster-based owner, mapped to a ClickUp member and **confirmed by a
human**. Reading Clicksy's mirrored history for context/dedup is Phase 2.

**Phase 1 is "done" when:**
1. An Owner/Admin configures, per workspace, a **target ClickUp list** and the set of
   **assignable members**.
2. On a completed run, the review UI lets the user edit each task's assignee (from the
   assignable members), priority, due date, and (optional) target list.
3. Clicking **Push to ClickUp** creates the approved tasks in the target list with correct
   assignees, returns the created task links, and is **idempotent** (re-push never
   duplicates).
4. Every push is audited (`meetsy.TaskPush`), scoped by `workspaceId`, and authorized by
   the shared session.

## Goals / Non-goals

**Goals**
- A minimal **ClickUp client inside meetsy-api** that decrypts the per-workspace token
  (shared `APP_ENCRYPTION_KEY`) and calls ClickUp directly — Clicksy source stays untouched.
- Per-workspace push config (target list + assignable members) owned by Meetsy.
- Human-in-the-loop review → push, with assignee name→ID resolution and a per-task audit.

**Non-goals (later phases)**
- RAG / embeddings / reading Clicksy's `clickup_tasks` history for context or dedup (Phase 2).
- Smart assignment from workload/ownership history; the learning loop that tunes future
  output from user edits (Phase 3).
- **Updating** existing ClickUp tasks or dedup-merge — Phase 1 only **creates new** tasks.
- ClickUp **subtasks** as separate child tasks and **dependency links** — deferred (Phase 1.x);
  subtasks/criteria are folded into the task description for now.
- Two-way sync / webhooks back from ClickUp (Clicksy already mirrors; Phase 2 consumes it).

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Who calls ClickUp | **meetsy-api's own minimal client** (decrypts token, calls ClickUp directly) | Per ecosystem doc C.4; keeps Clicksy untouched; no cross-service RPC |
| Token decryption | Port **decrypt-only** AES-256-GCM into `@clicksy/shared`, reuse `APP_ENCRYPTION_KEY` | Same algorithm as Clicksy's `crypto.service`; one shared implementation |
| Push settings storage | New table in the **`meetsy`** schema | Meetsy owns it; never writes `public` |
| Assignment in Phase 1 | Pipeline roster owner → **human-confirmed** ClickUp member (allowlist) | No history/RAG yet; human gate stays |
| Idempotency | Unique `(runId, meetsyTaskId)` in `meetsy.TaskPush` | Re-push is safe; one ClickUp task per Meetsy task per run |
| Scope | Per **workspace** (run.workspaceId → token + list + members) | Matches Phase 0 workspace scoping |

---

## 1. ClickUp client in meetsy-api (`apps/meetsy-api/src/clickup/`)

A small typed client mirroring Clicksy's `clickup.client.ts` pattern (axios, `Authorization: <token>`),
but only what Phase 1 needs:

- `createTask(workspaceId, listId, payload)` → `POST /list/{list_id}/task`. **New capability**
  (Clicksy's client has none). Returns `{ id, url }`.
- `getTeamMembers(workspaceId)` → members for the workspace's `clickupTeamId` (for the
  assignable-members picker + name→ID resolution). Mirror Clicksy's `getTeamMembers`.
- `getSpaceTree(workspaceId, spaceId)` → spaces → folders → lists, for the target-list picker
  (`GET /space/{id}/folder`, `/folder/{id}/list`, `/space/{id}/list` for folderless). Enough
  to let the user choose a list.

**Token resolution:** read `public.workspaces.clickup_api_token_enc` (Meetsy already has the
read-model + SELECT grant from Phase 0), decrypt with the shared key; fall back to a
`CLICKUP_API_TOKEN` env like Clicksy does. `clickupTeamId` comes from the same read-model.

**Crypto:** add `decryptSecret(blob, key)` + `parseEncryptionKey(raw)` to `@clicksy/shared`
(decrypt-only — Meetsy never encrypts). Byte-for-byte the inverse of Clicksy's
`crypto.service.ts` (`base64(iv[12] | tag[16] | ciphertext)`, AES-256-GCM). Add
`APP_ENCRYPTION_KEY` to meetsy-api env (required when push is used; validated like Clicksy).

## 2. Per-workspace push config (`meetsy` schema)

New managed table `meetsy.WorkspacePushConfig`:
- `workspaceId String @unique` (soft ref to `public.workspaces`)
- `targetListId String` + `targetListName String?` (the default ClickUp list new tasks go to)
- `assignableMembers Json` — `[{ clickupUserId, name, email }]` the people Meetsy may assign;
  anyone NOT here is never offered as an assignee (the "ignore people not in settings" rule)
- `defaultStatus String?` (optional ClickUp status for new tasks; else list default)
- `createdAt/updatedAt`, `updatedBy String?`

CRUD via `GET/PUT /workspaces/:workspaceId/push-config` (Owner/Admin only). The settings UI
fills the pickers from the ClickUp client helpers (lists + members).

## 3. Assignee resolution (roster name → ClickUp member)

The pipeline assigns to transcript participants (`assigneeName`), which need not match ClickUp
members. Bridge:
1. On opening the review UI, the server pre-resolves each task's `assigneeName` against
   **assignable members** (case-insensitive exact, then alias/first-name best match) and returns
   a suggested `clickupUserId` (or null).
2. The UI shows an **assignee dropdown limited to assignable members**, pre-selected to the
   suggestion. The human confirms/overrides. Unresolved → "Unassigned".
3. Push uses the **human-confirmed** `clickupUserId` only. No learning/memory of overrides yet
   (Phase 3).

## 4. Push flow (human-in-the-loop)

```
review UI (meetsy-web)                meetsy-api                         ClickUp
  edit assignee/priority/due/list  │                                   │
  click "Push to ClickUp" ─────────► POST /runs/:id/push {tasks[]}      │
                                   │  authz: session + workspace        │
                                   │  load run (workspace-scoped)       │
                                   │  for each task (skip already-pushed)│
                                   │    map Task → ClickUp payload       │
                                   │    createTask(list) ───────────────► POST /list/{id}/task
                                   │    upsert meetsy.TaskPush (audit)   │◄── {id,url}
  ◄── {results:[{meetsyTaskId,     │                                    │
       clickupTaskId,url,status}]} │                                    │
  show per-task ✓/✗ + links        │                                    │
```

- **Request** carries the (edited) task set: `{ meetsyTaskId, listId?, clickupUserId|null,
  priority, dueDate, title, description, tags }` per task. `listId` defaults to the workspace
  target list.
- **Idempotency:** before creating, check `meetsy.TaskPush` for `(runId, meetsyTaskId)` with
  status `pushed`; skip if present (return existing link). One ClickUp task per Meetsy task per run.
- **Partial failure:** each task is independent; a failed createTask records `status=failed` +
  error and does not block the others. Re-push retries only failed/unpushed.
- **CSRF:** mutating → requires `x-csrf-token` (Phase 0 guard).

## 5. Field mapping (Meetsy `Task` → ClickUp create payload)

| Meetsy Task | ClickUp `POST /list/{id}/task` | Notes |
|---|---|---|
| `title` | `name` | |
| `description` + `acceptanceCriteria[]` + `evidence[]` | `markdown_description` | Compose markdown: description, then "Acceptance criteria" bullets, then "Evidence" quotes. Subtasks/dependencies appended as a checklist/notes (Phase 1.x for real subtasks) |
| confirmed `clickupUserId` | `assignees: [id]` | omit if unassigned |
| `priority` (`urgent/high/normal/low`) | `priority` (`1/2/3/4`) | fixed map |
| `dueDate` (ISO, resolved by enrich) | `due_date` (epoch ms) + `due_date_time:false` | skip if null/natural-language-unresolved |
| `tags[]` | `tags` | best-effort; ClickUp ignores unknown tags or they're created per workspace settings |
| `defaultStatus` (config) | `status` | else list default |

## 6. Data model (additions — `meetsy` schema only)

- `WorkspacePushConfig` (§2).
- `TaskPush` — audit + idempotency: `id`, `runId`, `meetsyTaskId`, `workspaceId`,
  `clickupTaskId String?`, `clickupUrl String?`, `status` (enum `pushed|failed|skipped`),
  `error String?`, `payload Json`, `pushedBy String` (userId), `createdAt`.
  `@@unique([runId, meetsyTaskId])`, `@@index([workspaceId])`.

New migration creates both tables in `meetsy` (follows the Phase 0 operator flow: no
`CREATE SCHEMA`; `meetsy._prisma_migrations` already provisioned by `grants.sql`). No new
`public` grants needed (token/members read from the already-granted `workspaces`).

## 7. API endpoints (meetsy-api)

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/workspaces/:id/push-config` | any auth | current push config |
| PUT | `/workspaces/:id/push-config` | Owner/Admin | set target list + assignable members |
| GET | `/clickup/lists?workspaceId=` | Owner/Admin | space→folder→list tree for the picker |
| GET | `/clickup/members?workspaceId=` | Owner/Admin | team members for the picker |
| GET | `/runs/:id/push` | any auth | push status/audit for a run |
| POST | `/runs/:id/push` | any auth | push the (edited) approved tasks |

All workspace-scoped (Phase 0 `?workspaceId=` + default-workspace) and session-authed.

## 8. meetsy-web UI

- **Workspace settings page:** pick the target list (tree picker) + select assignable members
  (checklist from `/clickup/members`). Owner/Admin only.
- **Review screen (existing results page) additions:** per-task editable **assignee dropdown**
  (assignable members, pre-resolved), priority, due date, and optional per-task list override;
  a **"Push to ClickUp"** button (bulk) with a confirm; per-task push status (✓ with link / ✗
  with error); pushed tasks shown as locked with their ClickUp link.

## 9. Testing

- **Unit:** field mapping (priority/due/markdown), assignee resolution (exact/alias/none),
  idempotency guard (already-pushed → skip), payload builder.
- **ClickUp client:** mocked HTTP — `createTask` shape, token decrypt (round-trip a known
  `APP_ENCRYPTION_KEY` blob against Clicksy's `crypto.service` to prove byte-parity).
- **Integration (live, deferred like Phase 0):** against a real/sandbox ClickUp list — push a
  task, assert it appears with the right assignee/priority/due; re-push → no duplicate.
- **Authz:** push/settings require session; settings require Owner/Admin; CSRF on mutations.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Wrong/over-broad ClickUp writes (real client data) | Human-in-the-loop gate; explicit target list; push only on click; audit every create |
| Token decrypt drift from Clicksy | Shared `@clicksy/shared` decrypt + a byte-parity test against Clicksy's encrypt |
| Duplicate tasks on retry/double-click | `@@unique(runId, meetsyTaskId)` + pre-check; idempotent |
| Roster name ≠ ClickUp member | Human confirms assignee from the allowlist; unresolved → unassigned, never wrong-assigned |
| ClickUp rate limits / partial failure | Per-task independent + retry only failed; sequential with basic backoff |
| Assignable-members list goes stale | Re-fetched in settings UI; resolution is at push time against current config |
| `APP_ENCRYPTION_KEY` mismatch between services | Same secret-storage discipline; client throws a clear error if decrypt fails |

## 11. Open questions (resolve in implementation)

- Target list: single default vs per-task override vs per-department mapping (lean: workspace
  default + optional per-task override in the UI).
- Tags: create missing tags vs only apply existing (lean: apply as-is, ignore failures).
- Subtasks/dependencies: description-embedded now; real ClickUp subtasks + dependency links as
  a fast-follow (Phase 1.x) once the core push is proven.
- Should a successful push mark the run/task as "exported" in `meetsy` (lean: yes, via TaskPush
  status; surfaced in the UI).
