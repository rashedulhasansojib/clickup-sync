# Clicksy — ClickUp Comment Sync (Design Spec)

**Date:** 2026-06-27
**Status:** Draft — awaiting product-owner approval
**Phase:** Meetsy Phase 2 enabler (built + verified FIRST, as a discrete Clicksy-only unit)
**Plan:** `docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md`

---

## Summary

Add ClickUp **comment** fetch + storage to **Clicksy** so the mirror holds task comments
(today it stores descriptions but not comments). This is the concrete enabler for Meetsy's
Phase-2 KB ("3 years of tasks **+ comments**"), but it is a **pure Clicksy feature** — a new
table, queue, worker, client method, webhook subscription, and admin endpoints — fully
**additive** and verifiable on its own with the existing ClickUp token, **independent of
pgvector, Meetsy, or the production "Nifty" data**. It is built and verified first to de-risk
the biggest new Clicksy change and start comment data flowing while the KB work proceeds.

**Done when:** new comments arrive live via webhook; a historical comment backfill can be
triggered (admin) and drains within the rate limit; comments are stored idempotently in
`clickup_task_comments`, workspace-scoped, soft-deletable; Meetsy has SELECT on it.

## Goals / Non-goals

**Goals**
- Live comment capture via ClickUp webhooks (`taskCommentPosted`/`taskCommentUpdated`).
- Opt-in, rate-limit-safe, **prioritized** historical comment backfill (BullMQ).
- Idempotent storage consistent with Clicksy's existing mirror conventions; read-only grant for Meetsy.

