import { z } from "zod";
import { ParticipantSchema, RunStatus } from "./domain";
import { ReviewResultSchema } from "./review-result";

/**
 * HTTP request/response contracts between web and api.
 */

// POST /meetings  — upload a transcript, get back a meeting + roster + a queued run
export const CreateMeetingRequestSchema = z.object({
  title: z.string().min(1).max(300),
  transcript: z.string().min(1),
  /**
   * The date the meeting took place (ISO `YYYY-MM-DD` or full ISO datetime).
   * Used as the anchor for resolving relative due dates ("by Wednesday").
   * Optional — defaults to the upload date if omitted.
   */
  meetingDate: z.string().optional(),
  /**
   * Meeting-level client, chosen by the user at upload from the workspace's
   * push-config.clientOptions. Applies to every task as the push default (still
   * per-task editable). Meetsy NEVER predicts the client. `clientOptionId` is the
   * ClickUp dropdown option UUID (what push sets); `clientName` is its display
   * name (used to condition assignment ranking + shown in the UI). Absent ⇒ no
   * meeting client.
   */
  clientOptionId: z.string().optional(),
  clientName: z.string().optional(),
});
export type CreateMeetingRequest = z.infer<typeof CreateMeetingRequestSchema>;

export const CreateMeetingResponseSchema = z.object({
  meetingId: z.string(),
  runId: z.string(),
  /** Roster extracted in Stage 0 for the user to confirm/edit. */
  roster: z.array(ParticipantSchema),
});
export type CreateMeetingResponse = z.infer<typeof CreateMeetingResponseSchema>;

// POST /meetings/:id/roster — user confirms/edits the roster, then analysis proceeds
export const ConfirmRosterRequestSchema = z.object({
  roster: z.array(ParticipantSchema),
});
export type ConfirmRosterRequest = z.infer<typeof ConfirmRosterRequestSchema>;

// GET /runs/:id — poll run status + result. `result` carries the Phase-2c/3
// signal keys (kbContext, fieldPredictions, duplicates, assignment, adjustments)
// alongside the AnalysisResult base — see ReviewResultSchema.
export const RunResponseSchema = z.object({
  runId: z.string(),
  meetingId: z.string(),
  status: RunStatus,
  result: ReviewResultSchema.nullable(),
  error: z.string().nullable().default(null),
});
export type RunResponse = z.infer<typeof RunResponseSchema>;

// GET /workspaces/:id/clickup/tasks/:taskId — resolve a ClickUp task id to
// human-readable metadata (title + status + assignee + url). Returns null (200)
// when the task isn't in the workspace's read-only mirror — a chip pointing at
// a task predating the KB sync is expected, not an error.
export const ClickUpTaskLookupViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string().nullable(),
  assigneeName: z.string().nullable(),
  url: z.string().nullable(),
  updatedAt: z.string(),
});
export type ClickUpTaskLookupView = z.infer<typeof ClickUpTaskLookupViewSchema>;

// GET /workspaces/:id/runs — paginated run list for Phase 1's /home + /meetings
// history. `pushStatus` collapses TaskPush audit rows into a single label:
//   not_configured — no push config for this workspace
//   not_pushed     — config exists but no push has been attempted
//   partial        — some tasks pushed / some failed or skipped
//   pushed         — every task successfully pushed
export const RunListPushStatus = z.enum([
  "not_configured",
  "not_pushed",
  "partial",
  "pushed",
]);
export type RunListPushStatus = z.infer<typeof RunListPushStatus>;

export const RunListItemSchema = z.object({
  id: z.string(),
  meetingId: z.string(),
  meetingTitle: z.string(),
  meetingDate: z.string().nullable(),
  status: RunStatus,
  pushStatus: RunListPushStatus.nullable(),
  taskCount: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
});
export type RunListItem = z.infer<typeof RunListItemSchema>;

export const RunListViewSchema = z.object({
  items: z.array(RunListItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type RunListView = z.infer<typeof RunListViewSchema>;
