import { Body, Controller, Get, Param, Post, Query, Sse } from "@nestjs/common";
import { Observable } from "rxjs";
import type { AuthPrincipal } from "@clicksy/shared";
import type {
  ChatHistoryResponse,
  ConfirmRosterRequest,
  CreateMeetingRequest,
  CreateMeetingResponse,
  ProgressEvent,
  RunResponse,
  SendChatRequest,
  SendChatResponse,
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
} from "@ma/shared";
import {
  ConfirmRosterRequestSchema,
  CreateMeetingRequestSchema,
  SendChatRequestSchema,
  SubmitFeedbackRequestSchema,
} from "@ma/shared";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators";
import { AnalysisService } from "./analysis.service";

@Controller()
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  /** Upload a transcript: creates meeting + Stage-0 roster + queued run. */
  @Post("meetings")
  createMeeting(
    @CurrentUser() user: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateMeetingRequestSchema)) body: CreateMeetingRequest,
    @Query("workspaceId") workspaceId?: string,
  ): Promise<CreateMeetingResponse> {
    return this.analysis.createMeeting(user.orgId, body, workspaceId);
  }

  /** Confirm the roster, then enqueue the analysis job. */
  @Post("meetings/:id/roster")
  confirmRoster(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ConfirmRosterRequestSchema)) body: ConfirmRosterRequest,
  ): Promise<{ runId: string }> {
    return this.analysis.confirmRoster(user.orgId, id, body);
  }

  /** Poll a run's status + result. */
  @Get("runs/:id")
  getRun(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
  ): Promise<RunResponse> {
    return this.analysis.getRun(user.orgId, id);
  }

  /** Submit per-task feedback; triggers a targeted re-run. */
  @Post("runs/:id/feedback")
  submitFeedback(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SubmitFeedbackRequestSchema)) body: SubmitFeedbackRequest,
  ): Promise<SubmitFeedbackResponse> {
    return this.analysis.submitFeedback(user.orgId, id, body);
  }

  /** Chat history for a run. */
  @Get("runs/:id/chat")
  getChat(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
  ): Promise<ChatHistoryResponse> {
    return this.analysis.getChat(user.orgId, id);
  }

  /** One chat turn (can recover missed tasks into the result). */
  @Post("runs/:id/chat")
  sendChat(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SendChatRequestSchema)) body: SendChatRequest,
  ): Promise<SendChatResponse> {
    return this.analysis.sendChat(user.orgId, id, body.message);
  }

  /**
   * Live progress via Server-Sent Events. No longer @Public(): the browser's
   * EventSource sends the shared `clickup_sync_sid` cookie automatically, so the
   * global AuthGuard authenticates it like any other route. The cuid-guessing
   * tradeoff that justified the old @Public() is gone.
   * TODO(phase0-frontend): cross-origin EventSource must be opened with
   * `{ withCredentials: true }` (and CORS `credentials: true`, already set) for
   * the cookie to be sent.
   */
  @Sse("runs/:id/stream")
  streamRun(@Param("id") id: string): Observable<{ data: ProgressEvent }> {
    return this.analysis.streamRun(id);
  }
}
