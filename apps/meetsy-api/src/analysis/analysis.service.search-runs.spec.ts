import { BadRequestException } from "@nestjs/common";
import { AnalysisService } from "./analysis.service";

/**
 * v2 Phase 1 — full-text search over meeting title + transcript, exposed at
 * GET /workspaces/:id/runs/search. The tsvector column is DB-only (Prisma
 * can't model it), so the service uses `$queryRaw` for the WHERE clause;
 * these tests exercise the shape of the result mapping + the guard rails,
 * NOT the SQL match itself (that's covered by an integration test against a
 * live DB — the migration test in §9.3 of the design spec).
 */
describe("AnalysisService — searchRuns", () => {
  const WS = "ws_default";

  function makeService(opts: {
    rawRows: Array<Record<string, unknown>>;
    total: number;
    pushRows?: Array<Record<string, unknown>>;
    pushConfig?: unknown;
  }) {
    const queryRaw = jest
      .fn()
      // First call returns the page rows, second returns the count row.
      .mockResolvedValueOnce(opts.rawRows)
      .mockResolvedValueOnce([{ count: BigInt(opts.total) }]);

    const taskPushFindMany = jest.fn().mockResolvedValue(opts.pushRows ?? []);
    const workspacePushConfigFindUnique = jest
      .fn()
      .mockResolvedValue(opts.pushConfig ?? null);

    const prisma = {
      $queryRaw: queryRaw,
      taskPush: { findMany: taskPushFindMany },
      workspacePushConfig: { findUnique: workspacePushConfigFindUnique },
    };
    const workspaces = { resolve: jest.fn() };
    const service = new AnalysisService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      workspaces as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, queryRaw, taskPushFindMany };
  }

  function makeRawRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "run_1",
      meeting_id: "mtg_1",
      status: "completed",
      result: {
        people: [{ participant: {}, tasks: [{ id: "t1" }, { id: "t2" }] }],
        unassignedTasks: [{ id: "t3" }],
      },
      created_at: new Date("2026-07-15T00:00:00Z"),
      meeting_title: "OAuth planning",
      meeting_date: new Date("2026-07-14T00:00:00Z"),
      rank: 0.5,
      ...overrides,
    };
  }

  it("shapes each raw row into a RunListItem and preserves rank/recency order from the SQL", async () => {
    const rows = [
      makeRawRow({ id: "run_a", rank: 0.9 }),
      makeRawRow({ id: "run_b", rank: 0.4, status: "queued", result: null }),
    ];
    const { service, queryRaw } = makeService({ rawRows: rows, total: 2 });

    const view = await service.searchRuns(WS, {
      q: "oauth",
      limit: 20,
      offset: 0,
    });

    expect(view.total).toBe(2);
    expect(view.items).toHaveLength(2);
    expect(view.items[0]!.id).toBe("run_a");
    expect(view.items[0]!.meetingTitle).toBe("OAuth planning");
    expect(view.items[0]!.taskCount).toBe(3);
    expect(view.items[1]!.id).toBe("run_b");
    // Queued rows carry null pushStatus (nothing to push yet).
    expect(view.items[1]!.pushStatus).toBeNull();
    // The SQL branch is used, not Prisma's typed findMany.
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("throws BadRequest when q is empty or whitespace (defense-in-depth after the controller trim)", async () => {
    const { service } = makeService({ rawRows: [], total: 0 });
    await expect(
      service.searchRuns(WS, { q: "   ", limit: 20, offset: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.searchRuns(WS, { q: "", limit: 20, offset: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("returns 0 items + total when no rows match", async () => {
    const { service } = makeService({ rawRows: [], total: 0 });
    const view = await service.searchRuns(WS, {
      q: "nomatchesatall",
      limit: 20,
      offset: 0,
    });
    expect(view.items).toEqual([]);
    expect(view.total).toBe(0);
    expect(view.limit).toBe(20);
    expect(view.offset).toBe(0);
  });

  it("coerces the BigInt count from Postgres into a plain number for the response", async () => {
    // Postgres COUNT(*) is a bigint; the service Number()-coerces it so the
    // Zod RunListViewSchema (which expects `number`) accepts the shape.
    const { service } = makeService({
      rawRows: [makeRawRow()],
      total: 12345,
    });
    const view = await service.searchRuns(WS, {
      q: "planning",
      limit: 20,
      offset: 0,
    });
    expect(typeof view.total).toBe("number");
    expect(view.total).toBe(12345);
  });
});
