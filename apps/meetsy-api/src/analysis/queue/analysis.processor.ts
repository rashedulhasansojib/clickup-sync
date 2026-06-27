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

        // ── Stage 5: critic (verify grounding/owners, dedup, completeness) ─
        await this.emit(runId, "critic", "started", "Verifying tasks", 0.6);
        const critiqued = await criticPass(this.azure, transcript, roster, extracted);
        await this.emit(
          runId,
          "critic",
          "completed",
          `Verified ${critiqued.tasks.length} tasks (${critiqued.changes.length} corrections)`,
          0.75,
        );

        // ── Stage 4: enrich (ClickUp fields + absolute due dates) ──────────
        await this.emit(runId, "enrich", "started", "Enriching task details", 0.78);
        const tasks = await enrichTasks(this.azure, critiqued.tasks, analysis.summary, meetingDateISO);
        await this.emit(runId, "enrich", "completed", "Tasks enriched", 0.9);

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
          result: result as unknown as Prisma.InputJsonValue,
          error: null,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          llmCalls: usage.calls,
        },
      });
      this.logger.log(
        `Run ${runId} usage: ${usage.calls} LLM calls, ${usage.promptTokens} prompt + ${usage.completionTokens} completion tokens`,
      );
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
