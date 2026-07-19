import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Job, Worker } from "bullmq";
import { Prisma } from "@prisma/client";
import type { Participant, PipelineStage, ProgressEvent, StageStatus } from "@ma/shared";
import { ParticipantSchema } from "@ma/shared";
import { ConfigService } from "../../config/config.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AzureOpenAIService } from "../../azure/azure-openai.service";
import { analyzeMeeting, assemble, criticPass, enrichTasks } from "../pipeline";
import { runWithUsage } from "../../observability/usage.context";
import { AnalysisJobData, AnalysisQueue } from "./analysis.queue";
import { ANALYSIS_QUEUE_NAME } from "./redis";
import { KbSearchService, type KbContextHit } from "../../kb/kb-search.service";
import { KbQueue } from "../../kb/kb.queue";
import { FieldPredictionService, type TaskAnalysis } from "../../kb/field-prediction.service";
import { AssignmentService, type TaskAssignment } from "../../kb/assignment.service";
import { LearningService, type TaskAdjustments } from "../../kb/learning.service";
import { MlConfigService } from "../../kb/ml-config.service";
import { RunNotificationService } from "../run-notification.service";
import type { Neighbour } from "../../kb/prediction-prior";
import type { AssignableMember } from "../../clickup/clickup.types";
import { buildContextQuery, formatContextForPrompt } from "../pipeline-context";

/**
 * Thrown by `checkCancelled()` when the user has requested cancellation via
 * `POST /runs/:id/cancel`. Caught by `process()` to distinguish user cancel
 * (row → status=cancelled) from real failures (row → status=failed).
 */
export class CancelledRunError extends Error {
  constructor(message = "Cancelled by user") {
    super(message);
    this.name = "CancelledRunError";
  }
}

/**
 * BullMQ Worker that runs IN THE SAME Nest process (started in onModuleInit).
 *
 * For each job it runs comprehend → extract → assemble, persisting status +
 * result to AnalysisRun and publishing a ProgressEvent before/after each stage
 * (per @ma/shared ProgressEventSchema) so the SSE endpoint can stream progress.
 *
 * Every `emit()` also writes `currentStage`/`progress`/`stageStartedAt` onto
 * the row so a client that (re)connects mid-run — hard reload, workspace
 * remount, dev HMR — can hydrate the stepper from `GET /runs/:id` WITHOUT
 * waiting for the next Redis pub/sub event. `progress` is written monotonically
 * via `GREATEST()` so out-of-order writes never regress.
 *
 * Between every pipeline stage `checkCancelled()` reads the row; if
 * `cancelRequestedAt` is set the run is terminated with `status=cancelled`
 * and a terminal event is published so any live client can stop the stepper.
 */
