import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Task } from "@ma/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AzureEmbeddingService } from "../azure/azure-embedding.service";
import { AzureOpenAIService } from "../azure/azure-openai.service";
import { buildTaskCard } from "./card-builder";
import { toVectorLiteral } from "./kb.processor";
import {
  aggregatePrior,
  cycleDaysPercentile,
  firstAssignee,
  qualifying,
  addDays,
  MIN_QUALIFYING,
  type Neighbour,
  type PriorCandidate,
} from "./prediction-prior";
import { classifyDuplicates, type DuplicateHit } from "./duplicate-bands";

/**
 * Phase 2c.2 — weak, abstain-first field prediction + duplicate flags for each
 * extracted task, grounded in the workspace's task history.
 *
 * Per task: build a CARD-SHAPED query (so cosines are comparable to the stored
 * card embeddings), kNN over `clickup_task` chunks, keep only neighbours above a
 * cosine FLOOR, and:
 *  - predict client / sprint / assignee via a similarity-weighted modal prior
 *    that the LLM may CLAMP to (pick among the observed candidates, or abstain).
 *    The LLM is the echo-breaker — it lets the task text pull a MINORITY client
 *    instead of arg-maxing the corpus base rate — but confidence (support/share)
 *    always rides on the DISTRIBUTION, never the model's self-assertion.
 *  - predict due from p80 cycle-time of closed neighbours (p50 ≈ "due today" here).
 *  - flag likely duplicates (cosine ≥ 0.90) / suggest related (≥ 0.82).
 * Abstains on thin history (fewer than MIN_QUALIFYING neighbours clear the floor).
 */
export interface FieldPrediction {
  value: string | null;
  abstain: boolean;
  support: number;
  /** The picked value's true similarity-weighted share (NOT zeroed for minority picks). */
  share: number;
  /** Whether the picked value is the statistical mode (false ⇒ the LLM clamp chose a minority). */
  isModal: boolean;
  confidence: "high" | "low";
  candidates: PriorCandidate[];
  reason?: string;
}

export interface DuePrediction {
  date: string | null; // YYYY-MM-DD
  abstain: boolean;
  basedOnClosedTasks: number;
  cycleDaysP80: number | null;
}

export interface TaskPrediction {
  client: FieldPrediction;
  sprint: FieldPrediction;
  assigneeHint: FieldPrediction; // soft hint only; confident assignment is Phase 3
  estimate: FieldPrediction;
  due: DuePrediction;
  qualifyingNeighbours: number;
}

export interface TaskAnalysis {
  predictions: Record<string, TaskPrediction>;
  duplicates: Record<string, DuplicateHit[]>;
  /** Phase 3.1 — the per-task kNN neighbours (internal; reused by AssignmentService
   * to rank owners WITHOUT re-embedding). Not attached to the run result. */
  neighboursByTask: Record<string, Neighbour[]>;
}

const K = 15;
const CLAMP_DEPLOYMENT = "gpt-5.4-mini";

const ClampSchema = z.object({
  client: z.object({ value: z.string().nullable(), reason: z.string() }),
  sprint: z.object({ value: z.string().nullable(), reason: z.string() }),
  assignee: z.object({ value: z.string().nullable(), reason: z.string() }),
});

@Injectable()
export class FieldPredictionService {
  private readonly logger = new Logger(FieldPredictionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embed: AzureEmbeddingService,
    private readonly chat: AzureOpenAIService,
  ) {}

  /** Predict fields + duplicate flags for a run's tasks. Best-effort: any failure
   * leaves a task without predictions (the pipeline result is otherwise unchanged). */
  async analyze(workspaceId: string, tasks: Task[], meetingDateISO: string): Promise<TaskAnalysis> {
    const predictions: Record<string, TaskPrediction> = {};
    const duplicates: Record<string, DuplicateHit[]> = {};
    const neighboursByTask: Record<string, Neighbour[]> = {};
    for (const task of tasks) {
      try {
        const { neighbours, raw } = await this.neighbours(workspaceId, task);
        neighboursByTask[task.id] = neighbours;
        duplicates[task.id] = classifyDuplicates(raw);
        predictions[task.id] = await this.predictForTask(task, neighbours, meetingDateISO);
      } catch (err) {
        this.logger.warn(`Prediction skipped for task ${task.id}: ${(err as Error).message}`);
      }
    }
    return { predictions, duplicates, neighboursByTask };
  }

