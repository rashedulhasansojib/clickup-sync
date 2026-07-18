import { BadRequestException } from "@nestjs/common";
import { KbTasksService } from "./kb-tasks.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * v2 Phase 4 (PR-P) — `GET /kb/tasks` returns embedded ClickUp tasks in the KB,
 * keyset-paged newest-first with `?filter` narrowing. Prisma raw queries are
 * exercised via a $queryRaw jest mock; SQL correctness is the orchestrator's
 * job to verify live (Prisma's tagged template hides the interpolated params
 * from the mock — we assert on call count + returned page shape).
 */
describe("KbTasksService.list", () => {
  const WS = "ws1";

  function makePrisma(pages: Array<Array<Record<string, unknown>>>, totals: number[]) {
    // The service issues one paged query + one COUNT per call, in that order.
    // We alternate the responses accordingly.
    const $queryRaw = jest.fn();
    for (let i = 0; i < pages.length; i++) {
      $queryRaw
        .mockResolvedValueOnce(pages[i])
        .mockResolvedValueOnce([{ n: BigInt(totals[i] ?? pages[i].length) }]);
    }
    return { $queryRaw } as unknown as PrismaService;
  }

  function row(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      task_id: "t1",
      task_name: "Task 1",
      url: "http://cu/1",
      status: "open",
      client: null,
      assignees_names: "Alice",
      updated_date: new Date("2026-07-01T12:00:00Z"),
      chunk_count: 3n,
      ...overrides,
    };
  }

  it("returns the first page and a next cursor when more rows exist", async () => {
    // Seed 51 rows for a limit=50 request — the peek row triggers pagination.
    const rows = Array.from({ length: 51 }, (_, i) =>
      row({
        task_id: `t${i + 1}`,
        task_name: `Task ${i + 1}`,
        updated_date: new Date(Date.UTC(2026, 6, 20 - i, 12, 0)),
      }),
    );
    const svc = new KbTasksService(makePrisma([rows], [51]));

    const page = await svc.list(WS, {});
    expect(page.tasks).toHaveLength(50);
    expect(page.total).toBe(51);
    expect(page.nextCursor).not.toBeNull();
    expect(page.tasks[0].taskId).toBe("t1");
    expect(page.tasks[0].chunkCount).toBe(3);
  });

  it("returns nextCursor=null when the page is the last", async () => {
    const rows = [row({ task_id: "t1" }), row({ task_id: "t2" })];
    const svc = new KbTasksService(makePrisma([rows], [2]));

    const page = await svc.list(WS, {});
    expect(page.nextCursor).toBeNull();
    expect(page.tasks).toHaveLength(2);
    expect(page.total).toBe(2);
  });

  it("clamps limit above MAX (100) and below MIN (1)", async () => {
    const svc = new KbTasksService(makePrisma([[row()], [row()]], [1, 1]));

    // limit=1000 → clamped to 100 (+1 peek = 101); we only assert the call happened.
    await svc.list(WS, { limit: 1000 });
    await svc.list(WS, { limit: 0 });
    // Two calls per list() (page + count) = 4 total.
    expect(((svc as unknown as { prisma: { $queryRaw: jest.Mock } }).prisma.$queryRaw)).toHaveBeenCalledTimes(4);
  });

  it("returns an ISO string for updatedDate and null when the mirror row has none", async () => {
    const rows = [
      row({ task_id: "t1", updated_date: new Date("2026-07-15T10:00:00Z") }),
      row({ task_id: "t2", updated_date: null }),
    ];
    const svc = new KbTasksService(makePrisma([rows], [2]));

    const page = await svc.list(WS, {});
    expect(page.tasks[0].updatedDate).toBe("2026-07-15T10:00:00.000Z");
    expect(page.tasks[1].updatedDate).toBeNull();
  });

  it("throws BadRequestException on a malformed cursor", async () => {
    // No prisma calls should be made — the decode throws first.
    const svc = new KbTasksService({ $queryRaw: jest.fn() } as unknown as PrismaService);
    await expect(svc.list(WS, { cursor: "%%%not-base64%%%" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("throws BadRequestException on a cursor whose JSON is missing `t`", async () => {
    // base64url of `{"u":null}` — well-formed JSON but not the cursor shape.
    const bogus = Buffer.from(JSON.stringify({ u: null }), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const svc = new KbTasksService({ $queryRaw: jest.fn() } as unknown as PrismaService);
    await expect(svc.list(WS, { cursor: bogus })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("round-trips: decoding the returned nextCursor yields the last row's (updated, taskId)", async () => {
    // A peek-triggering seed of 3 rows for limit=2.
    const rows = [
      row({ task_id: "t1", updated_date: new Date("2026-07-15T10:00:00Z") }),
      row({ task_id: "t2", updated_date: new Date("2026-07-14T10:00:00Z") }),
      row({ task_id: "t3", updated_date: new Date("2026-07-13T10:00:00Z") }),
    ];
    const svc = new KbTasksService(makePrisma([rows], [3]));

    const page = await svc.list(WS, { limit: 2 });
    expect(page.tasks).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();

    const decoded = JSON.parse(
      Buffer.from(page.nextCursor!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf8",
      ),
    );
    // The next cursor points at the LAST row of the returned page (t2), not the peek row.
    expect(decoded).toEqual({ u: "2026-07-14T10:00:00.000Z", t: "t2" });
  });
});
