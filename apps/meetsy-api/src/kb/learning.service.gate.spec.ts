import { LearningService } from "./learning.service";
import { MIN_AGREEMENT, MIN_CORRECTIONS, NEAR_GATE_THRESHOLD } from "./learning-aggregate";

/**
 * v2 Phase 3 (PR-M) — `GET /workspaces/:id/learning/gate` surfaces the loop's
 * thresholds so the /learning page can render them alongside the summary
 * without hardcoding constants on the client side.
 */
describe("LearningService — gate", () => {
  function makeService(tunables?: { minCorrections: number; minAgreement: number }) {
    const prisma = {} as never;
    const cache = {} as never;
    const stream = {} as never;
    // v2 Phase 5 — gate values are per-workspace now, sourced from MlConfigService.
    // Defaults mirror the module constants so the pre-Phase-5 shape is unchanged.
    const mlConfig = {
      forWorkspace: jest.fn().mockResolvedValue({
        tunables: tunables ?? { minCorrections: MIN_CORRECTIONS, minAgreement: MIN_AGREEMENT },
        models: {},
      }),
    } as never;
    return new LearningService(prisma, cache, stream, mlConfig);
  }

  it("returns the loop's thresholds and the learnable fields", async () => {
    const g = await makeService().gate("ws_ignored");
    expect(g).toEqual({
      minCorrections: MIN_CORRECTIONS,
      minAgreement: MIN_AGREEMENT,
      nearGateThreshold: NEAR_GATE_THRESHOLD,
      fields: ["assignee", "sprint"],
    });
  });

  it("v2 Phase 5 — reads per-workspace overrides from MlConfigService", async () => {
    const g = await makeService({ minCorrections: 5, minAgreement: 0.8 }).gate("ws_override");
    expect(g.minCorrections).toBe(5);
    expect(g.minAgreement).toBe(0.8);
    // nearGateThreshold tracks minCorrections - 1 so the UI's "one shy" copy stays honest.
    expect(g.nearGateThreshold).toBe(4);
  });

  it("NEAR_GATE_THRESHOLD is one shy of MIN_CORRECTIONS", () => {
    expect(NEAR_GATE_THRESHOLD).toBe(MIN_CORRECTIONS - 1);
  });
});
