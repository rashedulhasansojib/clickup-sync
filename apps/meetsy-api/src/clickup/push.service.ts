import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AnalysisResultSchema } from "@ma/shared";
import { PrismaService } from "../prisma/prisma.service";
import { TaskMapperService } from "./task-mapper.service";
import { PushConfigService } from "./push-config.service";
import { AssigneeResolverService } from "./assignee-resolver.service";
import { ClickUpClient } from "./clickup.client";
import { PushRunDto } from "./clickup.dto";
import { LearningService, type LearningSnapshot } from "../kb/learning.service";
import type { PushConfigView } from "./push-config.service";

export interface PushResult {
  meetsyTaskId: string;
  status: "pushed" | "failed" | "skipped";
  clickupTaskId: string | null;
  clickupUrl: string | null;
  error: string | null;
}

export interface PushAuditRow {
  meetsyTaskId: string;
  status: "pushed" | "failed" | "skipped";
  clickupTaskId: string | null;
  clickupUrl: string | null;
  error: string | null;
  createdAt: string;
}

export interface AssigneeSuggestion {
  meetsyTaskId: string;
  assigneeName: string | null;
  suggestedClickupUserId: string | null;
}

/**
 * Pushes a run's (edited, human-confirmed) tasks into ClickUp, idempotently and
 * independently per task, recording every outcome in `meetsy.TaskPush`.
 * Workspace-scoped via the run's workspaceId.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: ClickUpClient,
    private readonly mapper: TaskMapperService,
    private readonly pushConfig: PushConfigService,
    private readonly resolver: AssigneeResolverService,
    private readonly learning: LearningService,
  ) {}

  /** GET /runs/:id/push — config + per-task audit + assignee suggestions. */
  async getStatus(orgId: string, runId: string): Promise<{
    config: Awaited<ReturnType<PushConfigService["get"]>>;
    pushes: PushAuditRow[];
    suggestions: AssigneeSuggestion[];
  }> {
    const run = await this.loadRun(orgId, runId);
    const config = await this.pushConfig.get(run.workspaceId);

    const pushes = await this.prisma.taskPush.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
    });

    const suggestions: AssigneeSuggestion[] = [];
    if (config && run.result) {
      const parsed = AnalysisResultSchema.safeParse(run.result);
      if (parsed.success) {
        const tasks = [
          ...parsed.data.people.flatMap((p) => p.tasks),
          ...parsed.data.unassignedTasks,
        ];
        for (const t of tasks) {
          suggestions.push({
            meetsyTaskId: t.id,
            assigneeName: t.assigneeName ?? null,
            suggestedClickupUserId: this.resolver.resolve(
              t.assigneeName,
              config.assignableMembers,
            ),
          });
        }
      }
    }

    return {
      config,
      pushes: pushes.map((p) => ({
        meetsyTaskId: p.meetsyTaskId,
        status: p.status,
        clickupTaskId: p.clickupTaskId,
        clickupUrl: p.clickupUrl,
        error: p.error,
        createdAt: p.createdAt.toISOString(),
      })),
      suggestions,
    };
  }

  /** POST /runs/:id/push — push the edited task set; idempotent per task. */
  async pushTasks(
    orgId: string,
    runId: string,
    body: PushRunDto,
    pushedBy: string,
  ): Promise<{ results: PushResult[] }> {
    const run = await this.loadRun(orgId, runId);
    const config = await this.pushConfig.get(run.workspaceId);
    if (!config) {
      throw new BadRequestException(
        "Push is not configured for this workspace. Set a target list first.",
      );
    }

    // Load existing pushes ONCE; a `pushed` row is the idempotency key.
    const existing = await this.prisma.taskPush.findMany({ where: { runId } });
    const byTask = new Map(existing.map((p) => [p.meetsyTaskId, p]));

    // Phase 2c.3 — the run's stored weak predictions, keyed by the SAME task id
    // (`t1..tM`) the push request carries as meetsyTaskId (assemble preserves it).
    const predictions =
      (run.result as { fieldPredictions?: Record<string, unknown> } | null)?.fieldPredictions ?? {};
    // Phase 3.2 — the learning snapshot (organic corrections only), computed ONCE
    // before the loop. Used to recompute the nudge the loop showed per task so the
    // FieldOverride records {shown, accepted} — the honest loop-effectiveness signal.
    const learningSnap = await this.learning.snapshot(run.workspaceId).catch(() => null);

    // Allowlist enforcement at the boundary: POST is directly callable (not only
    // via the UI), so any clickupUserId NOT in the workspace's assignable members
    // is dropped to unassigned — "anyone not in settings is never assigned" (§2).
    const allowed = new Set(config.assignableMembers.map((m) => m.clickupUserId));

    const results: PushResult[] = [];
    for (const task of body.tasks) {
      const prior = byTask.get(task.meetsyTaskId);

      // Idempotent skip: an already-`pushed` row is never re-created or
      // overwritten — return its existing link as a `skipped` result.
      if (prior && prior.status === "pushed") {
        results.push({
          meetsyTaskId: task.meetsyTaskId,
          status: "skipped",
          clickupTaskId: prior.clickupTaskId,
          clickupUrl: prior.clickupUrl,
          error: null,
        });
        continue;
      }

      const listId = task.listId ?? config.targetListId;
      const clickupUserId =
        task.clickupUserId && allowed.has(task.clickupUserId) ? task.clickupUserId : null;
      const payload = this.mapper.map(task, {
        clickupUserId,
        defaultStatus: config.defaultStatus,
        clientFieldId: config.clientFieldId,
      });

      try {
        const created = await this.client.createTask(run.workspaceId, listId, payload);
        await this.upsert(runId, task.meetsyTaskId, run.workspaceId, pushedBy, payload, {
          status: "pushed",
          clickupTaskId: created.id,
          clickupUrl: created.url,
          error: null,
        });
        // Phase 2c.3 — log the human's accept/override of the weak prediction (the
        // Phase-3 learning signal). predicted comes from the STORED run result
        // (server-authoritative); skip on an id-miss so the table is never
        // null-poisoned. confirmed = what the user actually pushed.
        const predicted = predictions[task.meetsyTaskId];
        await this.logFieldOverride(
          runId,
          task,
          run.workspaceId,
          predicted,
          { listId, clientOptionId: task.clientOptionId ?? null, points: task.points ?? null, clickupUserId },
          this.computeAdjustments(learningSnap, predicted, task, clickupUserId, config),
        );
        results.push({
          meetsyTaskId: task.meetsyTaskId,
          status: "pushed",
          clickupTaskId: created.id,
          clickupUrl: created.url,
          error: null,
        });
      } catch (err) {
        const message = (err as Error).message ?? "ClickUp create failed";
        this.logger.warn(`Push failed for task ${task.meetsyTaskId} (run ${runId}): ${message}`);
        await this.upsert(runId, task.meetsyTaskId, run.workspaceId, pushedBy, payload, {
          status: "failed",
          clickupTaskId: null,
          clickupUrl: null,
          error: message,
        });
        results.push({
          meetsyTaskId: task.meetsyTaskId,
          status: "failed",
          clickupTaskId: null,
          clickupUrl: null,
          error: message,
        });
      }
    }

    return { results };
  }

  private async loadRun(orgId: string, runId: string) {
    const run = await this.prisma.analysisRun.findUnique({ where: { id: runId } });
    if (!run || run.orgId !== orgId) {
      throw new NotFoundException(`Run ${runId} not found`);
    }
    return run;
  }

  private upsert(
    runId: string,
    meetsyTaskId: string,
    workspaceId: string,
    pushedBy: string,
    payload: unknown,
    outcome: {
      status: "pushed" | "failed";
      clickupTaskId: string | null;
      clickupUrl: string | null;
      error: string | null;
    },
  ) {
    const data = {
      workspaceId,
      pushedBy,
      payload: payload as Prisma.InputJsonValue,
      status: outcome.status,
      clickupTaskId: outcome.clickupTaskId,
      clickupUrl: outcome.clickupUrl,
      error: outcome.error,
    };
    return this.prisma.taskPush.upsert({
      where: { runId_meetsyTaskId: { runId, meetsyTaskId } },
      create: { runId, meetsyTaskId, ...data },
      update: data,
    });
  }

  /**
   * Append a FieldOverride row capturing predicted-vs-confirmed for a pushed task
   * (the Phase-3 learning signal; not read yet). `predicted` is the run's stored
   * 2c.2 prediction bundle for this task; when it's MISSING (an id-miss, never an
   * abstain — an abstain is a real, defined prediction) we SKIP rather than write a
   * null-poisoned row. Best-effort: a logging failure never blocks the push.
   */
  private async logFieldOverride(
    runId: string,
    task: { meetsyTaskId: string },
    workspaceId: string,
    predicted: unknown,
    confirmed: { listId: string; clientOptionId: string | null; points: number | null; clickupUserId: string | null },
    adjustments: Record<string, { shown: string; accepted: boolean }> | null,
  ): Promise<void> {
    if (predicted === undefined || predicted === null) return; // id-miss → don't poison the table
    try {
      await this.prisma.fieldOverride.create({
        data: {
          runId,
          meetsyTaskId: task.meetsyTaskId,
          workspaceId,
          predicted: predicted as Prisma.InputJsonValue,
          confirmed: confirmed as unknown as Prisma.InputJsonValue,
          adjustments: (adjustments && Object.keys(adjustments).length > 0
            ? (adjustments as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull),
        },
      });
    } catch (err) {
      this.logger.warn(`FieldOverride log failed for ${task.meetsyTaskId}: ${(err as Error).message}`);
    }
  }

  /**
   * Phase 3.2 — recompute the nudge the learning loop showed for this task (from
   * the pre-push snapshot) and record {shown, accepted} per field. This is what
   * makes loop-effectiveness measurable (vs the raw override rate) AND lets the
   * gate count only organic (no-nudge) corrections. `accepted` = the user's
   * confirmed value (resolved id → name) equals the nudge's suggestion.
   */
  private computeAdjustments(
    snap: LearningSnapshot | null,
    predicted: unknown,
    task: { clientOptionId?: string | null },
    confirmedClickupUserId: string | null,
    config: PushConfigView,
  ): Record<string, { shown: string; accepted: boolean }> | null {
    if (!snap || predicted == null) return null;
    const nudges = this.learning.applyNudges(snap, predicted as Parameters<LearningService["applyNudges"]>[1]);
    const out: Record<string, { shown: string; accepted: boolean }> = {};
    if (nudges.client) {
      const confirmedName = config.clientOptions.find((o) => o.optionId === task.clientOptionId)?.name ?? null;
      out.client = { shown: nudges.client.to, accepted: confirmedName === nudges.client.to };
    }
    if (nudges.assignee) {
      const confirmedName = config.assignableMembers.find((m) => m.clickupUserId === confirmedClickupUserId)?.name ?? null;
      out.assignee = { shown: nudges.assignee.to, accepted: confirmedName === nudges.assignee.to };
    }
    return out;
  }
}
