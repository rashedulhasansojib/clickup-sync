import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceService } from '../workspaces/workspace.service';

function defaultFrom(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d;
}

function defaultFromForBucket(bucket: 'day' | 'week' | 'month'): Date {
  const d = new Date();
  if (bucket === 'day')   { d.setDate(d.getDate() - 30); return d; }
  if (bucket === 'week')  { d.setDate(d.getDate() - 7 * 12); return d; }
  // month: 12 months back
  d.setMonth(d.getMonth() - 12);
  return d;
}

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspaceService,
  ) {}

  async tasksSummary(workspaceId: string) {
    // `byStatusType` is added so the Overview KPIs can derive open/closed
    // counts reliably. The per-list `status` strings are unstable across
    // workspaces ('Closed' vs 'closed', 'done' vs 'complete'), but ClickUp's
    // `status_type` is a coarse classification (open/custom/done/closed) that
    // survives any per-list status renaming.
    //
    // `bySpace` uses raw SQL instead of Prisma groupBy because some tasks were
    // synced before space.name was populated by the upstream parser, leaving
    // rows with the same space_id but different space_name (one NULL, one
    // populated). Grouping by both columns split a single space into two
    // buckets in the chart. Resolving via `MAX(space_name)` collapses them
    // back into one row per space.
    type SpaceRow = { space_id: string | null; space_name: string | null; count: bigint };
    const [bySpaceRows, byStatusRows, byStatusTypeRows, total] = await Promise.all([
      this.prisma.$queryRaw<SpaceRow[]>(Prisma.sql`
        SELECT space_id,
               MAX(space_name) AS space_name,
               COUNT(*)::bigint AS count
        FROM clickup_tasks
        WHERE is_deleted = false
          AND workspace_id = ${workspaceId}
        GROUP BY space_id
        ORDER BY count DESC
      `),
      this.prisma.clickupTask.groupBy({ by: ['status'], where: { workspaceId, isDeleted: false }, _count: { taskId: true } }),
      this.prisma.clickupTask.groupBy({ by: ['statusType'], where: { workspaceId, isDeleted: false }, _count: { taskId: true } }),
      this.prisma.clickupTask.count({ where: { workspaceId, isDeleted: false } }),
    ]);
    return {
      bySpace: bySpaceRows.map(r => ({ spaceId: r.space_id, spaceName: r.space_name, count: Number(r.count) })),
      byStatus: byStatusRows.map(r => ({ status: r.status, count: r._count.taskId })),
      byStatusType: byStatusTypeRows.map(r => ({ statusType: r.statusType, count: r._count.taskId })),
      total,
    };
  }

  async tasksBySpaceStatus(workspaceId: string) {
    const rows = await this.prisma.clickupTask.groupBy({
      by: ['spaceName', 'status'],
      where: { workspaceId, isDeleted: false },
      _count: { taskId: true },
      orderBy: { spaceName: 'asc' },
    });
    return rows.map(r => ({ spaceName: r.spaceName, status: r.status, count: r._count.taskId }));
  }

  /**
   * Distinct task assignees. The Tasks-page filter previously read from
   * `timeEntriesByUser`, which silently omitted anyone with zero logged
   * hours (e.g. assignees of expense-only tasks like the Hello Ahmad case).
   *
   * Pairs name + email by ordinal position. `clickup_normalizer.ts` joins
   * both fields from the same `t.assignees` array with `joinNames`, so the
   * i-th comma-separated chunk in `assignees_names` lines up with the i-th
   * in `assignees_emails`. Postgres' multi-array UNNEST does exactly that
   * pairing in a single pass; SQL beats Prisma here because Prisma can't
   * express ordinal-paired array unpacking.
   */
  async tasksAssignees(workspaceId: string) {
    type Row = { name: string; email: string | null; task_count: bigint };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT name, email, COUNT(*)::bigint AS task_count
      FROM (
        SELECT
          TRIM(BOTH FROM n) AS name,
          NULLIF(TRIM(BOTH FROM e), '') AS email
        FROM clickup_tasks
        CROSS JOIN LATERAL UNNEST(
          string_to_array(COALESCE(assignees_names, ''), ','),
          string_to_array(COALESCE(assignees_emails, ''), ',')
        ) AS u(n, e)
        WHERE is_deleted = false
          AND workspace_id = ${workspaceId}
      ) AS s
      WHERE name <> ''
      GROUP BY name, email
      ORDER BY name ASC
    `);
    return rows.map((r) => ({ name: r.name, email: r.email, taskCount: Number(r.task_count) }));
  }

  /** Distinct assignees that have at least one time entry. Feeds the
   *  "Exclude assignee" picker (all assignees with tracked time, so an admin
   *  can pre-emptively exclude someone who currently has a rate). */
  async timeEntriesAssignees(workspaceId: string) {
    type Row = { user_id: string; user_name: string | null; user_email: string | null };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT user_id,
             MAX(user_name)  AS user_name,
             MAX(user_email) AS user_email
      FROM clickup_time_entries
      WHERE user_id IS NOT NULL
        AND workspace_id = ${workspaceId}
      GROUP BY user_id
      ORDER BY MAX(user_name) NULLS LAST
    `);
    return rows.map((r) => ({ id: r.user_id, name: r.user_name, email: r.user_email }));
  }

  async tasksClients(workspaceId: string) {
    type Row = { client: string; task_count: bigint };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT client, COUNT(*)::bigint AS task_count
      FROM clickup_tasks
      WHERE is_deleted = false
        AND workspace_id = ${workspaceId}
        AND client IS NOT NULL
        AND client <> ''
      GROUP BY client
      ORDER BY client ASC
    `);
    return rows.map((r) => ({ client: r.client, taskCount: Number(r.task_count) }));
  }

  async tasksLists(workspaceId: string, spaceId?: string) {
    type Row = { list_id: string; list_name: string; space_name: string | null; task_count: bigint };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT list_id, list_name, MAX(space_name) AS space_name, COUNT(*)::bigint AS task_count
      FROM clickup_tasks
      WHERE is_deleted = false
        AND workspace_id = ${workspaceId}
        AND list_id IS NOT NULL
        AND list_name <> ''
        ${spaceId ? Prisma.sql`AND space_id = ${spaceId}` : Prisma.empty}
      GROUP BY list_id, list_name
      ORDER BY MAX(space_name) ASC, list_name ASC
    `);
    return rows.map((r) => ({
      listId: r.list_id,
      listName: r.list_name,
      spaceName: r.space_name,
      taskCount: Number(r.task_count),
    }));
  }

  async tasksFolders(workspaceId: string, spaceId?: string) {
    type Row = { folder_id: string; folder_name: string; space_name: string | null; task_count: bigint };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT folder_id, folder_name, MAX(space_name) AS space_name, COUNT(*)::bigint AS task_count
      FROM clickup_tasks
      WHERE is_deleted = false
        AND workspace_id = ${workspaceId}
        AND folder_id IS NOT NULL
        AND folder_name <> ''
        ${spaceId ? Prisma.sql`AND space_id = ${spaceId}` : Prisma.empty}
      GROUP BY folder_id, folder_name
      ORDER BY MAX(space_name) ASC, folder_name ASC
    `);
    return rows.map((r) => ({
      folderId: r.folder_id,
      folderName: r.folder_name,
      spaceName: r.space_name,
      taskCount: Number(r.task_count),
    }));
  }

  async tasks(
    workspaceId: string,
    spaceId?: string,
    status?: string,
    search?: string,
    fromParam?: string,
    toParam?: string,
    limit = 50,
    offset = 0,
    priority?: string,
    assigneeId?: string,
    type?: string,
    archived?: string,
    client?: string,
    taskIds?: string,
    listId?: string,
    folderId?: string,
  ) {
    // Cap kept generous so the dashboard's "Export CSV" can pull a complete
    // filtered set in one shot. The page UI never offers > 100 rows/page, so
    // this only matters for export requests.
    const safeLimit = Math.min(limit, 5000);
    const where: Prisma.ClickupTaskWhereInput = { workspaceId };
    // ClickUp `archived` flag (exclude / include / only). Always hide soft-deleted rows unless we add a separate flag later.
    where.isDeleted = false;
    if (archived === 'only') {
      where.archived = true;
    } else if (archived === 'include') {
      // show archived and non-archived
    } else {
      // exclude, hide, undefined, '' — default: hide archived tasks
      where.archived = false;
    }
    if (spaceId) where.spaceId = spaceId;
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (client) where.client = client;
    if (listId) where.listId = listId;
    if (folderId) where.folderId = folderId;
    if (type === 'parent') where.parentTaskId = null;
    if (type === 'subtask') where.parentTaskId = { not: null };
    if (assigneeId) where.assigneesNames = { contains: assigneeId, mode: 'insensitive' };
    if (taskIds) {
      const ids = taskIds.split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length > 0) where.taskId = { in: ids };
    }
    if (fromParam || toParam) {
      where.updatedDate = { gte: parseDate(fromParam, new Date(0)), lte: parseDate(toParam, new Date()) };
    }
    // Free-text search across short, indexed-friendly fields. Avoid description / raw
    // JSON — ILIKE on those gets expensive fast. Compose via AND so search stacks
    // with the other filters above (mirrors `timeEntriesList`).
    if (search?.trim()) {
      const q = search.trim();
      where.AND = [
        {
          OR: [
            { taskName: { contains: q, mode: 'insensitive' } },
            { taskId: { contains: q, mode: 'insensitive' } },
            { assigneesNames: { contains: q, mode: 'insensitive' } },
            { assigneesEmails: { contains: q, mode: 'insensitive' } },
            { client: { contains: q, mode: 'insensitive' } },
            { listName: { contains: q, mode: 'insensitive' } },
            { spaceName: { contains: q, mode: 'insensitive' } },
            { sprintName: { contains: q, mode: 'insensitive' } },
            { department: { contains: q, mode: 'insensitive' } },
            { executiveName: { contains: q, mode: 'insensitive' } },
          ],
        },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.clickupTask.findMany({
        where,
        orderBy: { updatedDate: 'desc' },
        take: safeLimit,
        skip: offset,
        select: {
          taskId: true, taskName: true, spaceId: true, spaceName: true, status: true, statusType: true, statusColor: true,
          priority: true, parentTaskId: true, assigneesNames: true, assigneesEmails: true,
          updatedDate: true, syncedAt: true, sprintPoints: true, sprintName: true, cost: true,
          client: true, department: true, isDeleted: true, archived: true,
          listName: true, dueDate: true, timeEstimate: true, timeSpent: true,
          createdDate: true, closedDate: true, startDate: true, syncCount: true,
          estimation: true, folderName: true, creatorName: true, executiveName: true,
        },
      }),
      this.prisma.clickupTask.count({ where }),
    ]);
    const MS_PER_H = 3600000;
    return {
      items: items.map((t) => {
        const { timeEstimate, timeSpent, cost, estimation, ...rest } = t;
        return {
          ...rest,
          cost: cost.toNumber(),
          estimation: estimation.toNumber(),
          timeEstimateHours: timeEstimate != null ? Number(timeEstimate) / MS_PER_H : null,
          timeSpentHours: timeSpent != null ? Number(timeSpent) / MS_PER_H : null,
        };
      }),
      total,
      limit: safeLimit,
      offset,
    };
  }

  async timeEntriesByUser(workspaceId: string, fromParam?: string, toParam?: string) {
    const from = parseDate(fromParam, defaultFrom());
    const to = parseDate(toParam, new Date());
    const rows = await this.prisma.clickupTimeEntry.groupBy({
      by: ['userId', 'userName', 'userEmail'],
      where: { workspaceId, startTime: { gte: from, lte: to } },
      _sum: { durationHours: true, costCents: true },
    });
    return rows
      .map(r => ({
        userId: r.userId,
        userName: r.userName,
        userEmail: r.userEmail,
        totalHours: r._sum.durationHours?.toNumber() ?? 0,
        totalCostAud: Number(r._sum.costCents ?? 0n) / 100,
      }))
      .sort((a, b) => b.totalCostAud - a.totalCostAud);
  }

  /**
   * Current-period totals and the equal-length prior-period totals, used by
   * the Overview page's KPI cards to render period-over-period deltas. The
   * prior window is `[from - (to - from), from)` — exclusive on the upper
   * bound so it doesn't overlap with the current window.
   *
   * Soft-deleted tasks are excluded from both windows.
   */
  async overviewDeltas(workspaceId: string, fromParam?: string, toParam?: string) {
    const from = parseDate(fromParam, defaultFrom());
    const to = parseDate(toParam, new Date());
    const spanMs = to.getTime() - from.getTime();
    const priorFrom = new Date(from.getTime() - spanMs);
    const priorTo = from;

    type Row = { total_hours: number | null; total_cost_cents: bigint | null };
    const sumWindow = (winFrom: Date, winTo: Date, upperOp: 'lte' | 'lt') => {
      const upper = upperOp === 'lte'
        ? Prisma.sql`e.start_time <= ${winTo}`
        : Prisma.sql`e.start_time <  ${winTo}`;
      return this.prisma.$queryRaw<Row[]>(Prisma.sql`
        SELECT COALESCE(SUM(e.duration_hours), 0)::float AS total_hours,
               COALESCE(SUM(e.cost_cents), 0)::bigint   AS total_cost_cents
        FROM clickup_time_entries e
        JOIN clickup_tasks t ON e.task_id = t.task_id
        WHERE e.start_time IS NOT NULL
          AND e.workspace_id = ${workspaceId}
          AND e.start_time >= ${winFrom}
          AND ${upper}
          AND t.is_deleted = false
      `);
    };

    const [currentRows, priorRows] = await Promise.all([
      // 'lte': current window is closed-right on `to` (matches other endpoints).
      sumWindow(from, to, 'lte'),
      // 'lt': prior window is open-right on `from` so a row at exactly `from`
      // is counted only in the current window, not both.
      sumWindow(priorFrom, priorTo, 'lt'),
    ]);

    const mapRow = (r: Row) => ({
      totalHours: Number(r.total_hours ?? 0),
      totalCostAud: Number(r.total_cost_cents ?? 0n) / 100,
    });

    return {
      current: mapRow(currentRows[0] ?? { total_hours: 0, total_cost_cents: 0n }),
      prior:   mapRow(priorRows[0]   ?? { total_hours: 0, total_cost_cents: 0n }),
    };
  }

  async timeEntriesByClient(workspaceId: string, fromParam?: string, toParam?: string) {
    const from = parseDate(fromParam, defaultFrom());
    const to = parseDate(toParam, new Date());
    type Row = { client: string; total_hours: number; total_cost_cents: number };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT t.client,
        COALESCE(SUM(e.duration_hours), 0)::float AS total_hours,
        COALESCE(SUM(e.cost_cents), 0)::float AS total_cost_cents
      FROM clickup_time_entries e
      JOIN clickup_tasks t ON e.task_id = t.task_id
      WHERE e.workspace_id = ${workspaceId}
        AND e.start_time >= ${from} AND e.start_time <= ${to}
        AND t.is_deleted = false
        AND t.client IS NOT NULL AND t.client <> ''
      GROUP BY t.client
      ORDER BY total_cost_cents DESC
    `);
    return rows.map(r => ({ client: r.client, totalHours: Number(r.total_hours), totalCostAud: Number(r.total_cost_cents) / 100 }));
  }

  async timeEntriesByDepartment(workspaceId: string, fromParam?: string, toParam?: string) {
    const from = parseDate(fromParam, defaultFrom());
    const to = parseDate(toParam, new Date());
    type Row = { department: string; total_hours: number; total_cost_cents: number };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT t.department,
        COALESCE(SUM(e.duration_hours), 0)::float AS total_hours,
        COALESCE(SUM(e.cost_cents), 0)::float AS total_cost_cents
      FROM clickup_time_entries e
      JOIN clickup_tasks t ON e.task_id = t.task_id
      WHERE e.workspace_id = ${workspaceId}
        AND e.start_time >= ${from} AND e.start_time <= ${to}
        AND t.department IS NOT NULL AND t.department <> ''
      GROUP BY t.department
      ORDER BY total_cost_cents DESC
    `);
    return rows.map(r => ({ department: r.department, totalHours: Number(r.total_hours), totalCostAud: Number(r.total_cost_cents) / 100 }));
  }

  async timeEntriesBillableSummary(workspaceId: string, fromParam?: string, toParam?: string) {
    const from = parseDate(fromParam, defaultFrom());
    const to = parseDate(toParam, new Date());
    const rows = await this.prisma.clickupTimeEntry.groupBy({
      by: ['billable'],
      where: { workspaceId, startTime: { gte: from, lte: to } },
      _sum: { durationHours: true, costCents: true },
    });
    const b = rows.find(r => r.billable);
    const nb = rows.find(r => !r.billable);
    return {
      billableHours: b?._sum.durationHours?.toNumber() ?? 0,
      nonBillableHours: nb?._sum.durationHours?.toNumber() ?? 0,
      billableCostAud: Number(b?._sum.costCents ?? 0n) / 100,
      nonBillableCostAud: Number(nb?._sum.costCents ?? 0n) / 100,
    };
  }

  /**
   * Server-side aggregates for the Time Entries page metric cards.
   * Must accept the *same* filter set as `timeEntriesList` so the cards
   * reflect the user's filters, not just the current page of 50.
   *
   * Where-clause is inlined (not shared with `timeEntriesList`) on purpose —
   * one local copy is easier to reason about than a shared helper, and lets
   * either endpoint diverge without breaking the other.
   */
  async timeEntriesAggregates(
    workspaceId: string,
    userId?: string,
    fromParam?: string,
    toParam?: string,
    status?: string,
    billable?: string,
    search?: string,
    spaceId?: string,
    missingOnly?: string,
    client?: string,
    listId?: string,
    folderId?: string,
  ) {
    const from = parseDate(fromParam, defaultFrom());
    const to = parseDate(toParam, new Date());
    const where: Prisma.ClickupTimeEntryWhereInput = { workspaceId, startTime: { gte: from, lte: to } };
    const and: Prisma.ClickupTimeEntryWhereInput[] = [];
    if (spaceId) and.push({ task: { spaceId, isDeleted: false } });
    // Intentionally no `isDeleted: false` here (unlike the spaceId clause):
    // the base list shows entries regardless of task soft-deletion, so the
    // client filter stays consistent with that. Don't "fix" this to exclude
    // deleted tasks — it would make client-only vs client+space disagree.
    if (client) and.push({ task: { client } });
    if (listId) and.push({ task: { listId } });
    if (folderId) and.push({ task: { folderId } });
    if (userId) where.userId = userId;
    if (missingOnly === 'true') {
      where.status = 'NO_RATE_FOUND';
    } else if (status) {
      where.status = status;
    }
    if (billable === 'true') where.billable = true;
    else if (billable === 'false') where.billable = false;
    if (search?.trim()) {
      const q = search.trim();
      and.push({
        OR: [
          { task: { taskName: { contains: q, mode: 'insensitive' } } },
          { userName: { contains: q, mode: 'insensitive' } },
          { userEmail: { contains: q, mode: 'insensitive' } },
          { taskId: { contains: q, mode: 'insensitive' } },
          { timeEntryId: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
    if (and.length) where.AND = and;

    // Two parallel groupBys are enough:
    //   • by billable → gives total count, total hours, total cost, and the
    //     billable/non-billable split in a single query.
    //   • by status → gives counts for COST_CALCULATED / NO_RATE_FOUND /
    //     SYNCED (we only surface the first two).
    const [byBillable, byStatus] = await Promise.all([
      this.prisma.clickupTimeEntry.groupBy({
        by: ['billable'],
        where,
        _count: true,
        _sum: { durationHours: true, costCents: true },
      }),
      this.prisma.clickupTimeEntry.groupBy({
        by: ['status'],
        where,
        _count: true,
      }),
    ]);

    const b = byBillable.find(r => r.billable);
    const nb = byBillable.find(r => !r.billable);
    const totalEntries = byBillable.reduce((s, r) => s + r._count, 0);
    const billableHours = b?._sum.durationHours?.toNumber() ?? 0;
    const nonBillableHours = nb?._sum.durationHours?.toNumber() ?? 0;
    const totalHours = billableHours + nonBillableHours;
    const totalCostCents =
      Number(b?._sum.costCents ?? 0n) + Number(nb?._sum.costCents ?? 0n);
    // Weighted-by-hours average rate — matches what users expect from
    // "avg $X/h": effective rate across all logged time in the period.
    const avgRateCents = totalHours > 0 ? Math.round(totalCostCents / totalHours) : 0;
    const costCalculatedCount = byStatus.find(s => s.status === 'COST_CALCULATED')?._count ?? 0;
    const noRateFoundCount = byStatus.find(s => s.status === 'NO_RATE_FOUND')?._count ?? 0;

    return {
      totalEntries,
      totalHours,
      billableHours,
      nonBillableHours,
      totalCostCents,
      avgRateCents,
      costCalculatedCount,
      noRateFoundCount,
    };
  }

  async timeEntriesList(
    workspaceId: string,
    userId?: string,
    fromParam?: string,
    toParam?: string,
    status?: string,
    limit = 50,
    offset = 0,
    billable?: string,
    search?: string,
    spaceId?: string,
    missingOnly?: string,
    client?: string,
    listId?: string,
    folderId?: string,
  ) {
    // Same rationale as `tasks()`: cap allows CSV export to fetch the entire
    // filtered set; normal pagination tops out at 100 rows/page.
    const safeLimit = Math.min(limit, 5000);
    const from = parseDate(fromParam, defaultFrom());
    const to = parseDate(toParam, new Date());
    const where: Prisma.ClickupTimeEntryWhereInput = { workspaceId, startTime: { gte: from, lte: to } };
    const and: Prisma.ClickupTimeEntryWhereInput[] = [];
    if (spaceId) and.push({ task: { spaceId, isDeleted: false } });
    // Intentionally no `isDeleted: false` here (unlike the spaceId clause):
    // the base list shows entries regardless of task soft-deletion, so the
    // client filter stays consistent with that. Don't "fix" this to exclude
    // deleted tasks — it would make client-only vs client+space disagree.
    if (client) and.push({ task: { client } });
    if (listId) and.push({ task: { listId } });
    if (folderId) and.push({ task: { folderId } });
    if (userId) where.userId = userId;
    if (missingOnly === 'true') {
      where.status = 'NO_RATE_FOUND';
    } else if (status) {
      where.status = status;
    }
    if (billable === 'true') where.billable = true;
    else if (billable === 'false') where.billable = false;
    if (search?.trim()) {
      const q = search.trim();
      and.push({
        OR: [
          { task: { taskName: { contains: q, mode: 'insensitive' } } },
          { userName: { contains: q, mode: 'insensitive' } },
          { userEmail: { contains: q, mode: 'insensitive' } },
          { taskId: { contains: q, mode: 'insensitive' } },
          { timeEntryId: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
    if (and.length) where.AND = and;
    const [items, total] = await Promise.all([
      this.prisma.clickupTimeEntry.findMany({
        where,
        orderBy: { startTime: 'desc' },
        take: safeLimit,
        skip: offset,
        select: {
          timeEntryId: true, taskId: true, userId: true, userName: true, userEmail: true,
          startTime: true, endTime: true, durationHours: true, hourlyRateCents: true,
          costCents: true, status: true, billable: true, description: true, syncedAt: true,
          rateId: true, currency: true,
          task: { select: { taskName: true, client: true, listName: true } },
        },
      }),
      this.prisma.clickupTimeEntry.count({ where }),
    ]);
    return {
      items: items.map(e => ({
        timeEntryId: e.timeEntryId,
        taskId: e.taskId ?? '',
        taskName: e.task?.taskName ?? null,
        client: e.task?.client ?? null,
        listName: e.task?.listName ?? null,
        userId: e.userId ?? '',
        userName: e.userName,
        userEmail: e.userEmail,
        startTime: e.startTime,
        endTime: e.endTime,
        durationHours: e.durationHours.toNumber(),
        hourlyRateCents: Number(e.hourlyRateCents),
        costAud: Number(e.costCents) / 100,
        status: e.status,
        billable: e.billable,
        description: e.description,
        syncedAt: e.syncedAt,
        rateId: e.rateId != null ? e.rateId.toString() : null,
        currency: e.currency ?? 'USD',
      })),
      total,
      limit: safeLimit,
      offset,
    };
  }

  async sprintPoints(workspaceId: string, spaceId?: string) {
    const where: Prisma.ClickupTaskWhereInput = { workspaceId, isDeleted: false };
    if (spaceId) where.spaceId = spaceId;
    const rows = await this.prisma.clickupTask.groupBy({
      by: ['spaceName', 'status'],
      where,
      _sum: { sprintPoints: true },
      orderBy: { spaceName: 'asc' },
    });
    return rows.map(r => ({ spaceName: r.spaceName, status: r.status, totalPoints: r._sum.sprintPoints ?? 0 }));
  }

  async syncHealth(workspaceId: string) {
    const checkpoints = await this.prisma.syncCheckpoint.findMany({ where: { workspaceId }, orderBy: { scopeId: 'asc' } });
    const spaces = this.workspaces.getSpaces(workspaceId);
    // Longest backfill lookback (in days) actually run for each space — taken
    // from the recorded `lookbackDays` on each backfill job log. Lets the UI
    // show "synced up to Nd back" so an empty-but-synced space reads clearly.
    type LookbackRow = { space_id: string; max_lookback: number };
    const lookbackRows = await this.prisma.$queryRaw<LookbackRow[]>(Prisma.sql`
      SELECT entity_id AS space_id, MAX((payload->>'lookbackDays')::int) AS max_lookback
      FROM sync_job_logs
      WHERE workspace_id = ${workspaceId}
        AND queue_name = 'clickup-backfills'
        AND entity_type = 'space'
        AND payload->>'lookbackDays' ~ '^[0-9]+$'
      GROUP BY entity_id
    `);
    const maxLookbackByScope = new Map(lookbackRows.map(r => [r.space_id, Number(r.max_lookback)]));
    const now = Date.now();
    // A space is "Stale" once its last successful sync is older than this. Set
    // comfortably above the reconcile/safety-net interval so a normal quiet gap
    // between syncs doesn't read as Stale (was 60m, which flagged Degraded on
    // essentially every idle hour).
    const STALE_AFTER_MINUTES = 12 * 60;
    return checkpoints.map(cp => {
      const space = spaces.find(s => s.spaceId === cp.scopeId);
      const ageMs = cp.lastSuccessfulSyncAt ? now - cp.lastSuccessfulSyncAt.getTime() : null;
      const ageMinutes = ageMs !== null ? Math.round(ageMs / 60000) : null;
      const status = ageMinutes === null ? 'Unknown' : ageMinutes > STALE_AFTER_MINUTES ? 'Stale' : 'Fresh';
      return { scopeId: cp.scopeId, spaceName: space?.name ?? cp.scopeId, lastSuccessfulSyncAt: cp.lastSuccessfulSyncAt, ageMinutes, status, maxLookbackDays: maxLookbackByScope.get(cp.scopeId) ?? null };
    });
  }

  async webhookEvents(workspaceId: string, limit = 50, offset = 0, status?: string, eventType?: string, search?: string) {
    const safeLimit = Math.min(limit, 200);
    const where: Prisma.ClickupWebhookEventWhereInput = { workspaceId };
    if (status && status !== 'all') where.status = status;
    if (eventType && eventType !== 'all') where.eventType = eventType;
    const q = search?.trim();
    if (q) {
      where.OR = [
        { taskId: { contains: q, mode: 'insensitive' } },
        { eventType: { contains: q, mode: 'insensitive' } },
        // The numeric primary key is shown in the UI, so allow an exact match
        // when the search term is all digits (contains isn't valid on BigInt).
        ...(/^\d+$/.test(q) ? [{ id: BigInt(q) }] : []),
      ];
    }
    const [items, total, eventTypeRows] = await Promise.all([
      this.prisma.clickupWebhookEvent.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        take: safeLimit,
        skip: offset,
        select: { id: true, eventType: true, taskId: true, status: true, receivedAt: true, processedAt: true },
      }),
      this.prisma.clickupWebhookEvent.count({ where }),
      // Distinct event types across ALL events (not the filtered set) so the
      // filter dropdown stays stable regardless of the active filter.
      this.prisma.clickupWebhookEvent.findMany({
        where: { workspaceId, eventType: { not: null } },
        distinct: ['eventType'],
        select: { eventType: true },
        orderBy: { eventType: 'asc' },
      }),
    ]);
    return {
      items: items.map(i => ({ ...i, id: i.id.toString() })),
      total,
      eventTypes: eventTypeRows.map(r => r.eventType).filter((e): e is string => !!e),
    };
  }

  async jobLogs(workspaceId: string, queueName?: string, status?: string, limit = 50, offset = 0) {
    const safeLimit = Math.min(limit, 200);
    // Raw SQL because we need a per-row `recovered` flag for failed jobs:
    // a failure is considered "recovered" if a later successful run for the
    // same (queue_name, entity_id) exists. This lets the dashboard answer
    // "was this work eventually processed?" without operators having to
    // hunt manually. The EXISTS subquery is cheap thanks to the existing
    // (entity_type, entity_id) and (status) indexes.
    type Row = {
      id: bigint;
      queue_name: string;
      job_name: string;
      status: string;
      entity_id: string | null;
      error_message: string | null;
      started_at: Date | null;
      finished_at: Date | null;
      tasks_synced: number | null;
      time_entries_synced: number | null;
      recovered: boolean | null;
    };
    const filters: Prisma.Sql[] = [];
    // Always scope to this workspace (sync_job_logs.workspace_id is nullable for
    // global jobs; the reports view only ever shows this workspace's rows).
    filters.push(Prisma.sql`workspace_id = ${workspaceId}`);
    if (queueName) filters.push(Prisma.sql`queue_name = ${queueName}`);
    if (status) filters.push(Prisma.sql`status = ${status}`);
    const whereClause = filters.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`
      : Prisma.empty;
    const [items, totalRows] = await Promise.all([
      this.prisma.$queryRaw<Row[]>(Prisma.sql`
        SELECT
          j.id, j.queue_name, j.job_name, j.status, j.entity_id, j.error_message,
          j.started_at, j.finished_at, j.tasks_synced, j.time_entries_synced,
          CASE
            WHEN j.status <> 'failed' THEN NULL
            WHEN j.entity_id IS NULL OR j.finished_at IS NULL THEN false
            ELSE EXISTS (
              SELECT 1 FROM sync_job_logs s
              WHERE s.queue_name = j.queue_name
                AND s.entity_id = j.entity_id
                AND s.status = 'completed'
                AND s.finished_at > j.finished_at
                AND s.workspace_id = ${workspaceId}
            )
          END AS recovered
        FROM sync_job_logs j
        ${whereClause}
        ORDER BY j.started_at DESC NULLS LAST
        LIMIT ${safeLimit}
        OFFSET ${offset}
      `),
      this.prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS count FROM sync_job_logs ${whereClause}
      `),
    ]);
    const total = Number(totalRows[0]?.count ?? 0);
    return {
      items: items.map((i) => ({
        id: i.id.toString(),
        queueName: i.queue_name,
        jobName: i.job_name,
        status: i.status,
        entityId: i.entity_id,
        errorMessage: i.error_message,
        startedAt: i.started_at,
        finishedAt: i.finished_at,
        tasksSynced: i.tasks_synced,
        timeEntriesSynced: i.time_entries_synced,
        recovered: i.recovered,
        durationMs: i.started_at && i.finished_at
          ? new Date(i.finished_at).getTime() - new Date(i.started_at).getTime()
          : null,
      })),
      total,
    };
  }

  async deadLetters(workspaceId: string, limit = 50, offset = 0) {
    const safeLimit = Math.min(limit, 200);
    const [items, total] = await Promise.all([
      this.prisma.deadLetterJob.findMany({
        where: { workspaceId, retriedAt: null, resolvedAt: null },
        orderBy: { failedAt: 'desc' },
        take: safeLimit,
        skip: offset,
        select: { id: true, queueName: true, jobName: true, entityId: true, errorMessage: true, failedAt: true },
      }),
      this.prisma.deadLetterJob.count({ where: { workspaceId, retriedAt: null, resolvedAt: null } }),
    ]);
    return { items: items.map(i => ({ ...i, id: i.id.toString() })), total };
  }

  async stats(workspaceId: string, excludedIds: string[] = []) {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [failedJobsLast24h, deadLetterPending, webhooksLast24h, missingRateEntries, lastWebhookEvent] = await Promise.all([
      this.prisma.syncJobLog.count({ where: { workspaceId, status: 'failed', finishedAt: { gte: since24h } } }),
      this.prisma.deadLetterJob.count({ where: { workspaceId, retriedAt: null, resolvedAt: null } }),
      this.prisma.clickupWebhookEvent.count({ where: { workspaceId, receivedAt: { gte: since24h } } }),
      this.prisma.clickupTimeEntry.count({
        where: {
          workspaceId,
          status: { notIn: ['COST_CALCULATED', 'COST_EXCLUDED'] },
          ...(excludedIds.length ? { OR: [{ userId: null }, { userId: { notIn: excludedIds } }] } : {}),
        },
      }),
      // Most recent webhook actually received — lets the UI report real webhook
      // delivery health (last event + whether any arrived in the last 24h)
      // instead of inferring it from sync-checkpoint freshness.
      this.prisma.clickupWebhookEvent.findFirst({
        where: { workspaceId },
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true },
      }),
    ]);
    return {
      failedJobsLast24h,
      deadLetterPending,
      webhooksLast24h,
      missingRateEntries,
      lastWebhookEventAt: lastWebhookEvent?.receivedAt ?? null,
    };
  }

  async missingRates(workspaceId: string, excludedIds: string[] = []) {
    type Row = {
      user_id: string;
      user_name: string;
      user_email: string;
      missing_count: bigint;
      affected_hours: number;
      first_date: Date;
      latest_date: Date;
      affected_task_count: bigint;
      affected_tasks: Array<{ taskId: string; taskName: string }>;
    };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      WITH missing AS (
        SELECT
          e.user_id,
          e.task_id,
          e.user_name,
          e.user_email,
          e.duration_hours,
          e.start_time
        FROM clickup_time_entries e
        WHERE e.user_id IS NOT NULL
          AND e.workspace_id = ${workspaceId}
          ${excludedIds.length ? Prisma.sql`AND e.user_id <> ALL(array[${Prisma.join(excludedIds)}]::text[])` : Prisma.empty}
          AND NOT EXISTS (
            -- Inclusive closed-closed interval [valid_from, valid_to], matching
            -- cost-calculator.service.ts. The earlier exclusive upper bound
            -- over-counted entries on the exact valid_to boundary (e.g. an
            -- entry on Dec 31 against a rate ending Dec 31): cost-calculator
            -- costs them as COST_CALCULATED, but the card still listed them
            -- as missing. Card and page-aggregate counts then diverged by
            -- exactly the boundary count.
            SELECT 1 FROM assignee_rates r
            WHERE r.assignee_id = e.user_id
              AND r.valid_from <= e.start_time::date
              AND (r.valid_to IS NULL OR r.valid_to >= e.start_time::date)
          )
      ),
      per_user AS (
        SELECT
          user_id,
          MAX(user_name) AS user_name,
          MAX(user_email) AS user_email,
          COUNT(*)::bigint AS missing_count,
          COALESCE(SUM(duration_hours), 0)::float AS affected_hours,
          MIN(start_time) AS first_date,
          MAX(start_time) AS latest_date
        FROM missing
        GROUP BY user_id
      ),
      tasks_per_user AS (
        -- INNER JOIN + is_deleted = false: the Tasks page hard-filters
        -- soft-deleted rows (reports.service.ts tasks() line 145), so we must
        -- not list/count tasks here that the "Show more" deep link can't show.
        -- Otherwise the card's count would exceed what the Tasks page renders.
        SELECT
          m.user_id,
          m.task_id,
          MAX(t.task_name) AS task_name,
          MAX(m.start_time) AS task_latest
        FROM missing m
        JOIN clickup_tasks t ON t.task_id = m.task_id AND t.is_deleted = false
        WHERE m.task_id IS NOT NULL
        GROUP BY m.user_id, m.task_id
      ),
      ranked AS (
        SELECT
          user_id,
          task_id,
          task_name,
          task_latest,
          ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY task_latest DESC) AS rn
        FROM tasks_per_user
      ),
      agg_tasks AS (
        SELECT
          user_id,
          COUNT(*)::bigint AS affected_task_count,
          COALESCE(
            jsonb_agg(jsonb_build_object('taskId', task_id, 'taskName', task_name) ORDER BY task_latest DESC)
              FILTER (WHERE rn <= 500),
            '[]'::jsonb
          ) AS affected_tasks
        FROM ranked
        GROUP BY user_id
      )
      SELECT
        pu.user_id,
        pu.user_name,
        pu.user_email,
        pu.missing_count,
        pu.affected_hours,
        pu.first_date,
        pu.latest_date,
        COALESCE(at.affected_task_count, 0)::bigint AS affected_task_count,
        COALESCE(at.affected_tasks, '[]'::jsonb) AS affected_tasks
      FROM per_user pu
      LEFT JOIN agg_tasks at USING (user_id)
      ORDER BY pu.missing_count DESC
    `);
    return rows.map(r => ({
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      missingCount: Number(r.missing_count),
      affectedHours: Number(r.affected_hours),
      firstDate: r.first_date,
      latestDate: r.latest_date,
      affectedTaskCount: Number(r.affected_task_count),
      affectedTasks: r.affected_tasks ?? [],
    }));
  }

  async spaces(workspaceId: string) {
    type Row = {
      space_id: string;
      space_name: string;
      task_count: bigint;
      open_count: bigint;
      member_count: bigint;
      hours_logged: number;
      cost_cents: number;
    };
    // Open count uses `status_type`, ClickUp's coarse-grained classification
    // (open / custom / done / closed), not the per-list `status` string. The
    // prior `status NOT IN ('complete','closed')` check missed real data —
    // ClickUp returns `'Closed'` (capitalized) and `'done'` (not 'complete'),
    // so every task qualified as "open".
    //
    // Member count is approximated as the distinct set of users who have logged
    // time against any task in the space. We have no direct space-membership
    // table, but "people doing the work" is the question the metric answers.
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT
        t.space_id,
        t.space_name,
        COUNT(DISTINCT t.task_id)::bigint AS task_count,
        COUNT(DISTINCT t.task_id) FILTER (WHERE t.status_type NOT IN ('closed', 'done'))::bigint AS open_count,
        COUNT(DISTINCT e.user_id) FILTER (WHERE e.user_id IS NOT NULL)::bigint AS member_count,
        COALESCE(SUM(e.duration_hours), 0)::float AS hours_logged,
        COALESCE(SUM(e.cost_cents), 0)::float AS cost_cents
      FROM clickup_tasks t
      LEFT JOIN clickup_time_entries e ON e.task_id = t.task_id
      WHERE t.is_deleted = false
        AND t.workspace_id = ${workspaceId}
      GROUP BY t.space_id, t.space_name
      ORDER BY task_count DESC
    `);
    return rows.map(r => ({
      spaceId: r.space_id,
      spaceName: r.space_name,
      taskCount: Number(r.task_count),
      openCount: Number(r.open_count),
      memberCount: Number(r.member_count),
      hoursLogged: Number(r.hours_logged),
      costAud: Number(r.cost_cents) / 100,
    }));
  }

  /**
   * Time-bucketed cost trend for the Overview page.
   *
   * Buckets in Asia/Dhaka local time (no DST, UTC+6). Week buckets are
   * Sunday-start: Postgres's date_trunc('week', ...) is Monday-based, so we
   * shift +1 day before truncating and shift back -1 day after, which moves
   * the week boundary from Mon→Sun→Mon to Sun→Sat→Sun.
   *
   * Empty buckets are returned with zeros (via generate_series LEFT JOIN)
   * so the chart shows a continuous timeline instead of gaps.
   */
  async costTrend(
    workspaceId: string,
    bucket: 'day' | 'week' | 'month',
    fromParam?: string,
    toParam?: string,
  ) {
    if (bucket !== 'day' && bucket !== 'week' && bucket !== 'month') {
      throw new Error(`Invalid bucket "${bucket}" (expected day|week|month)`);
    }

    const from = parseDate(fromParam, defaultFromForBucket(bucket));
    const to = parseDate(toParam, new Date());

    // Build the bucket expression. Applied to start_time converted to Dhaka local
    // for the aggregate, and to the input range for generate_series.
    // Use Prisma.raw() for the timezone string so it is emitted as a literal SQL
    // identifier rather than a parameterized placeholder. This keeps the timezone
    // visible in the compiled SQL text (required by tests) and avoids Postgres
    // rejecting a parameter where a constant string is expected in AT TIME ZONE.
    const TZ = Prisma.raw(`'Asia/Dhaka'`);
    const bucketExpr = (tsLocal: Prisma.Sql): Prisma.Sql => {
      if (bucket === 'day')   return Prisma.sql`date_trunc('day', ${tsLocal})`;
      if (bucket === 'month') return Prisma.sql`date_trunc('month', ${tsLocal})`;
      // Sunday-start week: shift +1d, truncate Mon-based week, shift -1d.
      return Prisma.sql`(date_trunc('week', ${tsLocal} + interval '1 day') - interval '1 day')`;
    };
    const interval =
      bucket === 'day'   ? Prisma.sql`interval '1 day'`   :
      bucket === 'week'  ? Prisma.sql`interval '1 week'`  :
                           Prisma.sql`interval '1 month'`;

    // `start_time` is a UTC-naive `timestamp` — label it UTC before converting to
    // Dhaka, else the offset is applied backwards (−6h) and days are misbucketed.
    const aggBucket    = bucketExpr(Prisma.sql`(e.start_time AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})`);
    const seriesStart  = bucketExpr(Prisma.sql`(${from}::timestamptz AT TIME ZONE ${TZ})`);
    const seriesEnd    = bucketExpr(Prisma.sql`(${to  }::timestamptz AT TIME ZONE ${TZ})`);

    type Row = {
      bucket: string;
      total_cost_cents: bigint;
      total_hours: number;
      entry_count: number;
    };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      WITH series AS (
        SELECT generate_series(${seriesStart}, ${seriesEnd}, ${interval}) AS bucket_local
      ),
      agg AS (
        SELECT ${aggBucket}                                    AS bucket_local,
               COALESCE(SUM(e.cost_cents), 0)::bigint          AS total_cost_cents,
               COALESCE(SUM(e.duration_hours), 0)::float       AS total_hours,
               COUNT(*)::int                                   AS entry_count
        FROM clickup_time_entries e
        JOIN clickup_tasks t ON e.task_id = t.task_id
        WHERE e.start_time IS NOT NULL
          AND e.workspace_id = ${workspaceId}
          AND e.start_time >= ${from}
          AND e.start_time <= ${to}
          AND t.is_deleted = false
        GROUP BY 1
      )
      SELECT to_char(s.bucket_local, 'YYYY-MM-DD')             AS bucket,
             COALESCE(a.total_cost_cents, 0)::bigint           AS total_cost_cents,
             COALESCE(a.total_hours, 0)::float                 AS total_hours,
             COALESCE(a.entry_count, 0)::int                   AS entry_count
      FROM series s
      LEFT JOIN agg a ON a.bucket_local = s.bucket_local
      ORDER BY s.bucket_local ASC
    `);

    return rows.map((r) => ({
      bucket: r.bucket,
      totalCostAud: Number(r.total_cost_cents) / 100,
      totalHours: Number(r.total_hours),
      entryCount: Number(r.entry_count),
    }));
  }

  /**
   * Shared engine for the stacked cost-trend charts: labor cost per time bucket,
   * broken down by an arbitrary segment expression (assignee, client, …).
   * Mirrors `costTrend`'s bucketing/timezone logic so all three charts line up.
   * By default every segment is returned on its own (highest total cost first),
   * never collapsed; an explicit `topN` caps the segments and folds the
   * remainder into a single "Other" bucket (opt-in only).
   *
   * `segmentExpr` is a raw SQL expression evaluated over the
   * `clickup_time_entries e JOIN clickup_tasks t` rows; it must already coalesce
   * NULL/empty to a stable label. Returns continuous `buckets` (including
   * zero-cost periods via the same generate_series the line chart uses), the
   * ordered `segments`, and a per-bucket cost map in dollars.
   */
  private async costTrendBySegment(
    workspaceId: string,
    bucket: 'day' | 'week' | 'month',
    fromParam: string | undefined,
    toParam: string | undefined,
    topN: number | undefined,
    segmentExpr: Prisma.Sql,
  ) {
    if (bucket !== 'day' && bucket !== 'week' && bucket !== 'month') {
      throw new Error(`Invalid bucket "${bucket}" (expected day|week|month)`);
    }

    const from = parseDate(fromParam, defaultFromForBucket(bucket));
    const to = parseDate(toParam, new Date());

    const TZ = Prisma.raw(`'Asia/Dhaka'`);
    const bucketExpr = (tsLocal: Prisma.Sql): Prisma.Sql => {
      if (bucket === 'day')   return Prisma.sql`date_trunc('day', ${tsLocal})`;
      if (bucket === 'month') return Prisma.sql`date_trunc('month', ${tsLocal})`;
      return Prisma.sql`(date_trunc('week', ${tsLocal} + interval '1 day') - interval '1 day')`;
    };
    const interval =
      bucket === 'day'   ? Prisma.sql`interval '1 day'`   :
      bucket === 'week'  ? Prisma.sql`interval '1 week'`  :
                           Prisma.sql`interval '1 month'`;

    const aggBucket   = bucketExpr(Prisma.sql`(e.start_time AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})`);
    const seriesStart = bucketExpr(Prisma.sql`(${from}::timestamptz AT TIME ZONE ${TZ})`);
    const seriesEnd   = bucketExpr(Prisma.sql`(${to  }::timestamptz AT TIME ZONE ${TZ})`);

    // Continuous bucket axis (same shape as costTrend's `series`), so periods
    // with no logged time still render as gaps in the trend.
    type BucketRow = { bucket: string };
    const bucketRows = await this.prisma.$queryRaw<BucketRow[]>(Prisma.sql`
      SELECT to_char(generate_series(${seriesStart}, ${seriesEnd}, ${interval}), 'YYYY-MM-DD') AS bucket
      ORDER BY 1 ASC
    `);
    const buckets = bucketRows.map((r) => r.bucket);

    // Cost per (bucket, segment). The bucket string uses the identical
    // to_char(bucketExpr) form as the axis above so the keys line up exactly.
    type AggRow = { bucket: string; segment: string; cost_cents: bigint };
    const aggRows = await this.prisma.$queryRaw<AggRow[]>(Prisma.sql`
      SELECT to_char(${aggBucket}, 'YYYY-MM-DD')      AS bucket,
             ${segmentExpr}                           AS segment,
             COALESCE(SUM(e.cost_cents), 0)::bigint   AS cost_cents
      FROM clickup_time_entries e
      JOIN clickup_tasks t ON e.task_id = t.task_id
      WHERE e.start_time IS NOT NULL
        AND e.workspace_id = ${workspaceId}
        AND e.start_time >= ${from}
        AND e.start_time <= ${to}
        AND t.is_deleted = false
      GROUP BY 1, 2
    `);

    // Rank segments by total cost across the whole range to choose the top N.
    const totals = new Map<string, number>();
    for (const r of aggRows) {
      totals.set(r.segment, (totals.get(r.segment) ?? 0) + Number(r.cost_cents));
    }
    // No `topN` → every segment gets its own bar slice (highest cost first),
    // never collapsed into "Other". An explicit cap opts into the collapse.
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const capped = typeof topN === 'number';
    const topSegments = (capped ? sorted.slice(0, topN) : sorted).map(([name]) => name);
    const topSet = new Set(topSegments);
    const hasOther = capped && totals.size > topSet.size;

    // bucket -> (segment/"Other") -> dollars
    const matrix = new Map<string, Map<string, number>>();
    for (const r of aggRows) {
      const key = topSet.has(r.segment) ? r.segment : 'Other';
      const row = matrix.get(r.bucket) ?? new Map<string, number>();
      row.set(key, (row.get(key) ?? 0) + Number(r.cost_cents) / 100);
      matrix.set(r.bucket, row);
    }

    const segments = [...topSegments, ...(hasOther ? ['Other'] : [])];
    const points = buckets.map((b) => {
      const row = matrix.get(b);
      const values: Record<string, number> = {};
      for (const s of segments) values[s] = row?.get(s) ?? 0;
      return { bucket: b, values };
    });

    return { buckets, segments, points };
  }

  /**
   * Labor cost per time bucket, broken down by assignee — feeds the stacked
   * "Assignee cost trend" chart. See {@link costTrendBySegment}; the segment is
   * the entry's logger name (falling back to user id, then "Unknown").
   */
  async costTrendByAssignee(
    workspaceId: string,
    bucket: 'day' | 'week' | 'month',
    fromParam?: string,
    toParam?: string,
    topN?: number,
  ) {
    const { buckets, segments, points } = await this.costTrendBySegment(
      workspaceId, bucket, fromParam, toParam, topN,
      Prisma.sql`COALESCE(NULLIF(e.user_name, ''), e.user_id, 'Unknown')`,
    );
    return { buckets, assignees: segments, points };
  }

  /**
   * Labor cost per time bucket, broken down by the task's client — feeds the
   * stacked bar view of the "Client cost trend" chart. See
   * {@link costTrendBySegment}; tasks with no client are grouped under
   * "No client".
   */
  async costTrendByClient(
    workspaceId: string,
    bucket: 'day' | 'week' | 'month',
    fromParam?: string,
    toParam?: string,
    topN?: number,
  ) {
    const { buckets, segments, points } = await this.costTrendBySegment(
      workspaceId, bucket, fromParam, toParam, topN,
      Prisma.sql`COALESCE(NULLIF(t.client, ''), 'No client')`,
    );
    return { buckets, clients: segments, points };
  }

  /**
   * Statistical-rule anomaly detection for the Overview "Anomalies" panel.
   *
   * Daily spike rule: a BD-local day in the last 30 where day_cost > 2x the
   *   median day_cost (over non-zero days) AND day_cost > $50.
   *
   * Client spike rule: a client whose last-7-days cost > 2x their 90-day
   *   weekly-median (over Sunday-start weeks in the [90d, 7d) window),
   *   AND last-7-days cost > $50.
   *
   * Both rules require median > 0 to avoid Infinity multipliers on
   *   brand-new metrics. Soft-deleted tasks excluded.
   */
  /**
   * Cycle time = hours between the first event whose after.type === 'open' and
   * the last event whose after.type === 'done', per task. Tasks that "bounce"
   * (done → in-progress → done) use first-open to last-done, i.e. end-to-end
   * calendar time. Window filters by the task's *last done* occurredAt.
   */
  async cycleTime(workspaceId: string, args: { from: Date; to: Date; groupBy: 'week' | 'client' | 'department' }) {
    const { from, to, groupBy } = args;
    const bucketExpr =
      groupBy === 'week'
        ? Prisma.sql`to_char(date_trunc('week', (last_done AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka') + interval '1 day') - interval '1 day', 'YYYY-MM-DD')`
        : groupBy === 'client'
          ? Prisma.sql`COALESCE(NULLIF(t.client, ''), 'Unattributed')`
          : Prisma.sql`COALESCE(NULLIF(t.department, ''), 'Unattributed')`;

    type Row = { bucket: string; mean_hours: number; median_hours: number; p90_hours: number; task_count: bigint };
    type MetaRow = { min_occurred_at: Date | null };

    const [items, metaRows] = await Promise.all([
      this.prisma.$queryRaw<Row[]>(Prisma.sql`
        WITH task_endpoints AS (
          SELECT
            e.task_id,
            MIN(e.occurred_at) FILTER (WHERE (e.after->>'type') = 'open') AS first_open,
            MAX(e.occurred_at) FILTER (WHERE (e.after->>'type') = 'done') AS last_done
          FROM clickup_task_events e
          WHERE e.event_type = 'taskStatusUpdated'
            AND e.workspace_id = ${workspaceId}
          GROUP BY e.task_id
        )
        SELECT
          ${bucketExpr} AS bucket,
          AVG(EXTRACT(EPOCH FROM (last_done - first_open)) / 3600.0)::float        AS mean_hours,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (last_done - first_open)) / 3600.0
          )::float                                                                  AS median_hours,
          percentile_cont(0.9) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (last_done - first_open)) / 3600.0
          )::float                                                                  AS p90_hours,
          COUNT(*)::bigint                                                          AS task_count
        FROM task_endpoints te
        LEFT JOIN clickup_tasks t ON t.task_id = te.task_id
        WHERE first_open IS NOT NULL
          AND last_done IS NOT NULL
          AND last_done >= ${from}
          AND last_done <= ${to}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
      this.prisma.$queryRaw<MetaRow[]>(Prisma.sql`
        SELECT MIN(occurred_at) AS min_occurred_at
        FROM clickup_task_events
        WHERE event_type = 'taskStatusUpdated'
          AND workspace_id = ${workspaceId}
      `),
    ]);

    return {
      items: items.map((r) => ({
        bucket: r.bucket,
        meanHours: Number(r.mean_hours ?? 0),
        medianHours: Number(r.median_hours ?? 0),
        p90Hours: Number(r.p90_hours ?? 0),
        taskCount: Number(r.task_count ?? 0n),
      })),
      meta: {
        minOccurredAt: metaRows[0]?.min_occurred_at ? metaRows[0].min_occurred_at.toISOString() : null,
      },
    };
  }

  /**
   * Time-in-status: for each task, walk events in order; for each consecutive
   * pair, attribute (next - prev) hours to prev.after.status. The currently-
   * active status (last event without a successor) attributes hours up to `to`.
   * Bar by status with its captured `color`.
   */
  async timeInStatus(workspaceId: string, args: { from: Date; to: Date }) {
    const { from, to } = args;
    type Row = { status: string; color: string | null; total_hours: number; task_count: bigint };
    type MetaRow = { min_occurred_at: Date | null };

    const [items, metaRows] = await Promise.all([
      this.prisma.$queryRaw<Row[]>(Prisma.sql`
        WITH ordered AS (
          SELECT
            e.task_id,
            e.occurred_at,
            e.after,
            LEAD(e.occurred_at) OVER (PARTITION BY e.task_id ORDER BY e.occurred_at) AS next_at
          FROM clickup_task_events e
          WHERE e.event_type = 'taskStatusUpdated'
            AND e.workspace_id = ${workspaceId}
            AND e.occurred_at <= ${to}
        ),
        intervals AS (
          SELECT
            (after->>'status')                                                AS status,
            (after->>'color')                                                 AS color,
            task_id,
            GREATEST(occurred_at, ${from})                                    AS interval_start,
            LEAST(COALESCE(next_at, ${to}), ${to})                            AS interval_end
          FROM ordered
          WHERE COALESCE(next_at, ${to}) >= ${from}
        )
        SELECT
          status,
          MAX(color)                                                          AS color,
          SUM(EXTRACT(EPOCH FROM (interval_end - interval_start)) / 3600.0)::float AS total_hours,
          COUNT(DISTINCT task_id)::bigint                                     AS task_count
        FROM intervals
        WHERE interval_end > interval_start
          AND status IS NOT NULL
        GROUP BY status
        ORDER BY total_hours DESC
      `),
      this.prisma.$queryRaw<MetaRow[]>(Prisma.sql`
        SELECT MIN(occurred_at) AS min_occurred_at
        FROM clickup_task_events
        WHERE event_type = 'taskStatusUpdated'
          AND workspace_id = ${workspaceId}
      `),
    ]);

    return {
      items: items.map((r) => ({
        status: r.status,
        color: r.color,
        totalHours: Number(r.total_hours ?? 0),
        taskCount: Number(r.task_count ?? 0n),
      })),
      meta: {
        minOccurredAt: metaRows[0]?.min_occurred_at ? metaRows[0].min_occurred_at.toISOString() : null,
      },
    };
  }

  /**
   * Per-user daily-hour spikes. SQL only aggregates hours per (user, local day);
   * detection, classification, ranking and zero-fill happen here in TS so the
   * rule logic is unit-testable. The relative-rule median derives from the
   * selected window, floored to a 14-day minimum so a short pick does not
   * produce a noisy median that flags nearly every day.
   */
  async hourSpikes(workspaceId: string, cap: number, fromParam?: string, toParam?: string, limit = 20, includeResolved = false) {
    const TZ = Prisma.raw(`'Asia/Dhaka'`);
    // `start_time` is `timestamp without time zone` holding a UTC instant. To
    // bucket by Dhaka calendar day we must first label it UTC, THEN convert:
    // `AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka'`. Applying `AT TIME ZONE
    // 'Asia/Dhaka'` directly to the naive column treats the stored value as
    // *already* Dhaka-local and shifts it the wrong way (−6h), mis-assigning
    // late-evening-UTC entries to the previous day — which made watchlist day
    // totals disagree with the time-entries deep link. Keep both AT TIME ZONEs.
    const defaultFrom = new Date();
    defaultFrom.setDate(defaultFrom.getDate() - 30);
    const from = parseDate(fromParam, defaultFrom);
    const to = parseDate(toParam, new Date());

    // Median baseline derives from the selected window, floored to 14 days so a
    // short pick doesn't produce a noisy median that flags nearly every day.
    const BASELINE_FLOOR_MS = 14 * 24 * 60 * 60 * 1000;
    const baselineFrom = new Date(Math.min(from.getTime(), to.getTime() - BASELINE_FLOOR_MS));

    type DayRow = { user_id: string | null; user_name: string | null; day: string; hours: number };
    type BucketRow = { bucket: string };

    const [baselineRows, displayRows, axisRows] = await Promise.all([
      this.prisma.$queryRaw<DayRow[]>(Prisma.sql`
      SELECT COALESCE(e.user_id, 'unknown')                        AS user_id,
             COALESCE(NULLIF(e.user_name, ''), e.user_id, 'Unknown') AS user_name,
             to_char(date_trunc('day', e.start_time AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS day,
             COALESCE(SUM(e.duration_hours), 0)::float             AS hours
      FROM clickup_time_entries e
      JOIN clickup_tasks t ON e.task_id = t.task_id
      WHERE e.start_time IS NOT NULL
        AND e.workspace_id = ${workspaceId}
        AND e.start_time >= ${baselineFrom}
        AND e.start_time <= ${to}
        AND t.is_deleted = false
      GROUP BY 1, 2, 3
    `),
      this.prisma.$queryRaw<DayRow[]>(Prisma.sql`
      SELECT COALESCE(e.user_id, 'unknown')                        AS user_id,
             COALESCE(NULLIF(e.user_name, ''), e.user_id, 'Unknown') AS user_name,
             to_char(date_trunc('day', e.start_time AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS day,
             COALESCE(SUM(e.duration_hours), 0)::float             AS hours
      FROM clickup_time_entries e
      JOIN clickup_tasks t ON e.task_id = t.task_id
      WHERE e.start_time IS NOT NULL
        AND e.workspace_id = ${workspaceId}
        AND e.start_time >= ${from}
        AND e.start_time <= ${to}
        AND t.is_deleted = false
      GROUP BY 1, 2, 3
    `),
      this.prisma.$queryRaw<BucketRow[]>(Prisma.sql`
      SELECT to_char(generate_series(
               date_trunc('day', (${from}::timestamptz AT TIME ZONE ${TZ})),
               date_trunc('day', (${to  }::timestamptz AT TIME ZONE ${TZ})),
               interval '1 day'), 'YYYY-MM-DD') AS bucket
      ORDER BY 1 ASC
    `),
    ]);
    const buckets = axisRows.map((r) => r.bucket);

    // Median daily hours per user, from the fixed baseline (days with hours > 0).
    const baselineByUser = new Map<string, { name: string; hours: number[] }>();
    for (const r of baselineRows) {
      const id = r.user_id ?? 'unknown';
      const e = baselineByUser.get(id) ?? { name: r.user_name ?? 'Unknown', hours: [] };
      if (r.user_name) e.name = r.user_name;
      if (r.hours > 0) e.hours.push(r.hours);
      baselineByUser.set(id, e);
    }
    const median = (xs: number[]): number => {
      if (!xs.length) return 0;
      const s = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    };
    const medians = new Map<string, number>();
    for (const [id, e] of baselineByUser) medians.set(id, median(e.hours));

    // Display hours per user/day.
    const displayByUser = new Map<string, { name: string; days: Map<string, number> }>();
    for (const r of displayRows) {
      const id = r.user_id ?? 'unknown';
      const e = displayByUser.get(id) ?? { name: r.user_name ?? 'Unknown', days: new Map<string, number>() };
      if (r.user_name) e.name = r.user_name;
      // A single user_id can yield multiple rows for one day if user_name drifted
      // across entries (the SQL groups by the resolved name too); re-sum them here.
      e.days.set(r.day, (e.days.get(r.day) ?? 0) + r.hours);
      displayByUser.set(id, e);
    }

    type Rule = 'absolute' | 'relative' | 'both';
    const classify = (hours: number, med: number): Rule | null => {
      const abs = hours > cap;
      const rel = med > 0 && hours > 2 * med && hours >= 4;
      if (abs && rel) return 'both';
      if (abs) return 'absolute';
      if (rel) return 'relative';
      return null;
    };

    // Per-user zero-filled series.
    const users = [...displayByUser.entries()]
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([id, e]) => {
        const med = medians.get(id) ?? 0;
        const points = buckets.map((b) => {
          const hours = e.days.get(b) ?? 0;
          return { date: b, hours, isSpike: classify(hours, med) !== null };
        });
        return { userId: id, userName: e.name, points };
      });

    // Watchlist: every flagged display day, ranked by raw hours desc, top 20.
    type WatchRow = {
      userId: string; userName: string; date: string; hours: number;
      median: number; multiplier: number | null; rule: Rule;
    };
    const watchlist: WatchRow[] = [];
    for (const [id, e] of displayByUser) {
      const med = medians.get(id) ?? 0;
      for (const [day, hours] of e.days) {
        const rule = classify(hours, med);
        if (!rule) continue;
        watchlist.push({
          userId: id, userName: e.name, date: day, hours,
          median: med, multiplier: med > 0 ? hours / med : null, rule,
        });
      }
    }
    watchlist.sort((a, b) => b.hours - a.hours);

    // Resolved user-days drop out of the watchlist unless explicitly requested.
    // One range query (not a big OR); recover YYYY-MM-DD from the @db.Date the
    // same way the notified-enrichment below does.
    const resolutions = await this.prisma.spikeResolution.findMany({
      where: { workspaceId, spikeDate: { gte: new Date(`${buckets[0] ?? '1970-01-01'}T00:00:00.000Z`), lte: new Date(`${buckets[buckets.length - 1] ?? '1970-01-01'}T00:00:00.000Z`) } },
      select: { clickupUserId: true, spikeDate: true },
    });
    const resolvedSet = new Set(
      resolutions.map((r) => `${r.clickupUserId}|${r.spikeDate.toISOString().slice(0, 10)}`),
    );
    const withResolved = watchlist.map((w) => ({ ...w, resolved: resolvedSet.has(`${w.userId}|${w.date}`) }));
    const filtered = includeResolved ? withResolved : withResolved.filter((w) => !w.resolved);
    const watchlistTotal = filtered.length;
    const top = filtered.slice(0, limit);

    // Flag rows the admin has already emailed about (one notice per user-day).
    // Guard the empty case: an empty `OR` would match every row.
    let notifiedSet = new Set<string>();
    if (top.length > 0) {
      const notifs = await this.prisma.spikeNotification.findMany({
        where: {
          workspaceId,
          OR: top.map((w) => ({
            clickupUserId: w.userId,
            spikeDate: new Date(`${w.date}T00:00:00.000Z`),
          })),
        },
        select: { clickupUserId: true, spikeDate: true },
      });
      // spike_notifications.spike_date is @db.Date; @prisma/adapter-pg returns it
      // as UTC midnight, so toISOString().slice(0,10) recovers the same YYYY-MM-DD
      // the watchlist uses (written via `${date}T00:00:00.000Z` on the write path).
      notifiedSet = new Set(
        notifs.map((n) => `${n.clickupUserId}|${n.spikeDate.toISOString().slice(0, 10)}`),
      );
    }
    // `enriched` is WatchRow & { notified }; WatchRow itself stays the pre-enrichment
    // shape used by the watchlist.push above (which has no `notified` yet).
    const enriched = top.map((w) => ({ ...w, notified: notifiedSet.has(`${w.userId}|${w.date}`) }));

    return { cap, watchlist: enriched, watchlistTotal, byUser: { buckets, users } };
  }

  async anomalies(workspaceId: string) {
    const TZ = Prisma.raw("'Asia/Dhaka'");
    type DailyRow = {
      date: string;
      total_cost_cents: bigint;
      median_cost_cents: number;
      multiplier: number;
    };
    type ClientRow = {
      client: string;
      week_cost_cents: bigint;
      baseline_median_cents: number;
      multiplier: number;
    };

    const [dailyRows, clientRows] = await Promise.all([
      this.prisma.$queryRaw<DailyRow[]>(Prisma.sql`
        WITH daily_costs AS (
          -- start_time is UTC-naive: label UTC before the Dhaka conversion (see hourSpikes).
          SELECT date_trunc('day', e.start_time AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}) AS day_local,
                 SUM(e.cost_cents)::bigint AS day_cents
          FROM clickup_time_entries e
          JOIN clickup_tasks t ON e.task_id = t.task_id
          WHERE e.start_time IS NOT NULL
            AND e.workspace_id = ${workspaceId}
            AND e.start_time >= now() - interval '30 days'
            AND t.is_deleted = false
          GROUP BY 1
        ),
        median AS (
          SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY day_cents) AS median_cents
          FROM daily_costs
          WHERE day_cents > 0
        )
        SELECT to_char(d.day_local, 'YYYY-MM-DD')                AS date,
               d.day_cents                                        AS total_cost_cents,
               m.median_cents::float                              AS median_cost_cents,
               (d.day_cents::float / NULLIF(m.median_cents, 0))::float AS multiplier
        FROM daily_costs d, median m
        WHERE d.day_cents > 5000
          AND m.median_cents > 0
          AND d.day_cents > 2 * m.median_cents
        ORDER BY d.day_local DESC
        LIMIT 10
      `),

      this.prisma.$queryRaw<ClientRow[]>(Prisma.sql`
        WITH last_7 AS (
          SELECT t.client, SUM(e.cost_cents)::bigint AS week_cents
          FROM clickup_time_entries e
          JOIN clickup_tasks t ON e.task_id = t.task_id
          WHERE e.start_time IS NOT NULL
            AND e.workspace_id = ${workspaceId}
            AND e.start_time >= now() - interval '7 days'
            AND t.client IS NOT NULL AND t.client <> ''
            AND t.is_deleted = false
          GROUP BY t.client
        ),
        baseline_weeks AS (
          SELECT t.client,
                 (date_trunc('week', (e.start_time AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}) + interval '1 day') - interval '1 day') AS week_local,
                 SUM(e.cost_cents)::bigint AS week_cents
          FROM clickup_time_entries e
          JOIN clickup_tasks t ON e.task_id = t.task_id
          WHERE e.start_time IS NOT NULL
            AND e.workspace_id = ${workspaceId}
            AND e.start_time >= now() - interval '90 days'
            AND e.start_time <  now() - interval '7 days'
            AND t.client IS NOT NULL AND t.client <> ''
            AND t.is_deleted = false
          GROUP BY t.client, 2
        ),
        baseline AS (
          SELECT client,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY week_cents) AS median_week_cents
          FROM baseline_weeks
          WHERE week_cents > 0
          GROUP BY client
        )
        SELECT l.client                                                     AS client,
               l.week_cents                                                  AS week_cost_cents,
               b.median_week_cents::float                                    AS baseline_median_cents,
               (l.week_cents::float / NULLIF(b.median_week_cents, 0))::float AS multiplier
        FROM last_7 l
        JOIN baseline b ON b.client = l.client
        WHERE l.week_cents > 5000
          AND b.median_week_cents > 0
          AND l.week_cents > 2 * b.median_week_cents
        ORDER BY multiplier DESC
        LIMIT 10
      `),
    ]);

    return {
      dailySpikes: dailyRows.map(r => ({
        date: r.date,
        totalCostAud: Number(r.total_cost_cents) / 100,
        medianAud: Number(r.median_cost_cents) / 100,
        multiplier: Number(r.multiplier),
      })),
      clientSpikes: clientRows.map(r => ({
        client: r.client,
        lastWeekCostAud: Number(r.week_cost_cents) / 100,
        baselineMedianAud: Number(r.baseline_median_cents) / 100,
        multiplier: Number(r.multiplier),
      })),
    };
  }
}
