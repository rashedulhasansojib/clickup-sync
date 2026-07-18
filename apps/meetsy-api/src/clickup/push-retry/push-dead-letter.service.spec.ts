import { NotFoundException } from "@nestjs/common";
import { PushDeadLetterService } from "./push-dead-letter.service";

/**
 * v2 Phase 2 (PR-I) — the Owner/Admin surface over PushDeadLetter. Unresolved
 * filter is the default (matches the UI's "what needs my attention" mode).
 * Cross-workspace access must 404, not 200-with-empty (leaks existence
 * otherwise).
 */
describe("PushDeadLetterService", () => {
  const ORG = "org_seed";
  const WS = "ws_default";
  const OTHER_WS = "ws_other";
  const USER = "user_admin";

  function makeService(opts: {
    rows?: Array<{
      id: string;
      workspaceId: string;
      runId: string;
      meetsyTaskId: string;
      jobId: string;
      errorMessage: string | null;
      attemptsMade: number;
      failedAt: Date;
      resolvedAt: Date | null;
      resolvedBy: string | null;
    }>;
    total?: number;
    findUnique?: () => Promise<unknown>;
    updateImpl?: () => Promise<{ id: string; resolvedAt: Date }>;
  } = {}) {
    const findMany = jest.fn().mockResolvedValue(opts.rows ?? []);
    const count = jest.fn().mockResolvedValue(opts.total ?? (opts.rows?.length ?? 0));
    const findUnique = jest.fn().mockImplementation(opts.findUnique ?? (async () => null));
    const update = jest.fn().mockImplementation(
      opts.updateImpl ??
        (async () => ({ id: "dl_1", resolvedAt: new Date("2026-07-19T00:00:00Z") })),
    );

    const prisma = {
      $transaction: (queries: unknown[]) => Promise.all(queries),
      pushDeadLetter: { findMany, count, findUnique, update },
    } as never;
    const workspaces = { resolve: jest.fn(async (_org: string, id: string) => id) } as never;

    const service = new PushDeadLetterService(prisma, workspaces);
    return { service, findMany, findUnique, update };
  }

  it("filters to unresolved rows by default", async () => {
    const { service, findMany } = makeService({ rows: [] });
    await service.list(ORG, WS, { limit: 50, offset: 0 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS, resolvedAt: null },
      }),
    );
  });

  it("includes resolved rows when includeResolved is true", async () => {
    const { service, findMany } = makeService({ rows: [] });
    await service.list(ORG, WS, { limit: 50, offset: 0, includeResolved: true });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS },
      }),
    );
  });

  it("serializes ISO dates and total in the response", async () => {
    const failedAt = new Date("2026-07-18T10:00:00Z");
    const { service } = makeService({
      rows: [
        {
          id: "dl_1",
          workspaceId: WS,
          runId: "run_1",
          meetsyTaskId: "t1",
          jobId: "run_1:t1:abc",
          errorMessage: "ClickUp 500",
          attemptsMade: 4,
          failedAt,
          resolvedAt: null,
          resolvedBy: null,
        },
      ],
    });
    const res = await service.list(ORG, WS, { limit: 50, offset: 0 });
    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({
      id: "dl_1",
      failedAt: failedAt.toISOString(),
      resolvedAt: null,
      attemptsMade: 4,
    });
  });

  it("resolve() 404s when the dead-letter belongs to another workspace", async () => {
    const { service } = makeService({
      findUnique: async () => ({
        id: "dl_1",
        workspaceId: OTHER_WS,
      }),
    });
    await expect(
      service.resolve(ORG, WS, "dl_1", USER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("resolve() 404s when the dead-letter doesn't exist", async () => {
    const { service } = makeService({ findUnique: async () => null });
    await expect(
      service.resolve(ORG, WS, "dl_missing", USER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("resolve() marks the row with the caller's userId", async () => {
    const now = new Date("2026-07-19T12:00:00Z");
    const { service, update } = makeService({
      findUnique: async () => ({ id: "dl_1", workspaceId: WS }),
      updateImpl: async () => ({ id: "dl_1", resolvedAt: now }),
    });
    const res = await service.resolve(ORG, WS, "dl_1", USER);
    expect(res).toEqual({ id: "dl_1", resolvedAt: now.toISOString() });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resolvedBy: USER }),
      }),
    );
  });
});
