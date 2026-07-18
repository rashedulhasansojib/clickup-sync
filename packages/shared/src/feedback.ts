import { z } from "zod";
import { ReviewResultSchema } from "./review-result";

/**
 * Phase 3 — feedback loop + chat-over-result contracts.
 */

// ── Feedback (per-task 👍/👎 + optional comment) ────────────────────────────
export const TaskVote = z.enum(["up", "down"]);
export type TaskVote = z.infer<typeof TaskVote>;

export const FeedbackItemSchema = z.object({
  /** Task id within the run's result. */
  taskId: z.string(),
  vote: TaskVote,
  /**
   * Optional correction. A downvote WITH a comment → the task is revised per the
   * comment (targeted re-run). A downvote WITHOUT a comment → the task is removed
   * (we never keep a downvoted task). Upvotes are kept as-is.
   */
  comment: z.string().optional(),
});
export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;

export const SubmitFeedbackRequestSchema = z.object({
  items: z.array(FeedbackItemSchema).min(1),
});
export type SubmitFeedbackRequest = z.infer<typeof SubmitFeedbackRequestSchema>;

export const SubmitFeedbackResponseSchema = z.object({
  /** True when the run has no actionable negatives (all upvotes). */
  accepted: z.boolean(),
  /** True if the targeted re-run changed the result. */
  changed: z.boolean(),
  /** The (possibly revised) result, with review-UI signals preserved. */
  result: ReviewResultSchema,
});
export type SubmitFeedbackResponse = z.infer<typeof SubmitFeedbackResponseSchema>;

// ── Chat-over-result (recover missed tasks, ask about the result) ────────────
export const ChatRole = z.enum(["user", "assistant"]);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: ChatRole,
  content: z.string(),
  /** ISO timestamp. */
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatHistoryResponseSchema = z.object({
  messages: z.array(ChatMessageSchema),
});
export type ChatHistoryResponse = z.infer<typeof ChatHistoryResponseSchema>;

export const SendChatRequestSchema = z.object({
  message: z.string().min(1),
});
export type SendChatRequest = z.infer<typeof SendChatRequestSchema>;

export const SendChatResponseSchema = z.object({
  reply: ChatMessageSchema,
  /** True if the assistant added/changed tasks in the result. */
  resultUpdated: z.boolean(),
  /** The updated result when resultUpdated is true (with review-UI signals preserved), else null. */
  result: ReviewResultSchema.nullable(),
});
export type SendChatResponse = z.infer<typeof SendChatResponseSchema>;
