import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type {
  Blockers,
  BlockerGroup,
  Categories,
  CategoryBucket,
  ComponentEntry,
  Coverage,
  KbFacts,
  RosterEntry,
  Throughput,
  WorkloadEntry,
} from "./summary.types";
import {
  buildThroughputWeeks,
  parseAssignees,
  primaryComponent,
  topCounts,
} from "./summary.util";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Windows (spec defaults; could be made configurable later). */
const THROUGHPUT_WEEKS = 12;
const WORKLOAD_DAYS = 30;
const STALE_DAYS = 30;
const SAMPLE_LIMIT = 5;

/** Raw-row shapes ($queryRaw returns count(*) as BigInt, sums as Decimal/string). */
interface CountRow {
  label: string | null;
  count: bigint | number;
}
interface ComponentCountRow {
  component: string | null;
  count: bigint | number;
}
interface WeekCountRow {
  week: string;
  count: bigint | number;
}
interface MedianRow {
  median: Prisma.Decimal | number | string | null;
}
interface WorkloadRow {
  user: string | null;
  hours: Prisma.Decimal | number | string | null;
}
interface ReopenedRow {
  taskId: string;
  count: bigint | number;
}

/**
 * Computes the exact, SQL-derived `KbFacts` for a workspace — NO LLM, no Azure
 * dependency (that isolation is what makes the facts honest + cheap). Each fact is
 * a small, separately-tested method. Group-bys use `$queryRaw` (the raw SQL is
 * live-verified by the orchestrator on real Nifty data; the pure mapping/coercion
 * over the returned rows is unit-tested with BigInt/Decimal fixtures). Everything
 * is scoped `workspace_id = $1 AND is_deleted = false` over the read-only mirror.
 *
 * All counts are coerced with Number() and all dates emitted as strings so the
 * resulting object is JSON-native (it is stringify'd into the prompt, persisted as
 * Prisma Json, and returned over HTTP).
 */
