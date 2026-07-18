import { aggregateField, nudgeFor, type FieldRecord } from "./learning-aggregate";

function rec(over: Partial<FieldRecord>): FieldRecord {
  return { predicted: "A", confirmed: "B", unresolved: false, nudgeShown: null, nudgeAccepted: false, ...over };
}

describe("learning-aggregate", () => {
  describe("the gate (≥3 corrections AND ≥60% agreement)", () => {
    it("FIRES at 3 consistent organic corrections", () => {
      const agg = aggregateField("assignee", [rec({}), rec({}), rec({})]);
      const c = agg.corrections.find((x) => x.predicted === "A" && x.confirmed === "B")!;
      expect(c.count).toBe(3);
      expect(c.gatePassed).toBe(true);
    });

    it("does NOT fire at 2 corrections (sparse)", () => {
      const agg = aggregateField("assignee", [rec({}), rec({})]);
      expect(agg.corrections.every((c) => !c.gatePassed)).toBe(true);
    });

    it("does NOT fire on a conflicting 50/50 split (agreement < 60%)", () => {
      // A→B ×3 and A→C ×3 ⇒ each agreement 0.5.
      const agg = aggregateField("assignee", [
        rec({ confirmed: "B" }), rec({ confirmed: "B" }), rec({ confirmed: "B" }),
        rec({ confirmed: "C" }), rec({ confirmed: "C" }), rec({ confirmed: "C" }),
      ]);
      expect(agg.corrections.every((c) => !c.gatePassed)).toBe(true);
    });

    it("FIRES at 4-of-5 (80% ≥ 60%) toward the dominant value", () => {
      const agg = aggregateField("assignee", [
        rec({ confirmed: "B" }), rec({ confirmed: "B" }), rec({ confirmed: "B" }), rec({ confirmed: "B" }),
        rec({ confirmed: "C" }),
      ]);
      const b = agg.corrections.find((c) => c.confirmed === "B")!;
      const c = agg.corrections.find((c) => c.confirmed === "C")!;
      expect(b.gatePassed).toBe(true);
      expect(c.gatePassed).toBe(false);
    });
  });

  it("ORGANIC-only: corrections where a nudge was shown do NOT teach the gate (no self-reinforcement)", () => {
    // 3 corrections A→B, but all were loop-induced (nudgeShown set) ⇒ not counted.
    const agg = aggregateField("assignee", [
      rec({ nudgeShown: "B", nudgeAccepted: true }),
      rec({ nudgeShown: "B", nudgeAccepted: true }),
      rec({ nudgeShown: "B", nudgeAccepted: true }),
    ]);
    expect(agg.corrections).toHaveLength(0);
  });

  it("an ABSTAINED prediction (predicted=null) is not a correction and not a raw sample", () => {
    const agg = aggregateField("assignee", [rec({ predicted: null, confirmed: "B" })]);
    expect(agg.corrections).toHaveLength(0);
    expect(agg.rawSample).toBe(0);
  });

  it("reports raw-override and nudge-acceptance as SEPARATE metrics", () => {
    const agg = aggregateField("assignee", [
      rec({ predicted: "A", confirmed: "A" }), // agreed (not an override)
      rec({ predicted: "A", confirmed: "B" }), // raw override
      rec({ predicted: "A", confirmed: "B", nudgeShown: "B", nudgeAccepted: true }), // nudge accepted
      rec({ predicted: "A", confirmed: "C", nudgeShown: "B", nudgeAccepted: false }), // nudge rejected
    ]);
    expect(agg.rawSample).toBe(4);
    expect(agg.rawOverrideRate).toBe(0.75); // 3 of 4 differ from raw prediction
    expect(agg.nudgeSample).toBe(2);
    expect(agg.nudgeAcceptanceRate).toBe(0.5); // 1 of 2 nudges accepted
  });

  it("counts unresolved confirmed values (a resolution miss ≠ sparse data)", () => {
    const agg = aggregateField("assignee", [rec({ unresolved: true, confirmed: null }), rec({})]);
    expect(agg.unresolved).toBe(1);
  });

  describe("nudgeFor", () => {
    it("returns the gated correction for a matching prediction", () => {
      const agg = aggregateField("assignee", [rec({}), rec({}), rec({})]);
      expect(nudgeFor(agg, "A")?.confirmed).toBe("B");
    });
    it("returns null below the gate or for a non-matching prediction", () => {
      expect(nudgeFor(aggregateField("assignee", [rec({}), rec({})]), "A")).toBeNull();
      expect(nudgeFor(aggregateField("assignee", [rec({}), rec({}), rec({})]), "Z")).toBeNull();
    });
  });
});
