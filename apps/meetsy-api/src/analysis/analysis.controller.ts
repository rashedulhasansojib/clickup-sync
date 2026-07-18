import { Body, Controller, Get, Param, Post, Query, Sse } from "@nestjs/common";
import { Observable } from "rxjs";
import type { AuthPrincipal } from "@clicksy/shared";
import type {
  ChatHistoryResponse,
  ConfirmRosterRequest,
  CreateMeetingRequest,
  CreateMeetingResponse,
  ProgressEvent,
  RunListView,
  RunResponse,
  SendChatRequest,
  SendChatResponse,
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
} from "@ma/shared";
import {
  ConfirmRosterRequestSchema,
  CreateMeetingRequestSchema,
  RunStatus,
  SendChatRequestSchema,
  SubmitFeedbackRequestSchema,
} from "@ma/shared";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators";
import { WorkspaceResolver } from "./workspace.resolver";
import { AnalysisService } from "./analysis.service";

@Controller()
export class AnalysisController {
  constructor(
    private readonly analysis: AnalysisService,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  /**
   * Paginated run list (newest first) for a workspace. Powers Phase 1's home +
   * meetings-history pages. Any authenticated user; the WorkspaceResolver
   * enforces same-org scoping.
   */
  @Get("workspaces/:id/runs")
  async listRuns(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("limit") limitParam?: string,
    @Query("offset") offsetParam?: string,
    @Query("status") statusParam?: string,
  ): Promise<RunListView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    const limit = Math.min(
      Math.max(Number.parseInt(limitParam ?? "20", 10) || 20, 1),
      100,
    );
    const offset = Math.max(Number.parseInt(offsetParam ?? "0", 10) || 0, 0);
    // Unknown status → drop the filter rather than 400 — the query-string is
    // client-controlled and a stale bookmark shouldn't error.
    const parsedStatus = statusParam ? RunStatus.safeParse(statusParam) : null;
    const status = parsedStatus?.success ? parsedStatus.data : undefined;
    return this.analysis.listRuns(workspaceId, { limit, offset, status });
  }

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
    @Query("workspaceId") workspaceId?: string,
  ): Promise<{ runId: string }> {
    return this.analysis.confirmRoster(user.orgId, id, body, workspaceId);
  }

  /** Poll a run's status + result. */
  @Get("runs/:id")
  getRun(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("workspaceId") workspaceId?: string,
  ): Promise<RunResponse> {
    return this.analysis.getRun(user.orgId, id, workspaceId);
  }

  /** Submit per-task feedback; triggers a targeted re-run. */
  @Post("runs/:id/feedback")
  submitFeedback(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SubmitFeedbackRequestSchema)) body: SubmitFeedbackRequest,
    @Query("workspaceId") workspaceId?: string,
  ): Promise<SubmitFeedbackResponse> {
    return this.analysis.submitFeedback(user.orgId, id, body, workspaceId);
  }

  /** Chat history for a run. */
  @Get("runs/:id/chat")
  getChat(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("workspaceId") workspaceId?: string,
  ): Promise<ChatHistoryResponse> {
    return this.analysis.getChat(user.orgId, id, workspaceId);
  }

  /** One chat turn (can recover missed tasks into the result). */
  @Post("runs/:id/chat")
  sendChat(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SendChatRequestSchema)) body: SendChatRequest,
    @Query("workspaceId") workspaceId?: string,
  ): Promise<SendChatResponse> {
    return this.analysis.sendChat(user.orgId, id, body.message, workspaceId);
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
  streamRun(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("workspaceId") workspaceId?: string,
  ): Observable<{ data: ProgressEvent }> {
    return this.analysis.streamRun(user.orgId, id, workspaceId);
  }
}