@Injectable()
export class SummaryFactsService {
  private readonly logger = new Logger(SummaryFactsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Compute the full fact set. `now` is injectable for deterministic windows. */
  async computeFacts(workspaceId: string, now: Date = new Date()): Promise<KbFacts> {
    const [roster, components, throughput, categories, workload, blockers, coverage] =
      await Promise.all([
        this.roster(workspaceId),
        this.components(workspaceId),
        this.throughput(workspaceId, now),
        this.categories(workspaceId),
        this.workload(workspaceId, now),
        this.blockers(workspaceId, now),
        this.coverage(workspaceId),
      ]);
    return { roster, components, throughput, categories, workload, blockers, coverage };
  }

  /** Embedded chunk count — shared by `coverage` + the cache staleness gate. */
  async embeddedCount(workspaceId: string): Promise<number> {
    return this.prisma.kbChunk.count({
      where: { workspaceId, sourceType: "clickup_task" },
    });
  }

  // ── Roster + ownership (TS aggregation: defensive assignee parsing) ─────────
  async roster(workspaceId: string): Promise<RosterEntry[]> {
    const tasks = await this.prisma.clickupTask.findMany({
      where: { workspaceId, isDeleted: false },
      select: {
        assigneesNames: true,
        assigneesEmails: true,
        listName: true,
        folderName: true,
        tags: true,
        closedDate: true,
      },
    });

    interface Acc {
      name: string;
      email: string | null;
      taskCount: number;
      openCount: number;
      closedCount: number;
      components: Map<string, number>;
    }
    const byKey = new Map<string, Acc>();

    for (const t of tasks) {
      const assignees = parseAssignees(t.assigneesNames, t.assigneesEmails);
      if (assignees.length === 0) continue;
      const closed = t.closedDate != null;
      const comp = primaryComponent(t);
      for (const a of assignees) {
        let acc = byKey.get(a.key);
        if (!acc) {
          acc = {
            name: a.name,
            email: a.email,
            taskCount: 0,
            openCount: 0,
            closedCount: 0,
            components: new Map(),
          };
          byKey.set(a.key, acc);
        }
        if (!acc.email && a.email) acc.email = a.email;
        acc.taskCount += 1;
        if (closed) acc.closedCount += 1;
        else acc.openCount += 1;
        if (comp) acc.components.set(comp, (acc.components.get(comp) ?? 0) + 1);
      }
    }

    return [...byKey.values()]
      .map((a) => ({
        name: a.name,
        email: a.email,
        taskCount: a.taskCount,
        openCount: a.openCount,
        closedCount: a.closedCount,
        topComponents: topCounts(a.components, 3),
      }))
      .sort((x, y) => y.taskCount - x.taskCount || x.name.localeCompare(y.name));
  }

  // ── Components/areas (top 10 by volume; list → folder → first tag) ──────────
  async components(workspaceId: string): Promise<ComponentEntry[]> {
    const rows = await this.prisma.$queryRaw<ComponentCountRow[]>(Prisma.sql`
      SELECT coalesce(
               nullif(trim("list_name"), ''),
               nullif(trim("folder_name"), ''),
               nullif(trim(split_part("tags", ',', 1)), '')
             ) AS "component",
             count(*) AS "count"
      FROM "public"."clickup_tasks"
      WHERE "workspace_id" = ${workspaceId} AND "is_deleted" = false
      GROUP BY 1
      HAVING coalesce(
               nullif(trim("list_name"), ''),
               nullif(trim("folder_name"), ''),
               nullif(trim(split_part("tags", ',', 1)), '')
             ) IS NOT NULL
      ORDER BY count(*) DESC, 1 ASC
      LIMIT 10
    `);
    return rows.map((r) => ({ component: r.component ?? "(none)", taskCount: Number(r.count) }));
  }

  // ── Throughput (created vs closed / ISO week; totals; median cycle time) ────
  async throughput(workspaceId: string, now: Date): Promise<Throughput> {
    const since = new Date(now.getTime() - THROUGHPUT_WEEKS * 7 * DAY_MS);
    const [createdRows, closedRows, openTotal, closedTotal, medianRows] = await Promise.all([
      this.prisma.$queryRaw<WeekCountRow[]>(Prisma.sql`
        SELECT to_char(date_trunc('week', "created_date"), 'YYYY-MM-DD') AS "week",
               count(*) AS "count"
        FROM "public"."clickup_tasks"
        WHERE "workspace_id" = ${workspaceId} AND "is_deleted" = false
          AND "created_date" >= ${since}
        GROUP BY 1
      `),
      this.prisma.$queryRaw<WeekCountRow[]>(Prisma.sql`
        SELECT to_char(date_trunc('week', "closed_date"), 'YYYY-MM-DD') AS "week",
               count(*) AS "count"
        FROM "public"."clickup_tasks"
        WHERE "workspace_id" = ${workspaceId} AND "is_deleted" = false
          AND "closed_date" >= ${since}
        GROUP BY 1
      `),
      this.prisma.clickupTask.count({
        where: { workspaceId, isDeleted: false, closedDate: null },
      }),
      this.prisma.clickupTask.count({
        where: { workspaceId, isDeleted: false, closedDate: { not: null } },
      }),
      this.prisma.$queryRaw<MedianRow[]>(Prisma.sql`
        SELECT percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM ("closed_date" - "created_date")) / 86400.0
               ) AS "median"
        FROM "public"."clickup_tasks"
        WHERE "workspace_id" = ${workspaceId} AND "is_deleted" = false
          AND "closed_date" IS NOT NULL AND "created_date" IS NOT NULL
      `),
    ]);

    const toWeek = (rows: WeekCountRow[]) =>
      rows.map((r) => ({ week: r.week, count: Number(r.count) }));
    const rawMedian = medianRows[0]?.median;
    const medianCycleTimeDays =
      rawMedian == null ? null : Math.round(Number(rawMedian) * 100) / 100;

    return {
      weeks: buildThroughputWeeks(toWeek(createdRows), toWeek(closedRows), now, THROUGHPUT_WEEKS),
      openTotal,
      closedTotal,
      medianCycleTimeDays,
    };
  }

  // ── Recurring categories (status / tags / client / dept / sprint) ──────────
  async categories(workspaceId: string): Promise<Categories> {
    const [statusDistribution, topTags, clients, departments, sprints] = await Promise.all([
      this.groupByColumn(workspaceId, "status", 20),
      this.topTags(workspaceId),
      this.groupByColumn(workspaceId, "client", 10),
      this.groupByColumn(workspaceId, "department", 10),
      this.groupByColumn(workspaceId, "sprint_name", 10),
    ]);
    return { statusDistribution, topTags, clients, departments, sprints };
  }

  /** Generic single-column group-by over the task mirror (column is a literal). */
  private async groupByColumn(
    workspaceId: string,
    column: "status" | "client" | "department" | "sprint_name",
    limit: number,
  ): Promise<CategoryBucket[]> {
    // `column` is a fixed internal literal (never user input) → safe to inject raw.
    const col = Prisma.raw(`"${column}"`);
    const rows = await this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT trim(${col}) AS "label", count(*) AS "count"
      FROM "public"."clickup_tasks"
      WHERE "workspace_id" = ${workspaceId} AND "is_deleted" = false
        AND ${col} IS NOT NULL AND trim(${col}) <> ''
      GROUP BY 1
      ORDER BY count(*) DESC, 1 ASC
      LIMIT ${limit}
    `);
    return rows.map((r) => ({ label: r.label ?? "(none)", count: Number(r.count) }));
  }

  /** Top tags — split the comma-joined `tags` column and count each. */
  private async topTags(workspaceId: string): Promise<CategoryBucket[]> {
    const rows = await this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT trim(t) AS "label", count(*) AS "count"
      FROM "public"."clickup_tasks", unnest(string_to_array("tags", ',')) AS t
      WHERE "workspace_id" = ${workspaceId} AND "is_deleted" = false
        AND "tags" IS NOT NULL AND trim(t) <> ''
      GROUP BY 1
      ORDER BY count(*) DESC, 1 ASC
      LIMIT 15
    `);
    return rows.map((r) => ({ label: r.label ?? "", count: Number(r.count) }));
  }

