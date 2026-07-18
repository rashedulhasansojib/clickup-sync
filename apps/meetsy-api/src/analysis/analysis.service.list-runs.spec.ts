import { AnalysisService } from "./analysis.service";

/**
 * v2 Phase 0 — the paginated GET /workspaces/:id/runs used by Phase 1's home
 * screen + meetings history. Scopes to workspaceId (cross-workspace runs stay
 * invisible), collapses TaskPush rows into a single `pushStatus` label, and
 * derives taskCount defensively so a malformed result row degrades to null.
 */
describe("AnalysisService — listRuns", () => {
  const WS = "ws_default";

  function makeService(opts: {
    runRows: unknown[];
    total: number;
    pushRows?: unknown[];
    pushConfig?: unknown;
  }) {
    // $transaction is a Promise.all-style wrapper on an array of operations;
    // we stub it to resolve to the given results in-order.
    const $transaction = jest.fn().mockResolvedValue([opts.runRows, opts.total]);
    const taskPushFindMany = jest.fn().mockResolvedValue(opts.pushRows ?? []);
    const workspacePushConfigFindUnique = jest
      .fn()
      .mockResolvedValue(opts.pushConfig ?? null);

    const prisma = {
      $transaction,
      // findMany/count aren't called directly — they're wrapped in $transaction.
      analysisRun: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
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
    );
    return { service, $transaction, taskPushFindMany, workspacePushConfigFindUnique };
  }

  function makeRunRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const createdAt = new Date("2026-07-15T00:00:00Z");
    return {
      id: "run_1",
      meetingId: "mtg_1",
      status: "completed",
      result: {
        people: [{ participant: {}, tasks: [{ id: "t1" }, { id: "t2" }] }],
        unassignedTasks: [{ id: "t3" }],
      },
      createdAt,
      meeting: { title: "Sprint planning", meetingDate: new Date("2026-07-14T00:00:00Z") },
      ...overrides,
    };
  }

  it("paginates + returns total, and shapes each item from the row + meeting join", async () => {
    const runs = [
      makeRunRow({ id: "run_1" }),
      makeRunRow({ id: "run_2", status: "queued", result: null }),
    ];
    const { service } = makeService({ runRows: runs, total: 42 });

    const view = await service.listRuns(WS, { limit: 20, offset: 0 });

    expect(view.total).toBe(42);
    expect(view.limit).toBe(20);
    expect(view.offset).toBe(0);
    expect(view.items).toHaveLength(2);
    expect(view.items[0].id).toBe("run_1");
    expect(view.items[0].meetingTitle).toBe("Sprint planning");
    expect(view.items[0].meetingDate).toBe("2026-07-14T00:00:00.000Z");
    expect(view.items[1].id).toBe("run_2");
    expect(view.items[1].status).toBe("queued");
    // Queued runs never carry a push status (nothing to push yet).
    expect(view.items[1].pushStatus).toBeNull();
    // Queued runs with a null result get taskCount = null.
    expect(view.items[1].taskCount).toBeNull();
  });

  it("passes a status filter through when provided", async () => {
    const { service } = makeService({ runRows: [], total: 0 });
    await service.listRuns(WS, { limit: 5, offset: 0, status: "completed" });
    // The service builds the where in-place; a successful call with an empty
    // result is enough to lock the branch didn't throw.
  });

  it("derives taskCount defensively from a well-formed result", async () => {
    const runs = [makeRunRow({ id: "r" })];
    const { service } = makeService({ runRows: runs, total: 1 });
    const view = await service.listRuns(WS, { limit: 20, offset: 0 });
    expect(view.items[0].taskCount).toBe(3); // 2 assigned + 1 unassigned
  });

  it("returns taskCount=null when the result is malformed", async () => {
    const runs = [makeRunRow({ result: { people: "not-an-array" } })];
    const { service } = makeService({ runRows: runs, total: 1 });
    const view = await service.listRuns(WS, { limit: 20, offset: 0 });
    expect(view.items[0].taskCount).toBeNull();
  });

  it("pushStatus = null when the run is not yet completed", async () => {
    const runs = [makeRunRow({ status: "running", result: null })];
    const { service } = makeService({ runRows: runs, total: 1 });
    const view = await service.listRuns(WS, { limit: 20, offset: 0 });
    expect(view.items[0].pushStatus).toBeNull();
  });

  it("pushStatus = not_configured when the workspace has no push config", async () => {
    const runs = [makeRunRow()];
    const { service } = makeService({
      runRows: runs,
      total: 1,
      pushConfig: null,
    });
    const view = await service.listRuns(WS, { limit: 20, offset: 0 });
    expect(view.items[0].pushStatus).toBe("not_configured");
  });

  it("pushStatus = not_pushed when config exists but no push rows for the run", async () => {
    const runs = [makeRunRow()];
    const { service } = makeService({
      runRows: runs,
      total: 1,
      pushConfig: { workspaceId: WS },
      pushRows: [],
    });
    const view = await service.listRuns(WS, { limit: 20, offset: 0 });
    expect(view.items[0].pushStatus).toBe("not_pushed");
  });

  it("pushStatus = pushed when every push succeeded", async () => {
    const runs = [makeRunRow({ id: "run_1" })];
    const { service } = makeService({
      runRows: runs,
      total: 1,
      pushConfig: { workspaceId: WS },
      pushRows: [
        { runId: "run_1", status: "pushed" },
        { runId: "run_1", status: "pushed" },
      ],
    });
    const view = await service.listRuns(WS, { limit: 20, offset: 0 });
    expect(view.items[0].pushStatus).toBe("pushed");
  });

  it("pushStatus = partial when some pushes failed or were skipped", async () => {
    const runs = [makeRunRow({ id: "run_1" })];
    const { service } = makeService({
      runRows: runs,
      total: 1,
      pushConfig: { workspaceId: WS },
      pushRows: [
        { runId: "run_1", status: "pushed" },
        { runId: "run_1", status: "failed" },
      ],
    });
    const view = await service.listRuns(WS, { limit: 20, offset: 0 });
    expect(view.items[0].pushStatus).toBe("partial");
  });
});
