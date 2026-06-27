import { NarrativeService } from "./narrative.service";
import { AzureOpenAIService } from "../azure/azure-openai.service";
import type { KbFacts } from "./summary.types";

const facts = {
  roster: [{ name: "Sarah", email: null, taskCount: 9, openCount: 4, closedCount: 5, topComponents: [] }],
  components: [{ component: "Backlog", taskCount: 12 }],
  throughput: { weeks: [], openTotal: 4, closedTotal: 5, medianCycleTimeDays: 3.4 },
  categories: { statusDistribution: [], topTags: [], clients: [], departments: [], sprints: [] },
  workload: [],
  blockers: { overdueOpen: { count: 0, samples: [] }, stale: { count: 0, samples: [] }, reopened: { count: 0, samples: [] } },
  coverage: { totalTasks: 9, embeddedCount: 9, dateRange: { earliest: null, latest: null }, commentCoveragePct: 0 },
} satisfies KbFacts;

describe("NarrativeService", () => {
  it("feeds facts + titles to ONE structured call and returns the validated narrative", async () => {
    const structured = jest.fn().mockResolvedValue({ narrative: "This team ships reporting work." });
    const azure = { structured } as unknown as AzureOpenAIService;
    const svc = new NarrativeService(azure);

    const out = await svc.generate(facts, ["Fix Safari chart", "Stripe double-charge"]);

    expect(out).toBe("This team ships reporting work.");
    expect(structured).toHaveBeenCalledTimes(1);
    const opts = structured.mock.calls[0][0];
    // Facts (source of truth) + sampled titles are both in the user prompt.
    expect(opts.user).toContain('"component":"Backlog"');
    expect(opts.user).toContain("Fix Safari chart");
    // The "no new numbers" guard is in the system prompt.
    expect(opts.system.toLowerCase()).toContain("do not invent");
    // Spec: gpt-5.4-mini, low effort.
    expect(opts.deployment).toBe("gpt-5.4-mini");
    expect(opts.reasoningEffort).toBe("low");
  });
});
