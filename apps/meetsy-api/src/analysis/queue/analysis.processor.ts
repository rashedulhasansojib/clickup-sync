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
import type { Neighbour } from "../../kb/prediction-prior";
import type { AssignableMember } from "../../clickup/clickup.types";
import { buildContextQuery, formatContextForPrompt } from "../pipeline-context";

/**
 * BullMQ Worker that runs IN THE SAME Nest process (started in onModuleInit).
 *
 * For each job it runs comprehend → extract → assemble, persisting status +
 * result to AnalysisRun and publishing a ProgressEvent before/after each stage
 * (per @ma/shared ProgressEventSchema) so the SSE endpoint can stream progress.
 *
 * TODO(phase2): insert stage3-assign, stage4-enrich, stage5-critic between
 * extract and assemble, and re-weight the progress milestones accordingly.
 */
@Injectable()
export class AnalysisProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalysisProcessor.name);
  private worker!: Worker<AnalysisJobData>;

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

  /** Build + publish a single progress event. */
  private async emit(
    runId: string,
    stage: PipelineStage,
    status: StageStatus,
    message: string,
    progress: number,
  ): Promise<void> {
    const event: ProgressEvent = {
      runId,
      stage,
      status,
      message,
      progress,
      at: Date.now(),
    };
    await this.queue.publishProgress(event);
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

    try {
      await this.prisma.analysisRun.update({
        where: { id: runId },
        data: { status: "running" },
      });

      // Run the pipeline inside a usage context to capture LLM token spend.
      const { result, usage } = await runWithUsage(async () => {
        // ── Stage 0: normalize (done at upload; emit for the UI stepper) ───
        await this.emit(runId, "normalize", "completed", "Transcript normalized", 0.05);

        // ── Stages 1+2 merged: comprehend + extract in one pass ───────────
        await this.emit(runId, "comprehend", "started", "Analyzing meeting", 0.1);
        const analysis = await analyzeMeeting(this.azure, transcript, roster);
        await this.emit(
          runId,
          "comprehend",
          "completed",
          `Identified ${analysis.topics.length} topics, ${analysis.decisions.length} decisions`,
          0.4,
        );
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
        await this.emit(runId, "enrich", "started", "Enriching task details", 0.78);
        const tasks = await enrichTasks(this.azure, critiqued.tasks, analysis.summary, meetingDateISO, contextStr);
        await this.emit(runId, "enrich", "completed", "Tasks enriched", 0.9);

        // ── Phase 2c.2: weak field predictions + duplicate flags ───────────
        // Best-effort: a KB miss / embeddings-unconfigured leaves predictions empty.
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
        } catch (err) {
          this.logger.warn(`Field prediction / assignment / learning skipped: ${(err as Error).message}`);
        }

        // ── Stage 6: assemble (pure) ──────────────────────────────────────
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
    } catch (err) {
      const message = (err as Error).message ?? "Unknown error";
      this.logger.error(`Run ${runId} failed: ${message}`);
      await this.prisma.analysisRun.update({
        where: { id: runId },
        data: { status: "failed", error: message },
      });
      // Surface the failure on the live stream too.
      await this.emit(runId, "assemble", "failed", message, 1);
      throw err; // let BullMQ record the job as failed
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
