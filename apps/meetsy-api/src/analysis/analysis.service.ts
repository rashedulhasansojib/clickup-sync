import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Observable } from "rxjs";
import type {
  AnalysisResult,
  ChatHistoryResponse,
  ConfirmRosterRequest,
  CreateMeetingRequest,
  CreateMeetingResponse,
  Participant,
  ProgressEvent,
  RunResponse,
  SendChatResponse,
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
  Task,
} from "@ma/shared";
import { AnalysisResultSchema, ParticipantSchema, ProgressEventSchema } from "@ma/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AzureOpenAIService } from "../azure/azure-openai.service";
import { ConfigService } from "../config/config.service";
import {
  assemble,
  buildRoster,
  chatOverResult,
  normalizeTranscript,
  refineTasks,
  type RefineItem,
} from "./pipeline";
import { AnalysisQueue } from "./queue/analysis.queue";
import { createRedis, runChannel } from "./queue/redis";
import { WorkspaceResolver } from "./workspace.resolver";

/**
 * Orchestrates the HTTP-facing flow:
 *  - create meeting + Stage-0 roster + queued run (not enqueued)
 *  - confirm roster -> enqueue the analysis job
 *  - read run status/result
 *  - stream live progress over SSE (Redis pub/sub + late-subscriber catch-up)
 *
 * Identity comes from Clicksy's cookie session (orgId on the principal); meetings
 * are scoped to a workspace (explicit ?workspaceId= or the org default).
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly azure: AzureOpenAIService,
    private readonly config: ConfigService,
    private readonly queue: AnalysisQueue,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  /**
   * POST /meetings — create the meeting, extract the roster (Stage 0) so the
   * user can confirm it, and create a queued (NOT enqueued) AnalysisRun.
   * Scoped to the authenticated user's org.
   */
  async createMeeting(
    orgId: string,
    body: CreateMeetingRequest,
    workspaceIdParam?: string,
  ): Promise<CreateMeetingResponse> {
    // Resolve the target workspace (explicit ?workspaceId= or the org default) so
    // the new non-null workspaceId columns are satisfied.
    const workspaceId = await this.workspaces.resolve(orgId, workspaceIdParam);

    // Stage 0: deterministic VTT normalization + roster extraction.
    const normalized = normalizeTranscript(body.transcript);
    const roster = await buildRoster(this.azure, normalized);

    // Anchor for relative due-date resolution; default to upload date.
    const parsed = body.meetingDate ? new Date(body.meetingDate) : new Date();
    const meetingDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

    const meeting = await this.prisma.meeting.create({
      data: {
        orgId,
        workspaceId,
        title: body.title,
        transcript: body.transcript,
        normalizedTranscript: normalized.cleanTranscript,
        meetingDate,
        // Persist the extracted roster as a sensible default; the user may
        // overwrite it via POST /meetings/:id/roster before analysis runs.
        roster: roster as unknown as Prisma.InputJsonValue,
      },
    });

    const run = await this.prisma.analysisRun.create({
      data: { orgId, workspaceId, meetingId: meeting.id, status: "queued" },
    });

    return { meetingId: meeting.id, runId: run.id, roster };
  }

  /**
   * POST /meetings/:id/roster — save the confirmed roster, then ENQUEUE the
   * queued run's analysis job.
   */
  async confirmRoster(
    orgId: string,
    meetingId: string,
    body: ConfirmRosterRequest,
  ): Promise<{ runId: string }> {
    const meeting = await this.prisma.meeting.findUnique({ where: { id: meetingId } });
    if (!meeting || meeting.orgId !== orgId) {
      throw new NotFoundException(`Meeting ${meetingId} not found`);
    }

    await this.prisma.meeting.update({
      where: { id: meetingId },
      data: { roster: body.roster as unknown as Prisma.InputJsonValue },
    });

    // Find the queued run for this meeting (created at upload time).
    const run = await this.prisma.analysisRun.findFirst({
      where: { meetingId, status: "queued" },
      orderBy: { createdAt: "desc" },
    });
    if (!run) {
      throw new NotFoundException(`No queued run found for meeting ${meetingId}`);
    }

    await this.queue.enqueue({ runId: run.id, meetingId, orgId: meeting.orgId });
    return { runId: run.id };
  }

  /** GET /runs/:id — current status + result. */
  async getRun(orgId: string, runId: string): Promise<RunResponse> {
    const run = await this.prisma.analysisRun.findUnique({ where: { id: runId } });
    if (!run || run.orgId !== orgId) {
      throw new NotFoundException(`Run ${runId} not found`);
    }
    return {
      runId: run.id,
      meetingId: run.meetingId,
      status: run.status,
      // `.passthrough()` so the Phase-2c/3 signal keys the processor attaches
      // alongside the AnalysisResult (kbContext / fieldPredictions / duplicates /
      // assignment / adjustments) survive to the review UI — plain `.parse()`
      // strips unknown keys and the signals never reach the client.
      result: run.result
        ? AnalysisResultSchema.passthrough().parse(run.result)
        : null,
      error: run.error ?? null,
    };
  }

  // ── Phase 3: feedback + chat ─────────────────────────────────────────────

  /** Load a completed run's full context for feedback/chat operations (org-scoped). */
  private async loadRunContext(orgId: string, runId: string): Promise<{
    orgId: string;
    result: AnalysisResult;
    roster: Participant[];
    transcript: string;
    meetingDateISO: string;
    tasks: Task[];
  }> {
    const run = await this.prisma.analysisRun.findUnique({ where: { id: runId } });
    if (!run || run.orgId !== orgId) throw new NotFoundException(`Run ${runId} not found`);
    if (!run.result) throw new BadRequestException(`Run ${runId} has no result yet`);
    const meeting = await this.prisma.meeting.findUnique({ where: { id: run.meetingId } });
    if (!meeting) throw new NotFoundException(`Meeting ${run.meetingId} not found`);

    const result = AnalysisResultSchema.parse(run.result);
    const roster = ParticipantSchema.array().parse(meeting.roster ?? []);
    const transcript = meeting.normalizedTranscript ?? meeting.transcript;
    const meetingDateISO = (meeting.meetingDate ?? meeting.createdAt)
      .toISOString()
      .slice(0, 10);
    const tasks = flattenTasks(result);
    return { orgId: run.orgId, result, roster, transcript, meetingDateISO, tasks };
  }

  /**
   * POST /runs/:id/feedback — record per-task votes/comments and run a TARGETED
   * re-run: downvote+comment → revise that task; downvote (no comment) → remove
   * it; upvotes → keep. Untouched tasks are preserved byte-for-byte.
   */
  async submitFeedback(
    orgId: string,
    runId: string,
    body: SubmitFeedbackRequest,
  ): Promise<SubmitFeedbackResponse> {
    const ctx = await this.loadRunContext(orgId, runId);

    await this.prisma.feedback.createMany({
      data: body.items.map((it) => ({
        orgId: ctx.orgId,
        runId,
        taskId: it.taskId,
        vote: it.vote,
        comment: it.comment ?? null,
      })),
    });

    const taskById = new Map(ctx.tasks.map((t) => [t.id, t]));
    const removeIds = new Set<string>();
    const toRevise: RefineItem[] = [];
    let hasNegative = false;

    for (const it of body.items) {
      if (it.vote !== "down") continue;
      hasNegative = true;
      const task = taskById.get(it.taskId);
      if (!task) continue;
      if (it.comment && it.comment.trim()) {
        toRevise.push({ task, comment: it.comment.trim() });
      } else {
        removeIds.add(it.taskId);
      }
    }

    const revised = await refineTasks(
      this.azure,
      ctx.transcript,
      ctx.roster,
      toRevise,
      ctx.meetingDateISO,
    );

    const changed = removeIds.size > 0 || revised.size > 0;
    const newTasks = ctx.tasks
      .filter((t) => !removeIds.has(t.id))
      .map((t) => revised.get(t.id) ?? t);
    const result = changed
      ? assemble(ctx.result.overview, ctx.roster, newTasks)
      : ctx.result;
    const accepted = !hasNegative;

    await this.prisma.analysisRun.update({
      where: { id: runId },
      data: { result: result as unknown as Prisma.InputJsonValue, accepted },
    });
    return { accepted, changed, result };
  }

  /** GET /runs/:id/chat — conversation history (org-scoped). */
  async getChat(orgId: string, runId: string): Promise<ChatHistoryResponse> {
    const run = await this.prisma.analysisRun.findUnique({ where: { id: runId } });
    if (!run || run.orgId !== orgId) throw new NotFoundException(`Run ${runId} not found`);
    const msgs = await this.prisma.chatMessage.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
    });
    return {
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  /**
   * POST /runs/:id/chat — one chat turn. The assistant can recover a missed task
   * from the transcript and append it to the result.
   */
  async sendChat(orgId: string, runId: string, message: string): Promise<SendChatResponse> {
    const ctx = await this.loadRunContext(orgId, runId);

    const history = await this.prisma.chatMessage.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
    });
    await this.prisma.chatMessage.create({
      data: { orgId: ctx.orgId, runId, role: "user", content: message },
    });

    const { reply, newTasks } = await chatOverResult(
      this.azure,
      ctx.transcript,
      ctx.roster,
      ctx.tasks,
      history.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
      message,
      ctx.meetingDateISO,
      nextTaskNumber(ctx.tasks),
    );

    let resultUpdated = false;
    let result: AnalysisResult | null = null;
    if (newTasks.length > 0) {
      result = assemble(ctx.result.overview, ctx.roster, ctx.tasks.concat(newTasks));
      await this.prisma.analysisRun.update({
        where: { id: runId },
        data: { result: result as unknown as Prisma.InputJsonValue },
      });
      resultUpdated = true;
    }

    const assistant = await this.prisma.chatMessage.create({
      data: { orgId: ctx.orgId, runId, role: "assistant", content: reply },
    });
    return {
      reply: {
        id: assistant.id,
        role: "assistant",
        content: reply,
        createdAt: assistant.createdAt.toISOString(),
      },
      resultUpdated,
      result,
    };
  }

  /**
   * GET /runs/:id/stream — SSE of ProgressEvents.
   *
   * Uses a DEDICATED Redis subscriber (a connection in subscribe mode can't run
   * other commands), torn down when the client disconnects. Handles the
   * late-subscriber race: if the run already finished, emit a terminal event and
   * complete immediately instead of subscribing to a channel no one will publish.
   */
  streamRun(runId: string): Observable<{ data: ProgressEvent }> {
    return new Observable<{ data: ProgressEvent }>((subscriber) => {
      const { host, port } = this.config.redis;
      const redis = createRedis(host, port);
      let closed = false;

      const terminal = (status: "completed" | "failed", message: string): void => {
        const event: ProgressEvent = {
          runId,
          stage: "assemble",
          status,
          message,
          progress: 1,
          at: Date.now(),
        };
        subscriber.next({ data: event });
        subscriber.complete();
      };

      const start = async (): Promise<void> => {
        // SUBSCRIBE FIRST, then read DB status. This closes the race where the
        // worker finishes between a status read and the subscribe call (which
        // would otherwise leave the client hanging on a channel no one publishes
        // to again). A double terminal emit is harmless — complete() is called
        // on the first one.
        redis.on("message", (_channel, payload) => {
          const parsed = ProgressEventSchema.safeParse(JSON.parse(payload));
          if (!parsed.success) {
            this.logger.warn(`Dropping malformed progress event on ${runChannel(runId)}`);
            return;
          }
          const event = parsed.data;
          subscriber.next({ data: event });
          // Complete the stream once the run reaches a terminal state.
          if (event.progress >= 1 && (event.status === "completed" || event.status === "failed")) {
            subscriber.complete();
          }
        });
        await redis.subscribe(runChannel(runId));

        // Late-subscriber catch-up: if the run is already terminal (or finished
        // during/just before subscribing), emit a terminal event + complete now.
        const run = await this.prisma.analysisRun.findUnique({ where: { id: runId } });
        if (!run) {
          subscriber.error(new NotFoundException(`Run ${runId} not found`));
          return;
        }
        if (run.status === "completed") {
          terminal("completed", "Analysis complete");
          return;
        }
        if (run.status === "failed") {
          terminal("failed", run.error ?? "Analysis failed");
          return;
        }
      };

      // Surface async failures to the client instead of silently hanging.
      void start().catch((err) => subscriber.error(err));

      // Teardown: runs on client disconnect or completion.
      return () => {
        if (closed) return;
        closed = true;
        redis.disconnect();
      };
    });
  }
}

/** Flatten an AnalysisResult back into a single task list (assigned + unassigned). */
function flattenTasks(result: AnalysisResult): Task[] {
  return [...result.people.flatMap((p) => p.tasks), ...result.unassignedTasks];
}

/** Next numeric task id ("t7" → 7), so newly-added tasks get fresh ids. */
function nextTaskNumber(tasks: Task[]): number {
  let max = 0;
  for (const t of tasks) {
    const m = /^t(\d+)$/.exec(t.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}
