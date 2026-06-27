import { SummaryFactsService } from "./summary-facts.service";
import { PrismaService } from "../prisma/prisma.service";

/** Minimal Prisma test double; each test wires only the surfaces it exercises. */
function makePrisma(overrides: Record<string, unknown>): PrismaService {
  return overrides as unknown as PrismaService;
}

describe("SummaryFactsService.roster", () => {
  it("aggregates per assignee with open/closed split + top-3 components (defensive split)", async () => {
    const tasks = [
      // Sarah: 2 tasks (1 open, 1 closed), components Backlog x2
      { assigneesNames: "Sarah, Tom", assigneesEmails: "s@x.com, t@x.com", listName: "Backlog", folderName: null, tags: null, closedDate: null },
      { assigneesNames: "Sarah", assigneesEmails: "s@x.com", listName: "Backlog", folderName: null, tags: null, closedDate: new Date("2026-06-01") },
      // Tom: also on a Reporting task (closed)
      { assigneesNames: "Tom", assigneesEmails: "t@x.com", listName: "Reporting", folderName: null, tags: null, closedDate: new Date("2026-06-02") },
      // Unassigned → ignored
      { assigneesNames: null, assigneesEmails: null, listName: "X", folderName: null, tags: null, closedDate: null },
    ];
    const prisma = makePrisma({ clickupTask: { findMany: jest.fn().mockResolvedValue(tasks) } });
    const svc = new SummaryFactsService(prisma);

    const roster = await svc.roster("ws1");

    expect(roster).toHaveLength(2);
    const sarah = roster.find((r) => r.name === "Sarah")!;
    expect(sarah).toMatchObject({ email: "s@x.com", taskCount: 2, openCount: 1, closedCount: 1 });
    expect(sarah.topComponents).toEqual([{ component: "Backlog", taskCount: 2 }]);
    const tom = roster.find((r) => r.name === "Tom")!;
    expect(tom).toMatchObject({ taskCount: 2, openCount: 1, closedCount: 1 });
    expect(tom.topComponents).toHaveLength(2); // Backlog + Reporting
    // Sorted by taskCount desc (tie → name asc: Sarah before Tom).
    expect(roster.map((r) => r.name)).toEqual(["Sarah", "Tom"]);
  });
});

describe("SummaryFactsService.components", () => {
  it("coerces BigInt counts and maps to {component, taskCount}", async () => {
    const $queryRaw = jest.fn().mockResolvedValue([
      { component: "Backlog", count: 12n },
      { component: "Reporting", count: 5n },
    ]);
    const svc = new SummaryFactsService(makePrisma({ $queryRaw }));
    expect(await svc.components("ws1")).toEqual([
      { component: "Backlog", taskCount: 12 },
      { component: "Reporting", taskCount: 5 },
    ]);
  });
});

describe("SummaryFactsService.throughput", () => {
  const now = new Date("2026-06-28T00:00:00Z");

  it("merges week rows, coerces totals, and rounds median Decimal", async () => {
    const $queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ week: "2026-06-22", count: 4n }]) // created
      .mockResolvedValueOnce([{ week: "2026-06-15", count: 2n }]) // closed
      .mockResolvedValueOnce([{ median: "3.456" }]); // median (Decimal-ish)
    const count = jest
      .fn()
      .mockResolvedValueOnce(7) // openTotal
      .mockResolvedValueOnce(9); // closedTotal
    const svc = new SummaryFactsService(makePrisma({ $queryRaw, clickupTask: { count } }));

    const t = await svc.throughput("ws1", now);
    expect(t.openTotal).toBe(7);
    expect(t.closedTotal).toBe(9);
    expect(t.medianCycleTimeDays).toBe(3.46);
    expect(t.weeks).toHaveLength(12);
    expect(t.weeks.at(-1)).toEqual({ week: "2026-06-22", created: 4, closed: 0 });
    expect(t.weeks.find((w) => w.week === "2026-06-15")).toEqual({ week: "2026-06-15", created: 0, closed: 2 });
  });

  it("returns null median when no closed tasks", async () => {
    const $queryRaw = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ median: null }]);
    const count = jest.fn().mockResolvedValue(0);
    const svc = new SummaryFactsService(makePrisma({ $queryRaw, clickupTask: { count } }));
    const t = await svc.throughput("ws1", now);
    expect(t.medianCycleTimeDays).toBeNull();
  });
});