  // ── Workload (tracked hours per user, last 30 days) ────────────────────────
  async workload(workspaceId: string, now: Date): Promise<WorkloadEntry[]> {
    const since = new Date(now.getTime() - WORKLOAD_DAYS * DAY_MS);
    const rows = await this.prisma.$queryRaw<WorkloadRow[]>(Prisma.sql`
      SELECT coalesce(nullif(trim("user_name"), ''), nullif(trim("user_email"), ''), "user_id") AS "user",
             sum("duration_hours") AS "hours"
      FROM "public"."clickup_time_entries"
      WHERE "workspace_id" = ${workspaceId} AND "start_time" >= ${since}
      GROUP BY 1
      HAVING coalesce(nullif(trim("user_name"), ''), nullif(trim("user_email"), ''), "user_id") IS NOT NULL
      ORDER BY sum("duration_hours") DESC, 1 ASC
      LIMIT 20
    `);
    return rows.map((r) => ({
      user: r.user ?? "(unknown)",
      hours: Math.round(Number(r.hours ?? 0) * 100) / 100,
    }));
  }

  // ── Blockers (overdue-open, stale, reopened) ───────────────────────────────
  async blockers(workspaceId: string, now: Date): Promise<Blockers> {
    const staleCutoff = new Date(now.getTime() - STALE_DAYS * DAY_MS);
    const [overdueOpen, stale, reopened] = await Promise.all([
      this.blockerGroup({ workspaceId, isDeleted: false, closedDate: null, dueDate: { lt: now } }),
      this.blockerGroup({
        workspaceId,
        isDeleted: false,
        closedDate: null,
        updatedDate: { lt: staleCutoff },
      }),
      this.reopened(workspaceId),
    ]);
    return { overdueOpen, stale, reopened };
  }

  /** count + a few sample {taskId, taskName} for a task-filter blocker group. */
  private async blockerGroup(where: Prisma.ClickupTaskWhereInput): Promise<BlockerGroup> {
    const [count, samples] = await Promise.all([
      this.prisma.clickupTask.count({ where }),
      this.prisma.clickupTask.findMany({
        where,
        select: { taskId: true, taskName: true },
        orderBy: { updatedDate: "asc" },
        take: SAMPLE_LIMIT,
      }),
    ]);
    return { count, samples };
  }

