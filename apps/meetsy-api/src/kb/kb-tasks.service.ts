import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/** One row of GET /kb/tasks — a ClickUp task with at least one embedded chunk. */
export interface KbTaskRow {
  taskId: string;
  taskName: string;
  url: string | null;
  status: string | null;
  client: string | null;
  assigneesNames: string | null;
  updatedDate: string | null;
  chunkCount: number;
}

export interface KbTasksPage {
  tasks: KbTaskRow[];
  nextCursor: string | null;
  total: number;
}

interface CursorPayload {
  u: string | null;
  t: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_FILTER_LEN = 100;

/** Encode a keyset cursor as opaque base64url. */
function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode the opaque cursor. Throws BadRequestException on malformed / unexpected
 * shape — clients that hand back a v1 cursor after a schema tweak get a hard
 * error instead of silent skew.
 */
function decodeCursor(raw: string): CursorPayload {
  let json: string;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    json = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    throw new BadRequestException("malformed cursor");
  }
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new BadRequestException("malformed cursor");
  }
  if (
    !obj ||
    typeof obj !== "object" ||
    !("t" in obj) ||
    typeof (obj as { t: unknown }).t !== "string" ||
    !("u" in obj) ||
    ((obj as { u: unknown }).u !== null && typeof (obj as { u: unknown }).u !== "string")
  ) {
    throw new BadRequestException("malformed cursor");
  }
  return obj as CursorPayload;
}

/**
 * Paginated list of embedded ClickUp tasks in the KB. Joins `KbChunk` (meetsy)
 * with `public.clickup_tasks`, keyset-paged on `(updated_date DESC NULLS LAST,
 * task_id DESC)` for stability under insert traffic.
 *
 * Runs via `$queryRaw` — Prisma's `groupBy` doesn't compose keyset paging + a
 * distinct chunk count in one round-trip; going raw is both simpler and lets us
 * bind the ILIKE filter through the Prisma tagged template (no injection).
 */
@Injectable()
export class KbTasksService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    workspaceId: string,
    opts: { cursor?: string; filter?: string; limit?: number } = {},
  ): Promise<KbTasksPage> {
    const limit = Math.max(
      1,
      Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    );
    const rawFilter = (opts.filter ?? "").trim().slice(0, MAX_FILTER_LEN);
    const filter = rawFilter.length ? `%${rawFilter}%` : null;

    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    const cursorUpdated = cursor?.u ? new Date(cursor.u) : null;
    const cursorTaskId = cursor?.t ?? null;

    // Fetch one extra row so we can decide whether there's a next page.
    const peek = limit + 1;

    // Filter branches (SQL fragment cache) — Prisma.sql interpolation keeps
    // params bound; empty fragments become no-ops.
    const filterSql =
      filter === null
        ? Prisma.sql`TRUE`
        : Prisma.sql`(ct.task_name ILIKE ${filter} OR ct.client ILIKE ${filter} OR ct.assignees_names ILIKE ${filter})`;

    // Cursor branch: for `updated_date DESC NULLS LAST, task_id DESC`, the
    // "strictly-after" predicate is
    //   (u < cursor_u) OR (u = cursor_u AND t < cursor_t) OR
    //   (cursor_u IS NOT NULL AND u IS NULL) OR
    //   (cursor_u IS NULL AND u IS NULL AND t < cursor_t).
    let cursorSql: Prisma.Sql;
    if (cursor === null) {
      cursorSql = Prisma.sql`TRUE`;
    } else if (cursorUpdated !== null && cursorTaskId !== null) {
      cursorSql = Prisma.sql`(
        ct.updated_date < ${cursorUpdated}
        OR (ct.updated_date = ${cursorUpdated} AND ct.task_id < ${cursorTaskId})
        OR ct.updated_date IS NULL
      )`;
    } else {
      // cursor.u is null → we've paged into the NULL-updated_date tail.
      cursorSql = Prisma.sql`(ct.updated_date IS NULL AND ct.task_id < ${cursorTaskId})`;
    }

    const rows = await this.prisma.$queryRaw<
      Array<{
        task_id: string;
        task_name: string;
        url: string | null;
        status: string | null;
        client: string | null;
        assignees_names: string | null;
        updated_date: Date | null;
        chunk_count: bigint;
      }>
    >(Prisma.sql`
      SELECT ct.task_id, ct.task_name, ct.url, ct.status, ct.client,
             ct.assignees_names, ct.updated_date,
             COUNT(kc.id) AS chunk_count
      FROM "public"."clickup_tasks" ct
      JOIN "meetsy"."KbChunk" kc
        ON kc."sourceType"::text = 'clickup_task'
       AND kc."sourceId" = ct.task_id
      WHERE kc."workspaceId" = ${workspaceId}
        AND ct.is_deleted = false
        AND ${filterSql}
        AND ${cursorSql}
      GROUP BY ct.task_id
      ORDER BY ct.updated_date DESC NULLS LAST, ct.task_id DESC
      LIMIT ${peek}
    `);

    // Total DISTINCT tasks matching the filter (workspace-scoped). No cursor —
    // the total is filter-only. Cheap at Phase 4 scale.
    const totalRows = await this.prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT COUNT(DISTINCT ct.task_id) AS n
      FROM "public"."clickup_tasks" ct
      JOIN "meetsy"."KbChunk" kc
        ON kc."sourceType"::text = 'clickup_task'
       AND kc."sourceId" = ct.task_id
      WHERE kc."workspaceId" = ${workspaceId}
        AND ct.is_deleted = false
        AND ${filterSql}
    `);
    const total = Number(totalRows[0]?.n ?? 0n);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const nextCursor = hasMore
      ? encodeCursor({
          u: page[page.length - 1].updated_date?.toISOString() ?? null,
          t: page[page.length - 1].task_id,
        })
      : null;

    return {
      tasks: page.map((r) => ({
        taskId: r.task_id,
        taskName: r.task_name,
        url: r.url,
        status: r.status,
        client: r.client,
        assigneesNames: r.assignees_names,
        updatedDate: r.updated_date ? r.updated_date.toISOString() : null,
        chunkCount: Number(r.chunk_count),
      })),
      nextCursor,
      total,
    };
  }
}
