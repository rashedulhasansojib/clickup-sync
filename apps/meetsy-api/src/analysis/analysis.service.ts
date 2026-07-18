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
  ReviewResult,
  ReviewSignals,
  RunListItem,
  RunListPushStatus,
  RunListView,
  RunResponse,
  RunStatus,
  SendChatResponse,
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
  Task,
} from "@ma/shared";
import {
  ParticipantSchema,
  ProgressEventSchema,
  ReviewResultSchema,
} from "@ma/shared";
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
import { ClickUpClient } from "../clickup/clickup.client";
import { AssigneeResolverService } from "../clickup/assignee-resolver.service";

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
    private readonly clickup: ClickUpClient,
    private readonly assigneeResolver: AssigneeResolverService,
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

    // Best-effort: suggest a ClickUp member per roster participant so the user
    // confirms (not types) the assignee mapping at the roster step. A missing
    // token / no ClickUp connection leaves clickupUserId null and the meeting
    // still creates (mirrors how the processor treats assignableMembers as optional).
    await this.suggestClickupMembers(workspaceId, roster);

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
        // Meeting-level client chosen at upload (trusted client-supplied; no DB
        // validation of the option UUID). Defaults each task's push client.
        clientOptionId: body.clientOptionId ?? null,
        clientName: body.clientName ?? null,
      },
    });

    const run = await this.prisma.analysisRun.create({
      data: { orgId, workspaceId, meetingId: meeting.id, status: "queued" },
    });

    return { meetingId: meeting.id, runId: run.id, roster };
  }

  /**
   * Best-effort: annotate each roster participant IN PLACE with a suggested
   * ClickUp member (clickupUserId + clickupName). Resolves the workspace's
   * members once, then for each participant tries the displayName and any aliases
   * (first hit wins). Wrapped so a missing token / no ClickUp connection leaves
   * every participant at clickupUserId:null and never blocks meeting creation.
   */
  private async suggestClickupMembers(
    workspaceId: string,
    roster: Participant[],
  ): Promise<void> {
    if (roster.length === 0) return;
    try {
      const members = await this.clickup.getAssignableMembers(workspaceId);
      if (members.length === 0) return;
      const nameById = new Map(members.map((m) => [m.clickupUserId, m.name]));
      for (const p of roster) {
        for (const name of [p.displayName, ...p.aliases]) {
          const matchedId = this.assigneeResolver.resolve(name, members);
          if (matchedId) {
            p.clickupUserId = matchedId;
            p.clickupName = nameById.get(matchedId) ?? null;
            break;
          }
        }
      }
    } catch (err) {
      this.logger.warn(
        `ClickUp member suggestion skipped for workspace ${workspaceId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * POST /meetings/:id/roster — save the confirmed roster, then ENQUEUE the
   * queued run's analysis job.
   */
  async confirmRoster(
    orgId: string,
    meetingId: string,
    body: ConfirmRosterRequest,
    workspaceIdParam?: string,
  ): Promise<{ runId: string }> {
    const workspaceId = await this.workspaces.resolve(orgId, workspaceIdParam);
    const meeting = await this.prisma.meeting.findFirst({
      where: { id: meetingId, orgId, workspaceId },
    });
    if (!meeting) {
      throw new NotFoundException(`Meeting ${meetingId} not found`);
    }

    await this.prisma.meeting.update({
      where: { id: meetingId },
      data: { roster: body.roster as unknown as Prisma.InputJsonValue },
    });

    // Find the queued run for this meeting (created at upload time).
    const run = await this.prisma.analysisRun.findFirst({
      where: { meetingId, workspaceId, status: "queued" },
      orderBy: { createdAt: "desc" },
    });
    if (!run) {
      throw new NotFoundException(`No queued run found for meeting ${meetingId}`);
    }

    await this.queue.enqueue({ runId: run.id, meetingId, orgId: meeting.orgId });
    return { runId: run.id };
  }

  /**
   * GET /workspaces/:id/runs — paginated run list (newest first). Powers Phase 1's
   * /home recent-runs card + /meetings history. Workspace-scoped via
   * WorkspaceResolver; the count is over the same predicate as the page.
   *
   * `pushStatus` collapses TaskPush audit rows to a single label so the UI can
   * render one badge per run (see RunListPushStatus). Requires ONE extra query
   * per page (a groupBy over TaskPush + a single push-config lookup) — small vs.
   * the alternative of joining in the DB with a raw SQL, and keeps the endpoint
   * within Prisma's typed surface.
   */
  async listRuns(
    workspaceId: string,
    opts: { limit: number; offset: number; status?: RunStatus },
  ): Promise<RunListView> {
    const where = {
      workspaceId,
      ...(opts.status ? { status: opts.status } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.analysisRun.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: opts.offset,
        take: opts.limit,
        select: {
          id: true,
          meetingId: true,
          status: true,
          result: true,
          createdAt: true,
          meeting: { select: { title: true, meetingDate: true } },
        },
      }),
      this.prisma.analysisRun.count({ where }),
    ]);

    // Batch-fetch every run's push audit rows in one query, then reduce.
    const runIds = items.map((r) => r.id);
    const pushRows = runIds.length
      ? await this.prisma.taskPush.findMany({
          where: { runId: { in: runIds } },
          select: { runId: true, status: true },
        })
      : [];
    const byRun = new Map<string, { pushed: number; failed: number; skipped: number }>();
    for (const p of pushRows) {
      const acc = byRun.get(p.runId) ?? { pushed: 0, failed: 0, skipped: 0 };
      if (p.status === "pushed") acc.pushed += 1;
      else if (p.status === "failed") acc.failed += 1;
      else acc.skipped += 1;
      byRun.set(p.runId, acc);
    }

    // One workspace-scoped push-config lookup covers the whole page.
    const pushConfig = await this.prisma.workspacePushConfig.findUnique({
      where: { workspaceId },
      select: { workspaceId: true },
    });

    const rows: RunListItem[] = items.map((r) => {
      const taskCount = extractTaskCount(r.result);
      const pushStatus = derivePushStatus({
        completed: r.status === "completed",
        taskCount,
        pushCounts: byRun.get(r.id) ?? null,
        hasPushConfig: !!pushConfig,
      });
      return {
        id: r.id,
        meetingId: r.meetingId,
        meetingTitle: r.meeting.title,
        meetingDate: r.meeting.meetingDate ? r.meeting.meetingDate.toISOString() : null,
        status: r.status,
        pushStatus,
        taskCount,
        createdAt: r.createdAt.toISOString(),
      };
    });

    return { items: rows, total, limit: opts.limit, offset: opts.offset };
  }

  /** GET /runs/:id — current status + result. */
  async getRun(orgId: string, runId: string, workspaceIdParam?: string): Promise<RunResponse> {
    const workspaceId = await this.workspaces.resolve(orgId, workspaceIdParam);
    const run = await this.prisma.analysisRun.findFirst({
      where: { id: runId, orgId, workspaceId },
    });
    if (!run) {
      throw new NotFoundException(`Run ${runId} not found`);
    }
    return {
      runId: run.id,
      meetingId: run.meetingId,
      status: run.status,
      // ReviewResultSchema validates the AnalysisResult base + the five Phase-2c/3
      // signal keys (kbContext / fieldPredictions / duplicates / assignment /
      // adjustments) as first-class optional fields — so the signals survive
      // end-to-end with real Zod validation, not `.passthrough()` widening.
      result: run.result ? ReviewResultSchema.parse(run.result) : null,
      error: run.error ?? null,
    };
  }

  // ── Phase 3: feedback + chat ─────────────────────────────────────────────

  /** Load a completed run's full context for feedback/chat operations (workspace-scoped).
   *
   * Parses `run.result` with ReviewResultSchema so the Phase-2c/3 signal keys
   * (kbContext / fieldPredictions / duplicates / assignment / adjustments) round-trip
   * through feedback + chat writes — previously plain `.parse()` here silently stripped
   * them and every mutation persisted a signal-free result, killing the learning-loop
   * FieldOverride reader at push.service.ts (which reads .fieldPredictions).
   */
  private async loadRunContext(orgId: string, runId: string, workspaceId: string): Promise<{
    orgId: string;
    result: ReviewResult;
    roster: Participant[];
    transcript: string;
    meetingDateISO: string;
    tasks: Task[];
  }> {
    const run = await this.prisma.analysisRun.findFirst({
      where: { id: runId, orgId, workspaceId },
    });
    if (!run) throw new NotFoundException(`Run ${runId} not found`);
    if (!run.result) throw new BadRequestException(`Run ${runId} has no result yet`);
    const meeting = await this.prisma.meeting.findFirst({
      where: { id: run.meetingId, workspaceId },
    });
    if (!meeting) throw new NotFoundException(`Meeting ${run.meetingId} not found`);

    const result = ReviewResultSchema.parse(run.result);
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
    workspaceIdParam?: string,
  ): Promise<SubmitFeedbackResponse> {
    const workspaceId = await this.workspaces.resolve(orgId, workspaceIdParam);
    const ctx = await this.loadRunContext(orgId, runId, workspaceId);

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
    // assemble() rebuilds a strict AnalysisResult — merge the review signals back
    // on so evidence (kbContext / fieldPredictions / duplicates / assignment /
    // adjustments) survives the feedback write.
    const result: ReviewResult = changed
      ? mergeSignals(assemble(ctx.result.overview, ctx.roster, newTasks), ctx.result)
      : ctx.result;
    const accepted = !hasNegative;

    await this.prisma.analysisRun.update({
      where: { id: runId },
      data: { result: result as unknown as Prisma.InputJsonValue, accepted },
    });
    return { accepted, changed, result };
  }

  /** GET /runs/:id/chat — conversation history (workspace-scoped). */
  async getChat(orgId: string, runId: string, workspaceIdParam?: string): Promise<ChatHistoryResponse> {
    const workspaceId = await this.workspaces.resolve(orgId, workspaceIdParam);
    const run = await this.prisma.analysisRun.findFirst({
      where: { id: runId, orgId, workspaceId },
    });
    if (!run) throw new NotFoundException(`Run ${runId} not found`);
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
  async sendChat(
    orgId: string,
    runId: string,
    message: string,
    workspaceIdParam?: string,
  ): Promise<SendChatResponse> {
    const workspaceId = await this.workspaces.resolve(orgId, workspaceIdParam);
    const ctx = await this.loadRunContext(orgId, runId, workspaceId);

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
    let result: ReviewResult | null = null;
    if (newTasks.length > 0) {
      // Same as submitFeedback: assemble() is strict; merge the review signals
      // (kbContext / fieldPredictions / duplicates / assignment / adjustments)
      // back on so chat-added tasks don't strip evidence from the run.
      result = mergeSignals(
        assemble(ctx.result.overview, ctx.roster, ctx.tasks.concat(newTasks)),
        ctx.result,
      );
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
  streamRun(orgId: string, runId: string, workspaceIdParam?: string): Observable<{ data: ProgressEvent }> {
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
        // Authorize BEFORE subscribing: resolve the workspace and confirm the run
        // exists within (orgId, workspaceId). A miss yields 404 (never 403) so we
        // don't leak run existence across workspaces/orgs.
        const workspaceId = await this.workspaces.resolve(orgId, workspaceIdParam);
        const authorized = await this.prisma.analysisRun.findFirst({
          where: { id: runId, orgId, workspaceId },
        });
        if (!authorized) {
          subscriber.error(new NotFoundException(`Run ${runId} not found`));
          return;
        }

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
        // Re-read AFTER subscribe (preserving the subscribe-first ordering above)
        // for a fresh status, still scoped to (orgId, workspaceId).
        const run = await this.prisma.analysisRun.findFirst({
          where: { id: runId, orgId, workspaceId },
        });
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

/**
 * Re-attach the five Phase-2c/3 signal keys onto a freshly-assembled AnalysisResult.
 * Called after `assemble()` in feedback + chat writes so evidence (kbContext /
 * fieldPredictions / duplicates / assignment / adjustments) survives the mutation
 * — assemble() itself is intentionally signal-agnostic (parses to strict
 * AnalysisResultSchema on output).
 *
 * The signals are OPTIONAL — a run whose pipeline abstained on all fields will
 * legitimately have no `fieldPredictions`, and older v1 runs may have none at all.
 * We copy whichever keys are present on `source`; missing keys stay missing.
 */
function mergeSignals(base: AnalysisResult, source: ReviewResult): ReviewResult {
  const signals: ReviewSignals = {
    kbContext: source.kbContext,
    fieldPredictions: source.fieldPredictions,
    duplicates: source.duplicates,
    assignment: source.assignment,
    adjustments: source.adjustments,
  };
  return { ...base, ...signals };
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

/**
 * Best-effort task count for the runs-list badge. Doesn't Zod-parse the full
 * result (this is called per row); reads people[i].tasks + unassignedTasks
 * defensively so a malformed row degrades to null rather than throwing.
 */
function extractTaskCount(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { people?: unknown; unassignedTasks?: unknown };
  if (!Array.isArray(r.people)) return null;
  let n = 0;
  for (const p of r.people) {
    if (p && typeof p === "object" && Array.isArray((p as { tasks?: unknown }).tasks)) {
      n += ((p as { tasks: unknown[] }).tasks).length;
    }
  }
  if (Array.isArray(r.unassignedTasks)) n += r.unassignedTasks.length;
  return n;
}

/**
 * Collapse a run's TaskPush audit into one label. Non-completed runs get null.
 * Completed but zero-task runs stay `not_pushed` (there was nothing to push).
 *   not_configured — no push config for the workspace
 *   not_pushed     — config exists but no push has been attempted for this run
 *   pushed         — every task successfully pushed
 *   partial        — some pushed, some failed/skipped (a re-push resolves this)
 */
function derivePushStatus(input: {
  completed: boolean;
  taskCount: number | null;
  pushCounts: { pushed: number; failed: number; skipped: number } | null;
  hasPushConfig: boolean;
}): RunListPushStatus | null {
  if (!input.completed) return null;
  if (!input.hasPushConfig) return "not_configured";
  if (!input.pushCounts) return "not_pushed";
  const { pushed, failed, skipped } = input.pushCounts;
  const total = pushed + failed + skipped;
  if (total === 0) return "not_pushed";
  if (failed === 0 && skipped === 0) return "pushed";
  return "partial";
}
