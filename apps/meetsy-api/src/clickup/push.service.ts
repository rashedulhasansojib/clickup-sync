import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AnalysisResultSchema } from "@ma/shared";
import { PrismaService } from "../prisma/prisma.service";
import { TaskMapperService } from "./task-mapper.service";
import { PushConfigService } from "./push-config.service";
import { AssigneeResolverService } from "./assignee-resolver.service";
import { ClickUpClient } from "./clickup.client";
import { PushRunDto } from "./clickup.dto";

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
      });

      try {
        const created = await this.client.createTask(run.workspaceId, listId, payload);
        await this.upsert(runId, task.meetsyTaskId, run.workspaceId, pushedBy, payload, {
          status: "pushed",
          clickupTaskId: created.id,
          clickupUrl: created.url,
          error: null,
        });
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
}