@Injectable()
export class AnalysisProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalysisProcessor.name);
  private worker!: Worker<AnalysisJobData>;
  // Per-run stage-timing state, cleared on terminal in a `finally`. Written on
  // the first `emit()` of each stage and consumed at run completion for the
  // `AnalysisRun.stageDurations` JSON blob (powers per-stage timers and the
  // rolling "typical duration" hint on the stepper).
  private readonly stageStartTimes = new Map<string, Map<PipelineStage, number>>();
  private readonly stageDurations = new Map<string, Record<string, number>>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly azure: AzureOpenAIService,
    private readonly queue: AnalysisQueue,
    private readonly kbSearch: KbSearchService,
    private readonly kbQueue: KbQueue,
    private readonly fieldPrediction: FieldPredictionService,
    private readonly assignment: AssignmentService,
    private readonly learning: LearningService,
    private readonly mlConfig: MlConfigService,
    private readonly runNotify: RunNotificationService,
  ) {}

  onModuleInit(): void {
    const { host, port } = this.config.redis;
    this.worker = new Worker<AnalysisJobData>(
      ANALYSIS_QUEUE_NAME,
      (job) => this.process(job),
      { connection: { host, port, maxRetriesPerRequest: null } },
    );
    this.worker.on("failed", (job, err) => {
      this.logger.error(`Job ${job?.id} failed: ${err.message}`);
    });
    this.logger.log(`Analysis worker listening on "${ANALYSIS_QUEUE_NAME}"`);
  }

  /**
   * Build + publish a single progress event AND persist the same state onto
   * `AnalysisRun` so `GET /runs/:id` can hydrate the stepper on reload/remount
   * without waiting for the next pub/sub tick.
   *
   * Ordering: DB first (durable), Redis second (live). If the DB write throws
   * we still publish — the live UI still updates, and the row falls back to
   * a stale-but-eventually-correct state via the next emit.
   *
   * `progress` is monotonic via `GREATEST(existing, new)` so an out-of-order
   * or duplicated emit cannot pull the visible progress bar backwards.
   * `stage_started_at` resets on every stage transition (via `IS DISTINCT
   * FROM`) so per-stage elapsed timers are accurate even for stages that
   * never emit a `started` status.
   */
  private async emit(
    runId: string,
    stage: PipelineStage,
    status: StageStatus,
    message: string,
    progress: number,
  ): Promise<void> {
    const now = Date.now();

    // Track the FIRST time we heard about this stage — regardless of status —
    // so `completed` events (with no matching `started`) still yield a duration.
    const starts = this.stageStartTimes.get(runId) ?? new Map<PipelineStage, number>();
    if (!starts.has(stage)) starts.set(stage, now);
    this.stageStartTimes.set(runId, starts);

    if (status === "completed" || status === "failed") {
      const durations = this.stageDurations.get(runId) ?? {};
      const startedAt = starts.get(stage) ?? now;
      durations[stage] = Math.max(0, (now - startedAt) / 1000);
      this.stageDurations.set(runId, durations);
    }

    try {
      await this.prisma.$executeRaw`
        UPDATE "meetsy"."AnalysisRun"
        SET "current_stage" = ${stage},
            "progress" = GREATEST("progress", ${progress}::double precision),
            "stage_started_at" = CASE
              WHEN "current_stage" IS DISTINCT FROM ${stage} THEN ${new Date(now)}::timestamp
              ELSE "stage_started_at"
            END,
            "updatedAt" = NOW()
        WHERE "id" = ${runId}
      `;
    } catch (err) {
      this.logger.warn(
        `persistProgress skipped for run ${runId}: ${(err as Error).message}`,
      );
    }

    const event: ProgressEvent = {
      runId,
      stage,
      status,
      message,
      progress,
      at: now,
    };
    await this.queue.publishProgress(event);
  }

  /**
   * Before each stage, read the row and throw `CancelledRunError` if the user
   * has requested cancellation via `POST /runs/:id/cancel`. Cheap: one indexed
   * PK read per stage (7 total per run).
   */
  private async checkCancelled(runId: string): Promise<void> {
    const row = await this.prisma.analysisRun.findUnique({
      where: { id: runId },
      select: { cancelRequestedAt: true },
    });
    if (row?.cancelRequestedAt) {
      throw new CancelledRunError();
    }
  }

  /** Drop per-run stage-timing state on any terminal path. */
  private clearRunTiming(runId: string): void {
    this.stageStartTimes.delete(runId);
    this.stageDurations.delete(runId);
  }

  /**
   * Retrieve KB grounding context for the meeting (tasks + uploaded docs).
   * Best-effort: any failure (embeddings unconfigured, KB empty) returns [] so
   * the pipeline runs exactly as it did pre-2c.
   */
  private async retrieveKbContext(workspaceId: string, query: string): Promise<KbContextHit[]> {
    try {
      return await this.kbSearch.retrieveContext(workspaceId, query, {
        k: 8,
        sourceTypes: ["clickup_task", "document"],
      });
    } catch (err) {
      this.logger.warn(`KB context retrieval skipped: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * The workspace's assignable-member pool (from WorkspacePushConfig) — the
   * candidate set for Phase-3.1 assignment. Empty when push isn't configured (then
   * assignment is skipped). Read directly via Prisma to keep analysis → clickup
   * decoupled.
   */
  private async assignableMembers(workspaceId: string): Promise<AssignableMember[]> {
    const cfg = await this.prisma.workspacePushConfig.findUnique({
      where: { workspaceId },
      select: { assignableMembers: true },
    });
    return (cfg?.assignableMembers as unknown as AssignableMember[]) ?? [];
  }

  /**
   * Fire-and-forget incremental KB refresh for an ALREADY-onboarded workspace.
   * Never first-onboards from the analysis path; never blocks the pipeline.
   */
  private async maybeRefreshKb(workspaceId: string): Promise<void> {
    try {
      const state = await this.prisma.kbSyncState.findUnique({ where: { workspaceId } });
      if (!state || state.status === "onboarding") return; // not onboarded / already running
      await this.kbQueue.enqueue({ workspaceId, range: "3m" });
    } catch (err) {
      this.logger.warn(`KB refresh enqueue skipped: ${(err as Error).message}`);
    }
  }

  private async process(job: Job<AnalysisJobData>): Promise<void> {
    const { runId, meetingId } = job.data;

    const meeting = await this.prisma.meeting.findUnique({ where: { id: meetingId } });
    if (!meeting) {
      throw new Error(`Meeting ${meetingId} not found for run ${runId}`);
    }

    // Roster confirmed by the user at /meetings/:id/roster (Participant[]).
    const roster: Participant[] = ParticipantSchema.array().parse(meeting.roster ?? []);
    // Analyze the normalized (VTT-parsed) transcript when available.
    const transcript = meeting.normalizedTranscript ?? meeting.transcript;
    // Meeting date anchors relative due-date resolution in enrichment.
    const meetingDateISO = (meeting.meetingDate ?? meeting.createdAt)
      .toISOString()
      .slice(0, 10);
    const workspaceId = meeting.workspaceId;

    // Phase 2c.1 — fire-and-forget incremental KB remap so the workspace KB trends
    // fresh. Collision-safe (enqueue supersedes a finished job; see KbQueue). The
    // CURRENT run grounds against the already-embedded KB; the next is fresher.
    // Only for already-onboarded workspaces (never first-onboard from this path).
    await this.maybeRefreshKb(workspaceId);

    // Captured for the run result so the injected KB context is INSPECTABLE.
    let kbContext: KbContextHit[] = [];
    // Phase 2c.2 — weak field predictions + duplicate flags, attached per task id.
    let taskAnalysis: TaskAnalysis = { predictions: {}, duplicates: {}, neighboursByTask: {} };
    // Phase 3.1 — ranked, abstain-first owner recommendations per task id.
    let assignment: Record<string, TaskAssignment> = {};
    // Phase 3.2 — support-gated learning nudges per task id ("adjusted from N…").
    let adjustments: Record<string, TaskAdjustments> = {};

    // v2 Phase 5 — load the workspace's ML config ONCE up front so both the
    // runtime pipeline (dup bands into `fieldPrediction.analyze`) and the
    // AnalysisRunSnapshot writer at run completion use the same values. If the
    // read fails (row absent or DB blip), MlConfigService falls back to
    // hardcoded defaults — snapshot writer already tolerates that.
    const mlSnapshot = await this.mlConfig.forWorkspace(workspaceId);

    // Track the currently-executing stage so the failure branch below can
    // attribute the terminal event to the stage that actually died — NOT
    // hard-coded `"assemble"`, which would (via `emit()`'s `current_stage`
    // write + GREATEST(progress, 1)) paint every prior stage green and the
    // last one red regardless of where things blew up. Updated before each
    // stage's first emit.
    let activeStage: PipelineStage = "normalize";

    try {
      await this.prisma.analysisRun.update({
        where: { id: runId },
        data: { status: "running", startedAt: new Date() },
      });

      // Run the pipeline inside a usage context to capture LLM token spend.
      const { result, usage } = await runWithUsage(async () => {
        // Cancel is checked BEFORE each stage's first emit so the run
        // terminates promptly (worst case: mid-stage LLM call blocks until
        // the next boundary — acceptable, and matches how BullMQ semantics
        // handle cooperative cancel).

        // ── Stage 0: normalize (done at upload; emit for the UI stepper) ───
        activeStage = "normalize";
        await this.checkCancelled(runId);
        await this.emit(runId, "normalize", "completed", "Transcript normalized", 0.05);

        // ── Stages 1+2 merged: comprehend + extract in one pass ───────────
        activeStage = "comprehend";
        await this.checkCancelled(runId);
        await this.emit(runId, "comprehend", "started", "Analyzing meeting", 0.1);
        const analysis = await analyzeMeeting(this.azure, transcript, roster);
        await this.emit(
          runId,
          "comprehend",
          "completed",
          `Identified ${analysis.topics.length} topics, ${analysis.decisions.length} decisions`,
          0.4,
        );
        activeStage = "extract";
        await this.checkCancelled(runId);
        const extracted = analysis.tasks;
        await this.emit(runId, "extract", "completed", `Extracted ${extracted.length} candidate tasks`, 0.55);

        // ── Phase 2c.1: retrieve grounding context (KB history + docs) ─────
        // Keyed on the summary/topics/titles (concise, embeddable) — not the raw
        // transcript. Injected into critic + enrich below. Best-effort: a KB miss
        // or unconfigured embeddings leaves the pipeline exactly as pre-2c.
        kbContext = await this.retrieveKbContext(
          workspaceId,
          buildContextQuery(analysis.summary, analysis.topics, extracted.map((t) => t.title)),
        );
        const contextStr = formatContextForPrompt(kbContext);

        // ── Stage 5: critic (verify grounding/owners, dedup, completeness) ─
        activeStage = "critic";
        await this.checkCancelled(runId);
        await this.emit(runId, "critic", "started", "Verifying tasks", 0.6);
        const critiqued = await criticPass(this.azure, transcript, roster, extracted, contextStr);
        await this.emit(
          runId,
          "critic",
          "completed",
          `Verified ${critiqued.tasks.length} tasks (${critiqued.changes.length} corrections)`,
          0.75,
        );

        // ── Stage 4: enrich (ClickUp fields + absolute due dates) ──────────
        activeStage = "enrich";
        await this.checkCancelled(runId);
        await this.emit(runId, "enrich", "started", "Enriching task details", 0.78);
        const tasks = await enrichTasks(this.azure, critiqued.tasks, analysis.summary, meetingDateISO, contextStr);
        await this.emit(runId, "enrich", "completed", "Tasks enriched", 0.9);

        // ── Stage 3: assign (field-prediction + owner ranking + learning) ─
        // Best-effort: a KB miss / embeddings-unconfigured leaves predictions
        // empty but the stage still emits `completed` so the stepper does not
        // freeze on a permanently-pending row.
        activeStage = "assign";
        await this.checkCancelled(runId);
        await this.emit(runId, "assign", "started", "Ranking owners + fields", 0.91);
        try {
          taskAnalysis = await this.fieldPrediction.analyze(
            workspaceId,
            tasks,
            meetingDateISO,
            mlSnapshot.tunables,
          );
          // ── Phase 3.1: rank owner recommendations (reuses the kNN neighbours;
          // conditioned on the MEETING-LEVEL client set at upload to beat the
          // base-rate echo). ──
          const members = await this.assignableMembers(workspaceId);
          assignment = await this.assignment.rank(
            workspaceId,
            taskAnalysis.neighboursByTask,
            meeting.clientName,
            members,
          );
          // ── Phase 3.2: support-gated learning nudges from past corrections. ──
          adjustments = await this.learning.adjustForTasks(workspaceId, taskAnalysis.predictions);
          await this.emit(runId, "assign", "completed", "Owners ranked", 0.92);
        } catch (err) {
          this.logger.warn(`Field prediction / assignment / learning skipped: ${(err as Error).message}`);
          // Emit completed (not failed) — this is a best-effort side stage
          // whose absence must not turn the stepper red for the whole run.
          await this.emit(runId, "assign", "completed", "Assignment skipped (KB unavailable)", 0.92);
        }

        // ── Stage 6: assemble (pure) ──────────────────────────────────────
        activeStage = "assemble";
        await this.checkCancelled(runId);
        await this.emit(runId, "assemble", "started", "Assembling result", 0.93);
        const assembled = assemble(analysis.summary, roster, tasks);
        await this.emit(runId, "assemble", "completed", "Result assembled", 0.97);
        return assembled;
      });

      await this.prisma.analysisRun.update({
        where: { id: runId },
        data: {
          status: "completed",
          // Attach KB provenance (2c.1) + weak field predictions/dupe flags (2c.2)
          // + v2 Phase 2 top-5 kNN neighbours per task so the grounding is
          // inspectable on the run, keyed by task id.
          result: {
            ...(result as object),
            kbContext,
            fieldPredictions: taskAnalysis.predictions,
            duplicates: taskAnalysis.duplicates,
            assignment,
            adjustments,
            neighboursByTask: sliceNeighbours(taskAnalysis.neighboursByTask, 5),
          } as unknown as Prisma.InputJsonValue,
          error: null,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          llmCalls: usage.calls,
          finishedAt: new Date(),
          stageDurations: (this.stageDurations.get(runId) ??
            {}) as unknown as Prisma.InputJsonValue,
        },
      });
      this.logger.log(
        `Run ${runId} usage: ${usage.calls} LLM calls, ${usage.promptTokens} prompt + ${usage.completionTokens} completion tokens`,
      );

      // v2 Phase 0 — freeze the workspace's ML config on run completion so
      // Phase 5's preview replay can reproduce the run's parameters exactly.
      // Best-effort: a snapshot failure NEVER blocks run completion (the run
      // is already `completed` on the row above). We reuse `mlSnapshot` from
      // the top of `handle()` — the same values the pipeline consumed.
      try {
        await this.prisma.analysisRunSnapshot.create({
          data: {
            runId,
            workspaceId,
            tunables: mlSnapshot.tunables as unknown as Prisma.InputJsonValue,
            models: mlSnapshot.models as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        this.logger.warn(
          `AnalysisRunSnapshot write skipped for run ${runId}: ${(err as Error).message}`,
        );
      }

      await this.emit(runId, "assemble", "completed", "Analysis complete", 1);
      // Cross-page toast so a user who navigated away sees the completion.
      await this.runNotify.publish({
        workspaceId,
        runId,
        meetingTitle: meeting.title,
        kind: "completed",
      });
    } catch (err) {
      const isCancel = err instanceof CancelledRunError;
      const message = (err as Error).message ?? (isCancel ? "Cancelled by user" : "Unknown error");
      if (isCancel) {
        this.logger.log(`Run ${runId} cancelled by user`);
      } else {
        this.logger.error(`Run ${runId} failed: ${message}`);
      }
      await this.prisma.analysisRun.update({
        where: { id: runId },
        data: {
          status: isCancel ? "cancelled" : "failed",
          error: isCancel ? null : message,
          finishedAt: new Date(),
          stageDurations: (this.stageDurations.get(runId) ??
            {}) as unknown as Prisma.InputJsonValue,
        },
      });
      // Surface the terminal state on the live stream too. `StageStatus` has
      // no `cancelled` value (would be a breaking change to `ProgressEventSchema`);
      // we emit `failed` with a distinctive message. Clients read `RunStatus`
      // from `GET /runs/:id` for the authoritative distinction.
      //
      // Emit with `activeStage` (NOT hardcoded "assemble") so the stepper
      // paints the row where things actually died — the tracker above
      // updates activeStage before each stage's first emit. Progress = 0
      // because `emit()` uses `GREATEST(existing, incoming)` — this
      // preserves whatever the pipeline reached while making failure
      // status a pure signal (client checks `status === "failed"`, not
      // progress). Cancels also use activeStage so the stepper shows the
      // canceled row correctly.
      await this.emit(
        runId,
        activeStage,
        "failed",
        isCancel ? "Cancelled by user" : message,
        0,
      );
      await this.runNotify.publish({
        workspaceId,
        runId,
        meetingTitle: meeting.title,
        kind: isCancel ? "cancelled" : "failed",
        message: isCancel ? undefined : message,
      });
      // Cancel is a user action, not a job failure — don't rethrow so BullMQ
      // records it as completed (no retries, no dead-letter noise).
      if (!isCancel) throw err;
    } finally {
      this.clearRunTiming(runId);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}

/**
 * v2 Phase 2 — take the top-N per task from the kNN neighbours map. The source
 * arrays come from an `ORDER BY embedding <=> query` pgvector search
 * (`field-prediction.service.ts:139`) so they're already sorted DESC by cosine;
 * we just slice. Kept pure + local so it's trivially unit-testable.
 */
export function sliceNeighbours(
  byTask: Record<string, Neighbour[]>,
  n: number,
): Record<string, Neighbour[]> {
  const out: Record<string, Neighbour[]> = {};
  for (const [taskId, neighbours] of Object.entries(byTask)) {
    out[taskId] = neighbours.slice(0, n);
  }
  return out;
}
