import { z } from "zod";
import { AnalysisResultSchema, ParticipantSchema, RunStatus } from "./domain";

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

// GET /runs/:id — poll run status + result
export const RunResponseSchema = z.object({
  runId: z.string(),
  meetingId: z.string(),
  status: RunStatus,
  result: AnalysisResultSchema.nullable(),
  error: z.string().nullable().default(null),
});
export type RunResponse = z.infer<typeof RunResponseSchema>;
