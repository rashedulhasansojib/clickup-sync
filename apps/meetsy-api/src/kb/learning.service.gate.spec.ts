import { LearningService } from "./learning.service";
import { MIN_AGREEMENT, MIN_CORRECTIONS, NEAR_GATE_THRESHOLD } from "./learning-aggregate";

/**
 * v2 Phase 3 (PR-M) — `GET /workspaces/:id/learning/gate` surfaces the loop's
 * thresholds so the /learning page can render them alongside the summary
 * without hardcoding constants on the client side.
 */
describe("LearningService — gate", () => {
  function makeService() {
    const prisma = {} as never;
    const cache = {} as never;
    const stream = {} as never;
    return new LearningService(prisma, cache, stream);
  }

  it("returns the loop's thresholds and the learnable fields", () => {
    const g = makeService().gate("ws_ignored");
    expect(g).toEqual({
      minCorrections: MIN_CORRECTIONS,
      minAgreement: MIN_AGREEMENT,
      nearGateThreshold: NEAR_GATE_THRESHOLD,
      fields: ["assignee", "sprint"],
    });
  });

  it("NEAR_GATE_THRESHOLD is one shy of MIN_CORRECTIONS", () => {
    expect(NEAR_GATE_THRESHOLD).toBe(MIN_CORRECTIONS - 1);
  });
});
