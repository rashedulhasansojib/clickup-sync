import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Sse,
} from "@nestjs/common";
import { Observable } from "rxjs";
import type { AuthPrincipal } from "@clicksy/shared";
import type {
  CancelRunResponse,
  ChatHistoryResponse,
  ConfirmRosterRequest,
  CreateMeetingRequest,
  CreateMeetingResponse,
  RetryRunResponse,
  RunListView,
  RunResponse,
  RunStageTimingsResponse,
  SendChatRequest,
  SendChatResponse,
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
} from "@ma/shared";
import type { RunNotificationEvent } from "./run-notification.service";
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

  /**
   * v2 Phase 1 — full-text search over meeting title + transcript for the
   * workspace's runs. Same RunListView shape as listRuns; empty `q` is a
   * 400 (the client should call listRuns for the unfiltered view).
   *
   * NB: this route MUST be declared BEFORE `GET /runs/:id` in NestJS's route
   * table so `runs/search` is not swallowed as a run id. Same reason listRuns
   * lives at the top of this controller.
   */
  @Get("workspaces/:id/runs/search")
  async searchRuns(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("q") q?: string,
    @Query("limit") limitParam?: string,
    @Query("offset") offsetParam?: string,
    @Query("status") statusParam?: string,
  ): Promise<RunListView> {
    const trimmed = (q ?? "").trim();
    if (!trimmed) {
      throw new BadRequestException("Query parameter `q` is required");
    }
    if (trimmed.length > 200) {
      throw new BadRequestException("Query is too long (max 200 chars)");
    }
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    const limit = Math.min(
      Math.max(Number.parseInt(limitParam ?? "20", 10) || 20, 1),
      100,
    );
    const offset = Math.max(Number.parseInt(offsetParam ?? "0", 10) || 0, 0);
    const parsedStatus = statusParam ? RunStatus.safeParse(statusParam) : null;
    const status = parsedStatus?.success ? parsedStatus.data : undefined;
    return this.analysis.searchRuns(workspaceId, {
      q: trimmed,
      limit,
      offset,
      status,
    });
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
    return this.analysis.confirmRoster(user.orgId, user.userId, id, body, workspaceId);
  }

  /** Poll a run's status + result + durable progress state. */
  @Get("runs/:id")
  getRun(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("workspaceId") workspaceId?: string,
  ): Promise<RunResponse> {
    return this.analysis.getRun(user.orgId, id, workspaceId);
  }

  /**
   * Median seconds per stage across the last N completed runs — powers the
   * "typical duration" hint on the pipeline stepper. Declared BEFORE
   * `GET /runs/:id` so `stage-timings` is not matched as a run id.
   */
  @Get("workspaces/:id/runs/stage-timings")
  getRunStageTimings(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("limit") limitParam?: string,
  ): Promise<RunStageTimingsResponse> {
    const limit = Math.max(1, Math.min(Number.parseInt(limitParam ?? "10", 10) || 10, 50));
    return this.analysis.runStageTimings(user.orgId, id, limit);
  }

  /**
   * Cancel a queued/running run. Queued → removed from BullMQ + row settled
   * immediately. Running → sets `cancelRequestedAt`; the processor terminates
   * at the next between-stage boundary. Terminal states → 400.
   */
  @Post("runs/:id/cancel")
  cancelRun(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("workspaceId") workspaceId?: string,
  ): Promise<CancelRunResponse> {
    return this.analysis.cancelRun(user.orgId, id, workspaceId);
  }

  /**
   * Enqueue a fresh AnalysisRun for the same meeting (retry = new work, not
   * resume-from-failed-stage). Only defined for failed/cancelled runs — the
   * client navigates to `/runs/<new>`.
   */
  @Post("runs/:id/retry")
  retryRun(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("workspaceId") workspaceId?: string,
  ): Promise<RetryRunResponse> {
    return this.analysis.retryRun(user.orgId, id, workspaceId);
  }

  /**
   * Workspace-scoped run notifications SSE — mirrors `/learning/stream`.
   * Emits on any terminal (completed/failed/cancelled) so a user who
   * navigated away can be toasted the moment the run settles.
   */
  @Sse("workspaces/:id/runs/stream")
  streamWorkspaceRuns(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
  ): Observable<{ data: RunNotificationEvent }> {
    return this.analysis.streamWorkspaceRuns(user.orgId, id);
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
  ): Observable<{ data: unknown; type?: string }> {
    return this.analysis.streamRun(user.orgId, id, workspaceId);
  }
}
