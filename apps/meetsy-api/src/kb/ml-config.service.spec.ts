import { MlConfigService } from "./ml-config.service";
import { DEFAULT_MODELS, DEFAULT_TUNABLES } from "./ml-config.defaults";

/**
 * v2 Phase 0 — the ML-config lookup MUST never break the pipeline. Absent row,
 * malformed row, or DB error → fall back to the hardcoded defaults so the
 * snapshot writer in analysis.processor still records something inspectable.
 */
describe("MlConfigService", () => {
  const WS = "ws_default";

  function makeService(findResult: unknown, opts: { throws?: boolean } = {}) {
    const findUnique = opts.throws
      ? jest.fn().mockRejectedValue(new Error("connection reset"))
      : jest.fn().mockResolvedValue(findResult);
    const prisma = {
      workspaceMlConfig: { findUnique },
    };
    // Phase 5 added a LearningCacheService dep — forWorkspace never touches it,
    // so a bare stub satisfies the type.
    const cache = { invalidate: jest.fn() };
    const service = new MlConfigService(prisma as never, cache as never);
    return { service, findUnique };
  }

  it("returns hardcoded defaults when the workspace has no config row", async () => {
    const { service, findUnique } = makeService(null);

    const cfg = await service.forWorkspace(WS);

    expect(findUnique).toHaveBeenCalledWith({ where: { workspaceId: WS } });
    expect(cfg.tunables.dupFlag).toBe(DEFAULT_TUNABLES.dupFlag);
    expect(cfg.tunables.simFloor).toBe(DEFAULT_TUNABLES.simFloor);
    expect(cfg.models.pipeline.analyze.effort).toBe(DEFAULT_MODELS.pipeline.analyze.effort);
  });

  it("merges a partial DB row over the defaults (leaves untouched keys default)", async () => {
    const row = {
      workspaceId: WS,
      // Only override two tunables; everything else must keep the default.
      tunables: { dupFlag: 0.9, simFloor: 0.6 },
      models: DEFAULT_MODELS,
      updatedBy: null,
    };
    const { service } = makeService(row);

    const cfg = await service.forWorkspace(WS);
    expect(cfg.tunables.dupFlag).toBe(0.9);
    expect(cfg.tunables.simFloor).toBe(0.6);
    // Un-overridden keys carry through from defaults.
    expect(cfg.tunables.rrfK).toBe(DEFAULT_TUNABLES.rrfK);
    expect(cfg.tunables.minCorrections).toBe(DEFAULT_TUNABLES.minCorrections);
  });

  it("falls back to defaults when the DB throws", async () => {
    const { service } = makeService(null, { throws: true });

    const cfg = await service.forWorkspace(WS);
    expect(cfg.tunables.dupFlag).toBe(DEFAULT_TUNABLES.dupFlag);
    expect(cfg.models.narrative.deployment).toBe(DEFAULT_MODELS.narrative.deployment);
  });

  it("falls back to defaults when the row has an unparsable schema", async () => {
    // tunables.dupFlag out of [0,1] — the Zod parse rejects; service should not throw.
    const row = {
      workspaceId: WS,
      tunables: { dupFlag: 5 },
      models: { pipeline: "not-an-object" },
      updatedBy: null,
    };
    const { service } = makeService(row);

    const cfg = await service.forWorkspace(WS);
    expect(cfg.tunables.dupFlag).toBe(DEFAULT_TUNABLES.dupFlag);
  });
});