  /** Card-shaped kNN: returns neighbours enriched with task fields + the raw sims. */
  private async neighbours(
    workspaceId: string,
    task: Task,
  ): Promise<{ neighbours: Neighbour[]; raw: Array<{ taskId: string; sim: number }> }> {
    const card = buildTaskCard({
      taskId: task.id,
      taskName: task.title,
      description: task.description,
      priority: task.priority,
      assigneesNames: task.assigneeName ?? null,
      tags: task.tags?.length ? task.tags.join(", ") : null,
    });
    const [vec] = await this.embed.embed(card.content, { dimensions: 1024 });
    const vecLit = toVectorLiteral(vec);

    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      return tx.$queryRaw<Array<{ sourceId: string; sim: number }>>(Prisma.sql`
        SELECT "sourceId", 1 - ("embedding" OPERATOR(public.<=>) ${vecLit}::public.vector) AS sim
        FROM "meetsy"."KbChunk"
        WHERE "workspaceId" = ${workspaceId}
          AND "sourceType" = 'clickup_task'::"meetsy"."KbSourceType"
          AND "embedding" IS NOT NULL
        ORDER BY "embedding" OPERATOR(public.<=>) ${vecLit}::public.vector
        LIMIT ${K}
      `);
    });
    const raw = rows.map((r) => ({ taskId: r.sourceId, sim: Number(r.sim) }));

    // Enrich with authoritative task fields for the priors.
    const ids = raw.map((r) => r.taskId);
    const tasksById = new Map(
      (
        await this.prisma.clickupTask.findMany({
          where: { workspaceId, taskId: { in: ids } },
          select: {
            taskId: true, client: true, sprintName: true, listName: true,
            assigneesNames: true, estimation: true, createdDate: true, closedDate: true,
          },
        })
      ).map((t) => [t.taskId, t]),
    );
    const neighbours: Neighbour[] = raw.map((r) => {
      const t = tasksById.get(r.taskId);
      return {
        taskId: r.taskId,
        sim: r.sim,
        client: t?.client ?? null,
        sprint: t?.sprintName ?? t?.listName ?? null,
        assignee: firstAssignee(t?.assigneesNames ?? null),
        // `estimation` is a numeric column; stringify for the modal aggregator.
        estimation: t?.estimation != null ? t.estimation.toString() : null,
        createdDate: t?.createdDate ?? null,
        closedDate: t?.closedDate ?? null,
      };
    });
    return { neighbours, raw };
  }

  private async predictForTask(task: Task, neighbours: Neighbour[], meetingDateISO: string): Promise<TaskPrediction> {
    const quali = qualifying(neighbours);
    const thin = quali.length < MIN_QUALIFYING;

    const clientPrior = aggregatePrior(quali, (n) => n.client);
    const sprintPrior = aggregatePrior(quali, (n) => n.sprint);
    const assigneePrior = aggregatePrior(quali, (n) => n.assignee);
    // Many tasks carry estimation 0 — a "0" estimate suggestion is meaningless,
    // so drop zero/blank before the modal (abstains when no real estimate exists).
    const estimatePrior = aggregatePrior(quali, (n) => {
      const v = n.estimation;
      return v && Number(v) > 0 ? v : null;
    });

    // LLM clamp (echo-breaker) for client/sprint/assignee — picks among the
    // observed candidates using the task text, or abstains. Skipped when thin.
    let clamp: z.infer<typeof ClampSchema> | null = null;
    if (!thin && (clientPrior || sprintPrior || assigneePrior)) {
      clamp = await this.clamp(task, clientPrior?.candidates ?? [], sprintPrior?.candidates ?? [], assigneePrior?.candidates ?? []);
    }

    const dueDays = thin ? null : cycleDaysPercentile(quali, 0.8);
    const due: DuePrediction = {
      date: dueDays != null ? addDays(new Date(`${meetingDateISO}T00:00:00Z`), dueDays).toISOString().slice(0, 10) : null,
      abstain: dueDays == null,
      basedOnClosedTasks: quali.filter((n) => n.createdDate && n.closedDate).length,
      cycleDaysP80: dueDays,
    };

    return {
      client: this.field(thin, clientPrior, clamp?.client),
      sprint: this.field(thin, sprintPrior, clamp?.sprint),
      assigneeHint: this.field(thin, assigneePrior, clamp?.assignee),
      estimate: this.field(thin, estimatePrior, undefined), // statistical only (no LLM)
      due,
      qualifyingNeighbours: quali.length,
    };
  }

  /**
   * Resolve one field's prediction. Abstains on thin history / no prior / LLM
   * abstain. When the LLM picks a valid candidate it OVERRIDES the modal top
   * (the echo-breaker) but support/share stay tied to that value's DISTRIBUTION.
   */
  private field(
    thin: boolean,
    prior: ReturnType<typeof aggregatePrior>,
    clamp: { value: string | null; reason: string } | undefined,
  ): FieldPrediction {
    if (thin || !prior) {
      return { value: null, abstain: true, support: 0, share: 0, isModal: false, confidence: "low", candidates: prior?.candidates ?? [] };
    }
    // LLM provided (client/sprint/assignee): honour its pick/abstain when valid.
    let value = prior.top;
    let reason: string | undefined;
    if (clamp !== undefined) {
      if (clamp.value === null) {
        return { value: null, abstain: true, support: 0, share: 0, isModal: false, confidence: "low", candidates: prior.candidates, reason: clamp.reason };
      }
      const match = prior.candidates.find((c) => c.value === clamp.value);
      if (match) {
        value = match.value;
        reason = clamp.reason;
      }
    }
    // support + share come from the PICKED value's true distribution (a minority
    // pick keeps its real share — never zeroed; 2c.3 FieldOverride logs this).
    const picked = prior.candidates.find((c) => c.value === value);
    const support = picked?.support ?? prior.support;
    const share = picked?.share ?? prior.share;
    const isModal = value === prior.top;
    const confidence: "high" | "low" = isModal && share >= 0.5 && support >= MIN_QUALIFYING ? "high" : "low";
    return { value, abstain: false, support, share, isModal, confidence, candidates: prior.candidates, reason };
  }

  private async clamp(
    task: Task,
    clientCands: PriorCandidate[],
    sprintCands: PriorCandidate[],
    assigneeCands: PriorCandidate[],
  ): Promise<z.infer<typeof ClampSchema> | null> {
    try {
      const list = (cs: PriorCandidate[]) => (cs.length ? cs.map((c) => `"${c.value}" (${c.support})`).join(", ") : "(none)");
      return await this.chat.structured({
        system:
          "You assign fields to a new task using ONLY the candidate values observed in similar past tasks. " +
          "For each field pick the candidate that best fits the task's title/description, or null if none clearly fits. " +
          "You MUST pick a value from the given candidates or null — never invent a value. Prefer the task's own wording " +
          "(e.g. a client named in the title) over the most common candidate.",
        user: [
          `Task title: ${task.title}`,
          `Task description: ${task.description ?? ""}`,
          ``,
          `client candidates: ${list(clientCands)}`,
          `sprint candidates: ${list(sprintCands)}`,
          `assignee candidates: ${list(assigneeCands)}`,
        ].join("\n"),
        schema: ClampSchema,
        schemaName: "field_clamp",
        deployment: CLAMP_DEPLOYMENT,
        reasoningEffort: "low",
      });
    } catch (err) {
      this.logger.warn(`Field clamp LLM failed; falling back to statistical prior: ${(err as Error).message}`);
      return null;
    }
  }
}
