import { MIN_CORRECTIONS, NEAR_GATE_THRESHOLD } from "./learning-aggregate";
import { classifyThreshold } from "./learning-stream.service";

/**
 * v2 Phase 3 (PR-N) — `classifyThreshold` is the pure decision at the heart of
 * the near-gate SSE toast: given the post-write organic count, either fire a
 * near-gate event (one shy of the gate), a gate-passed event (the gate itself),
 * or nothing (still building up or already gating for the k-th time).
 */
describe("classifyThreshold", () => {
  it("fires near-gate when the count crosses to NEAR_GATE_THRESHOLD", () => {
    expect(classifyThreshold(NEAR_GATE_THRESHOLD)).toBe("near-gate");
  });

  it("fires gate-passed when the count reaches MIN_CORRECTIONS", () => {
    expect(classifyThreshold(MIN_CORRECTIONS)).toBe("gate-passed");
  });

  it("stays quiet at 1 (still sparse)", () => {
    expect(classifyThreshold(1)).toBeNull();
  });

  it("stays quiet after gating (count = MIN_CORRECTIONS + 1)", () => {
    // The gate already fired; we don't re-fire on every subsequent correction.
    // A future "pattern strengthened" event would be a different `kind`.
    expect(classifyThreshold(MIN_CORRECTIONS + 1)).toBeNull();
  });

  it("stays quiet at 0", () => {
    expect(classifyThreshold(0)).toBeNull();
  });
});
