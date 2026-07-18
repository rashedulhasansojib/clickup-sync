import { NotFoundException } from "@nestjs/common";
import { PushRetryService } from "./push-retry.service";

/**
 * v2 Phase 2 (PR-I) — PushRetryService fans out one BullMQ job per FAILED
 * TaskPush row, reporting misses/wrong-status/enqueue errors in `skipped`
 * rather than throwing. Ownership check uses the run's orgId (belt-and-braces
 * over the AuthGuard).
 */
describe("PushRetryService", () => {
  const ORG = "org_seed";
  const OTHER_ORG = "org_other";
  const WS = "ws_default";
  const RUN_ID = "run_1";

  function makeService(opts: {
    run?: { id: string; orgId: string } | null;
    pushes?: Array<{ meetsyTaskId: string; status: string }>;
    enqueueImpl?: (data: unknown) => Promise<string>;
  } = {}) {
    const analysisRun = {
      findUnique: jest.fn().mockResolvedValue(
        opts.run === null
          ? null
          : (opts.run ?? { id: RUN_ID, orgId: ORG, workspaceId: WS }),
      ),
    };
    const taskPush = {
      findMany: jest.fn().mockResolvedValue(opts.pushes ?? []),
    };
    const prisma = { analysisRun, taskPush } as never;
    const enqueue =
      opts.enqueueImpl ??
      (async (data: { runId: string; meetsyTaskId: string }) =>
        `${data.runId}:${data.meetsyTaskId}:nonce`);
    const queue = { enqueue: jest.fn(enqueue) } as never;
    const service = new PushRetryService(prisma, queue);
    return { service, prisma, queue };
  }

  it("enqueues one job per failed push when no taskIds filter is given", async () => {
    const { service, queue } = makeService({
      pushes: [
        { meetsyTaskId: "t1", status: "failed" },
        { meetsyTaskId: "t2", status: "failed" },
      ],
    });
    const res = await service.retryFailed(ORG, RUN_ID);
    expect(res.enqueued).toHaveLength(2);
    expect(res.skipped).toHaveLength(0);
    expect((queue as unknown as { enqueue: jest.Mock }).enqueue).toHaveBeenCalledTimes(2);
  });

  it("filters by taskIds, reporting misses as not_found", async () => {
    const { service } = makeService({
      pushes: [{ meetsyTaskId: "t1", status: "failed" }],
    });
    const res = await service.retryFailed(ORG, RUN_ID, ["t1", "t_missing"]);
    expect(res.enqueued).toHaveLength(1);
    expect(res.skipped).toEqual([{ meetsyTaskId: "t_missing", reason: "not_found" }]);
  });

  it("reports non-failed rows as not_failed:<status>, never enqueues them", async () => {
    const { service, queue } = makeService({
      pushes: [
        { meetsyTaskId: "t1", status: "pushed" },
        { meetsyTaskId: "t2", status: "skipped" },
        { meetsyTaskId: "t3", status: "failed" },
      ],
    });
    const res = await service.retryFailed(ORG, RUN_ID);
    expect(res.enqueued).toHaveLength(1);
    expect(res.skipped).toEqual([
      { meetsyTaskId: "t1", reason: "not_failed:pushed" },
      { meetsyTaskId: "t2", reason: "not_failed:skipped" },
    ]);
    expect((queue as unknown as { enqueue: jest.Mock }).enqueue).toHaveBeenCalledTimes(1);
  });

  it("throws NotFoundException when the run doesn't belong to the caller's org", async () => {
    const { service } = makeService({
      run: { id: RUN_ID, orgId: OTHER_ORG },
    });
    await expect(service.retryFailed(ORG, RUN_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws NotFoundException when the run doesn't exist", async () => {
    const { service } = makeService({ run: null });
    await expect(service.retryFailed(ORG, RUN_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("reports an enqueue failure in skipped rather than throwing", async () => {
    const { service } = makeService({
      pushes: [{ meetsyTaskId: "t1", status: "failed" }],
      enqueueImpl: async () => {
        throw new Error("redis down");
      },
    });
    const res = await service.retryFailed(ORG, RUN_ID);
    expect(res.enqueued).toEqual([]);
    expect(res.skipped).toEqual([
      { meetsyTaskId: "t1", reason: "enqueue_failed:redis down" },
    ]);
  });
});