**Non-goals (deferred — keep `parent_comment_id` nullable so they slot in later)**
- **Threaded replies** (no ClickUp webhook for replies; an N+1 `GET /comment/{id}/reply`) → Phase 1.x.
- **Comment-deletion reconciliation** (ClickUp emits no comment-deleted webhook) → later, same shape as the existing task delete-reconcile.
- The KB/embedding side (that's Meetsy Phase 2a) — this spec only makes the data exist in Clicksy.

## ClickUp API facts (verified; re-check live at build)

- **Fetch:** `GET /task/{task_id}/comment` → **25 comments/call, newest-first, cursor pagination** via `start` (Unix ms) + `start_id` (last comment id). **No "comments since" filter.** Comment object: `id`, `comment[]` (rich) + `comment_text` (plaintext), `user{id,username,email}`, `resolved`, `assignee`, `reactions`, `reply_count`, `date` (ms).
- **Webhooks:** `taskCommentPosted` + `taskCommentUpdated` **exist**, carry top-level `task_id` + the full comment object → no follow-up GET strictly required (we re-fetch anyway for resilience). **No** reply/reaction/delete webhook.
- **Rate limit:** **100 req/min** per token on Free/Unlimited/Business (verified live on the prod token), 1,000 (Business Plus) / 10,000 (Enterprise). Shared across ALL calls for that token. 429s carry `X-RateLimit-Reset`.

## Data model — `clickup_task_comments`

Model on `ClickupTaskEvent` (`prisma/schema.prisma:311-327`), **not** time-entries: a plain
indexed `taskId` with **no Prisma relation / no FK** (a `taskCommentPosted` webhook can arrive
before the task is mirrored; a real FK would throw on insert).

```prisma
model ClickupTaskComment {
  commentId        String    @id @map("comment_id")        // ClickUp comment id = conflict key
  workspaceId      String    @map("workspace_id")
  taskId           String    @map("task_id")               // plain indexed ref, no relation
  parentCommentId  String?   @map("parent_comment_id")     // null = top-level; reserved for replies
  commentText      String?   @map("comment_text")          // flattened plaintext
  userId           String?   @map("user_id")
  userName         String?   @map("user_name")
  userEmail        String?   @map("user_email")
  resolved         Boolean   @default(false)
  assigneeId       String?   @map("assignee_id")
  assigneeName     String?   @map("assignee_name")
  replyCount       Int       @default(0) @map("reply_count")
  reactions        Json?
  commentDate      DateTime? @map("comment_date")
  isDeleted        Boolean   @default(false) @map("is_deleted")
  deletedAt        DateTime? @map("deleted_at")
  syncedAt         DateTime  @default(now()) @updatedAt @map("synced_at")
  syncCount        Int       @default(0) @map("sync_count")
  raw              Json?
  @@index([taskId])
  @@index([workspaceId, commentDate])
  @@map("clickup_task_comments")
}
```

**Comment-completeness marker (for Meetsy's re-embed debounce).** Add to `ClickupTask`:
`commentsSyncedAt DateTime?` + `commentCount Int @default(0)`. A task's comment sync sets these
on completion. This lets Meetsy's KB (Phase 2a) **re-embed a task's card ONCE when its comments
are complete**, instead of N times as paginated comments trickle in (the advisor's embed-cost
trap). It also gives the onboarding UI a "comments synced for X/Y tasks" signal.

## ClickUp client

`ClickupClient.getTaskComments(workspaceId, taskId)` (model on `getTimeEntries`,
`clickup.client.ts:172`): `GET /task/{taskId}/comment`, page **backward** via `start`+`start_id`
until exhausted, concatenate. Reuse the existing 429/`Retry-After` handling
(`clickup.client.ts:61-67`). A normalizer maps `comment_text` (or joined `comment[].text`) +
user/date/resolved/etc. → the table shape.

## Queue, worker, and the rate-limit strategy

- New `QUEUES.CLICKUP_COMMENTS = 'clickup-comments'` + `JOBS.SYNC_TASK_COMMENTS` (`queue.constants.ts`).
- New `CommentSyncProcessor` (mirror `TaskSyncProcessor`) → `CommentsService.syncTaskComments` →
  `CommentsRepository.upsert` (upsert by `commentId`, `syncCount: {increment: 1}`); on completion
  set `ClickupTask.commentsSyncedAt`/`commentCount`. Standard `recordIfExhausted` dead-letter.
- **Rate limiter (conservative, shared-token-aware):** the `clickup-comments` worker limiter is set
  **well under the 100/min budget** (default **~40/min**) so Clicksy's existing task + time-entry
  sync (and Meetsy's low-volume push/members/lists calls — treated as noise) sharing the same token
  aren't starved. Respect 429 globally. *(A distributed token-budget limiter is NOT built now — the
  only bulk consumer is this backfill inside Clicksy; revisit only if it actually bites.)*
- **Prioritized (the product-owner's ask):** enqueue with BullMQ **priority** by task value —
  open/in-progress > recently-updated > in-active-sprint > high-priority > old/closed. The KB gets
  the comments that matter first and is usable before the backfill completes.

## Webhook (live capture)

- Add `taskCommentPosted` (+ optionally `taskCommentUpdated`) to default `CLICKUP_WEBHOOK_EVENTS`
  (`env.validation.ts:18-20`). Registration auto-propagates (`ClickupWebhooksService.register`
  diffs events and PUTs the addition — no secret change, no delivery gap).
- The webhook parser needs no change (comment webhooks carry top-level `task_id` + `history_items[].id`,
  already extracted, `webhook-parser.service.ts:25-26`).
- Add a branch in `ClickupEventProcessor.process` (mirror the `taskTimeTrackedUpdated` →
  time-entries pattern): on a comment event, enqueue `SYNC_TASK_COMMENTS` (re-fetch → idempotent;
  one code path, resilient).

## Backfill (history) — opt-in, NOT in the hourly sweep

The hourly reconcile must NOT fetch comments per task (no "since" filter → it would re-fetch every
recently-touched task's comments hourly). Instead:
- **Live:** webhook keeps comments current.
- **History:** explicit + opt-in. Admin endpoints (RBAC + audit free via the global guard + audit
  interceptor on `AdminController`; callable by Meetsy with the `x-admin-key` machine credential):
  - `POST /admin/comments/sync-task { taskId }` → one `SYNC_TASK_COMMENTS` job.
  - `POST /admin/comments/backfill { spaceId, allowUnknownSpaces? }` → enqueue prioritized
    comment-sync jobs for that space's known tasks (scoped to the date-range/active tasks first, not
    all-history-at-once). Returns a job/progress handle; reuse the `/admin/backfill/active`-style
    progress surface so Meetsy can poll.

## What Meetsy reads

Add to the Phase-2 grant (`apps/meetsy-api/prisma/grants.sql`):
`GRANT SELECT ON public.clickup_task_comments TO meetsy;` (+ the existing pending
`clickup_tasks`/`clickup_task_events`/`clickup_time_entries`). Meetsy mirrors it as an
**unmanaged read-only model** and never writes/migrates `public`.

## Testing / verification

- **Unit:** `getTaskComments` cursor pagination + normalizer; `CommentsRepository.upsert`
  idempotency (re-sync → no dup, `syncCount++`); processor enqueue on comment webhook event;
  dead-letter on exhausted failure.
- **Live (with the working token on team "Chishty" `90181854711` — verifiable NOW, no Nifty needed):**
  register the webhook with the comment events; post a comment on a task → it appears in
  `clickup_task_comments`; trigger `POST /admin/comments/backfill` for a small space → drains under
  the rate limit (watch `X-RateLimit-Remaining`); re-run → idempotent. (Plumbing is fully verifiable
  here; *value* — comments enriching real history — needs the Nifty data, gated on token access.)

## Risks

| Risk | Mitigation |
|---|---|
| Bulk historical backfill is rate-limited (100/min shared) | Conservative ~40/min limiter; prioritized; continuous background drain; scoped to date-range/active first |
| Webhook arrives before task mirrored | No FK on `task_id` (append-log like `ClickupTaskEvent`) |
| Comments trickle in (pagination) → repeated re-embeds downstream | `commentsSyncedAt`/`commentCount` marker → Meetsy re-embeds once on completion |
| No reply/delete webhook | Replies + delete-reconcile deferred (Phase 1.x); `parent_comment_id` reserved |
| Shared token budget across processes | Keep Clicksy limiter conservative; Meetsy calls are low-volume noise; no distributed limiter unless it bites |
| Comment normalization (`comment_text` casing, rich `comment[]`) | Defensive multi-key read; `raw` JSON passthrough; verify against one live comment |
