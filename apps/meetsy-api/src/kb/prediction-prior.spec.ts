import {
  qualifying,
  aggregatePrior,
  cycleDaysPercentile,
  firstAssignee,
  addDays,
  SIM_FLOOR,
  MIN_QUALIFYING,
  type Neighbour,
} from "./prediction-prior";

function nb(over: Partial<Neighbour>): Neighbour {
  return {
    taskId: "t", sim: 0.8, client: null, sprint: null, assignee: null,
    estimation: null, createdDate: null, closedDate: null, ...over,
  };
}

describe("prediction-prior (echo-trap guards)", () => {
  it("qualifying() drops neighbours below the similarity floor", () => {
    const ns = [nb({ sim: 0.9 }), nb({ sim: SIM_FLOOR }), nb({ sim: 0.49 }), nb({ sim: 0.2 })];
    expect(qualifying(ns)).toHaveLength(2); // 0.9 and exactly-floor
  });

  describe("aggregatePrior", () => {
    it("returns the similarity-weighted modal value with support + share + candidates", () => {
      const ns = [
        nb({ sim: 0.9, client: "Energy Reporting" }),
        nb({ sim: 0.8, client: "Energy Reporting" }),
        nb({ sim: 0.85, client: "AIT" }),
      ];
      const p = aggregatePrior(ns, (n) => n.client)!;
      expect(p.top).toBe("Energy Reporting");
      expect(p.support).toBe(2);
      expect(p.share).toBeGreaterThan(0.5);
      expect(p.candidates.map((c) => c.value).sort()).toEqual(["AIT", "Energy Reporting"]);
    });
    it("returns null when no qualifying neighbour has a value", () => {
      expect(aggregatePrior([nb({ client: null }), nb({ client: "" })], (n) => n.client)).toBeNull();
    });
    it("a MINORITY value remains a candidate (so the LLM clamp can pick it)", () => {
      const ns = [
        nb({ sim: 0.9, client: "Nifty AI" }), nb({ sim: 0.9, client: "Nifty AI" }),
        nb({ sim: 0.9, client: "Nifty AI" }), nb({ sim: 0.6, client: "AIT" }),
      ];
      const p = aggregatePrior(ns, (n) => n.client)!;
      expect(p.top).toBe("Nifty AI"); // modal echoes the majority...
      expect(p.candidates.find((c) => c.value === "AIT")).toBeTruthy(); // ...but AIT is selectable
    });
  });

  describe("cycleDaysPercentile", () => {
    it("returns null with fewer than MIN_QUALIFYING closed neighbours", () => {
      const ns = Array.from({ length: MIN_QUALIFYING - 1 }, () =>
        nb({ createdDate: new Date("2026-01-01"), closedDate: new Date("2026-01-05") }),
      );
      expect(cycleDaysPercentile(ns)).toBeNull();
    });
    it("computes the p80 cycle in days over closed neighbours", () => {
      const mk = (d: number) => nb({ createdDate: new Date("2026-01-01T00:00:00Z"), closedDate: new Date(Date.UTC(2026, 0, 1 + d)) });
      const ns = [mk(1), mk(2), mk(3), mk(4), mk(10)];
      expect(cycleDaysPercentile(ns, 0.8)).toBe(4); // 80th percentile of [1,2,3,4,10]
    });
    it("ignores neighbours without both dates", () => {
      const ns = [nb({ createdDate: new Date("2026-01-01") }), nb({}), nb({})];
      expect(cycleDaysPercentile(ns)).toBeNull();
    });
  });

  it("firstAssignee takes the first of a comma-joined list", () => {
    expect(firstAssignee("Rashedul Hasan, Ahmad")).toBe("Rashedul Hasan");
    expect(firstAssignee(null)).toBeNull();
  });

  it("addDays advances a UTC date", () => {
    expect(addDays(new Date("2026-06-28T00:00:00Z"), 5).toISOString().slice(0, 10)).toBe("2026-07-03");
  });
});