  /**
   * Reopened = closed→open status transitions in `clickup_task_events`. The
   * before/after JSON shape is Clicksy-defined; this reads `status_type`. Degrades
   * to {count:0, samples:[]} (no throw) when events are thin or the shape differs —
   * the spec accepts a graceful 0 here.
   */
  private async reopened(workspaceId: string): Promise<BlockerGroup> {
    try {
      const rows = await this.prisma.$queryRaw<ReopenedRow[]>(Prisma.sql`
        SELECT "task_id" AS "taskId", count(*) AS "count"
        FROM "public"."clickup_task_events"
        WHERE "workspace_id" = ${workspaceId}
          AND "event_type" = 'taskStatusUpdated'
          AND ("before" ->> 'status_type') IN ('closed', 'done')
          AND coalesce("after" ->> 'status_type', '') NOT IN ('closed', 'done')
        GROUP BY "task_id"
        ORDER BY count(*) DESC
        LIMIT ${SAMPLE_LIMIT}
      `);
      const count = rows.reduce((sum, r) => sum + Number(r.count), 0);
      if (rows.length === 0) return { count: 0, samples: [] };
      const names = await this.prisma.clickupTask.findMany({
        where: { taskId: { in: rows.map((r) => r.taskId) } },
        select: { taskId: true, taskName: true },
      });
      const nameById = new Map(names.map((n) => [n.taskId, n.taskName]));
      return {
        count,
        samples: rows.map((r) => ({ taskId: r.taskId, taskName: nameById.get(r.taskId) ?? r.taskId })),
      };
    } catch (err) {
      this.logger.warn(`Reopened-blocker query degraded to 0: ${(err as Error).message}`);
      return { count: 0, samples: [] };
    }
  }

  // ── Coverage meta ──────────────────────────────────────────────────────────
  async coverage(workspaceId: string): Promise<Coverage> {
    const where = { workspaceId, isDeleted: false } as const;
    const [totalTasks, embeddedCount, withComments, range] = await Promise.all([
      this.prisma.clickupTask.count({ where }),
      this.embeddedCount(workspaceId),
      this.prisma.clickupTask.count({ where: { ...where, commentsSyncedAt: { not: null } } }),
      this.prisma.clickupTask.aggregate({
        where,
        _min: { createdDate: true },
        _max: { createdDate: true },
      }),
    ]);
    const commentCoveragePct =
      totalTasks === 0 ? 0 : Math.round((withComments / totalTasks) * 1000) / 10;
    return {
      totalTasks,
      embeddedCount,
      dateRange: {
        earliest: range._min.createdDate ? range._min.createdDate.toISOString() : null,
        latest: range._max.createdDate ? range._max.createdDate.toISOString() : null,
      },
      commentCoveragePct,
    };
  }

  /**
   * Up to ~`limit` task titles for the narrative: recent (by updatedDate) +
   * top-component coverage. Titles only — no metrics — so the LLM grounds prose in
   * real work without inventing numbers. Deduped by taskId.
   */
  async sampleTitles(workspaceId: string, limit = 50): Promise<string[]> {
    const half = Math.ceil(limit / 2);
    const [recent, byComponent] = await Promise.all([
      this.prisma.clickupTask.findMany({
        where: { workspaceId, isDeleted: false },
        select: { taskId: true, taskName: true },
        orderBy: { updatedDate: "desc" },
        take: half,
      }),
      this.prisma.clickupTask.findMany({
        where: { workspaceId, isDeleted: false },
        select: { taskId: true, taskName: true },
        orderBy: [{ listName: "asc" }, { updatedDate: "desc" }],
        take: limit,
      }),
    ]);
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const t of [...recent, ...byComponent]) {
      if (seen.has(t.taskId)) continue;
      seen.add(t.taskId);
      if (t.taskName && t.taskName.trim()) titles.push(t.taskName.trim());
      if (titles.length >= limit) break;
    }
    return titles;
  }
}
