import { SummaryService } from "./summary.service";
import { SummaryFactsService } from "./summary-facts.service";
import { NarrativeService } from "./narrative.service";
import { PrismaService } from "../prisma/prisma.service";
import type { KbFacts } from "./summary.types";

const FACTS = { roster: [], components: [], throughput: { weeks: [], openTotal: 0, closedTotal: 0, medianCycleTimeDays: null }, categories: { statusDistribution: [], topTags: [], clients: [], departments: [], sprints: [] }, workload: [], blockers: { overdueOpen: { count: 0, samples: [] }, stale: { count: 0, samples: [] }, reopened: { count: 0, samples: [] } }, coverage: { totalTasks: 0, embeddedCount: 100, dateRange: { earliest: null, latest: null }, commentCoveragePct: 0 } } as unknown as KbFacts;

function setup(opts: {
  cached?: { facts: unknown; narrative: string | null; taskCountAtGen: number; generatedAt: Date } | null;
  embedded: number;
  narrative?: () => Promise<string>;
}) {
  const upsert = jest.fn().mockResolvedValue({});
  const prisma = {
    kbSummary: {
      findUnique: jest.fn().mockResolvedValue(opts.cached ?? null),
      upsert,
    },
  } as unknown as PrismaService;

  const computeFacts = jest.fn().mockResolvedValue(FACTS);
  const facts = {
    embeddedCount: jest.fn().mockResolvedValue(opts.embedded),
    computeFacts,
    sampleTitles: jest.fn().mockResolvedValue(["t1", "t2"]),
  } as unknown as SummaryFactsService;

  const generate = jest.fn(opts.narrative ?? (() => Promise.resolve("PROSE")));
  const narrative = { generate } as unknown as NarrativeService;

  const svc = new SummaryService(prisma, facts, narrative);
  return { svc, prisma, upsert, computeFacts, generate };
}

describe("SummaryService.getOrGenerate", () => {
  it("returns the cached card without recomputing when fresh and not refreshed", async () => {
    const generatedAt = new Date("2026-06-20T00:00:00Z");
    const { svc, upsert, computeFacts, generate } = setup({
      embedded: 100,
      cached: { facts: FACTS, narrative: "CACHED", taskCountAtGen: 100, generatedAt },
    });

    const out = await svc.getOrGenerate("ws1", false);

    expect(out.narrative).toBe("CACHED");
    expect(out.generatedAt).toBe(generatedAt.toISOString());
    expect(computeFacts).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("regenerates when the embedded count moved materially", async () => {
    const { svc, upsert, computeFacts, generate } = setup({
      embedded: 130, // cached at 100 → stale
      cached: { facts: FACTS, narrative: "CACHED", taskCountAtGen: 100, generatedAt: new Date() },
    });

    const out = await svc.getOrGenerate("ws1", false);

    expect(computeFacts).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].create.taskCountAtGen).toBe(130);
    expect(out.narrative).toBe("PROSE");
  });

  it("regenerates on explicit refresh even when fresh", async () => {
    const { svc, computeFacts } = setup({
      embedded: 100,
      cached: { facts: FACTS, narrative: "CACHED", taskCountAtGen: 100, generatedAt: new Date() },
    });
    await svc.getOrGenerate("ws1", true);
    expect(computeFacts).toHaveBeenCalledTimes(1);
  });

  it("generates fresh when no cache exists", async () => {
    const { svc, computeFacts, upsert } = setup({ embedded: 10, cached: null });
    const out = await svc.getOrGenerate("ws1", false);
    expect(computeFacts).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalled();
    expect(out.narrative).toBe("PROSE");
  });

  it("degrades to facts-only (narrative null) when the LLM call fails", async () => {
    const { svc, upsert } = setup({
      embedded: 10,
      cached: null,
      narrative: () => Promise.reject(new Error("Azure down")),
    });
    const out = await svc.getOrGenerate("ws1", false);
    expect(out.narrative).toBeNull();
    expect(out.facts).toEqual(FACTS);
    // Facts-only card is still persisted.
    expect(upsert.mock.calls[0][0].create.narrative).toBeNull();
  });
});