describe("SummaryFactsService.categories", () => {
  it("maps status/tags/client/dept/sprint group-bys, coercing BigInt", async () => {
    // Promise.all order: status, topTags, client, department, sprint.
    const $queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ label: "open", count: 8n }, { label: "done", count: 4n }])
      .mockResolvedValueOnce([{ label: "bug", count: 6n }])
      .mockResolvedValueOnce([{ label: "Acme", count: 5n }])
      .mockResolvedValueOnce([{ label: "Engineering", count: 7n }])
      .mockResolvedValueOnce([{ label: "S12", count: 3n }]);
    const svc = new SummaryFactsService(makePrisma({ $queryRaw }));

    const c = await svc.categories("ws1");
    expect(c.statusDistribution).toEqual([
      { label: "open", count: 8 },
      { label: "done", count: 4 },
    ]);
    expect(c.topTags).toEqual([{ label: "bug", count: 6 }]);
    expect(c.clients).toEqual([{ label: "Acme", count: 5 }]);
    expect(c.departments).toEqual([{ label: "Engineering", count: 7 }]);
    expect(c.sprints).toEqual([{ label: "S12", count: 3 }]);
  });
});

describe("SummaryFactsService.workload", () => {
  it("sums Decimal hours per user, rounds, and labels", async () => {
    const $queryRaw = jest.fn().mockResolvedValue([
      { user: "Sarah", hours: "12.345" },
      { user: "Tom", hours: 3 },
    ]);
    const svc = new SummaryFactsService(makePrisma({ $queryRaw }));
    expect(await svc.workload("ws1", new Date("2026-06-28T00:00:00Z"))).toEqual([
      { user: "Sarah", hours: 12.35 },
      { user: "Tom", hours: 3 },
    ]);
  });
});

describe("SummaryFactsService.blockers", () => {
  it("counts overdue/stale with samples and a reopened transition count", async () => {
    const count = jest
      .fn()
      .mockResolvedValueOnce(3) // overdueOpen
      .mockResolvedValueOnce(2); // stale
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ taskId: "t1", taskName: "Overdue A" }]) // overdue samples
      .mockResolvedValueOnce([{ taskId: "t2", taskName: "Stale B" }]) // stale samples
      .mockResolvedValueOnce([{ taskId: "t3", taskName: "Reopened C" }]); // reopened name lookup
    const $queryRaw = jest.fn().mockResolvedValue([{ taskId: "t3", count: 2n }]);
    const svc = new SummaryFactsService(makePrisma({ clickupTask: { count, findMany }, $queryRaw }));

    const b = await svc.blockers("ws1", new Date("2026-06-28T00:00:00Z"));
    expect(b.overdueOpen).toEqual({ count: 3, samples: [{ taskId: "t1", taskName: "Overdue A" }] });
    expect(b.stale).toEqual({ count: 2, samples: [{ taskId: "t2", taskName: "Stale B" }] });
    expect(b.reopened).toEqual({ count: 2, samples: [{ taskId: "t3", taskName: "Reopened C" }] });
  });

  it("degrades reopened to 0 when the events query throws (thin/odd shape)", async () => {
    const count = jest.fn().mockResolvedValue(0);
    const findMany = jest.fn().mockResolvedValue([]);
    const $queryRaw = jest.fn().mockRejectedValue(new Error("no such column"));
    const svc = new SummaryFactsService(makePrisma({ clickupTask: { count, findMany }, $queryRaw }));
    const b = await svc.blockers("ws1", new Date());
    expect(b.reopened).toEqual({ count: 0, samples: [] });
  });
});

describe("SummaryFactsService.coverage", () => {
  it("computes comment-coverage % and ISO date range", async () => {
    const count = jest
      .fn()
      .mockResolvedValueOnce(200) // totalTasks
      .mockResolvedValueOnce(50); // withComments
    const kbCount = jest.fn().mockResolvedValue(180); // embeddedCount
    const aggregate = jest.fn().mockResolvedValue({
      _min: { createdDate: new Date("2023-01-15T00:00:00Z") },
      _max: { createdDate: new Date("2026-06-20T00:00:00Z") },
    });
    const svc = new SummaryFactsService(
      makePrisma({ clickupTask: { count, aggregate }, kbChunk: { count: kbCount } }),
    );
    const c = await svc.coverage("ws1");
    expect(c.totalTasks).toBe(200);
    expect(c.embeddedCount).toBe(180);
    expect(c.commentCoveragePct).toBe(25);
    expect(c.dateRange.earliest).toBe("2023-01-15T00:00:00.000Z");
    expect(c.dateRange.latest).toBe("2026-06-20T00:00:00.000Z");
  });
});

describe("SummaryFactsService.sampleTitles", () => {
  it("dedupes recent + top-component titles and caps at limit", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([
        { taskId: "a", taskName: "Recent 1" },
        { taskId: "b", taskName: "Recent 2" },
      ])
      .mockResolvedValueOnce([
        { taskId: "b", taskName: "Recent 2" }, // dup → dropped
        { taskId: "c", taskName: "Component 1" },
      ]);
    const svc = new SummaryFactsService(makePrisma({ clickupTask: { findMany } }));
    expect(await svc.sampleTitles("ws1", 50)).toEqual(["Recent 1", "Recent 2", "Component 1"]);
  });
});
