import { LearningService } from "./learning.service";

/**
 * v2 Phase 3 (PR-M) — `LearningService.snapshot()` is read-through-cached: a
 * hit returns the stored value immediately without hitting Postgres; a miss
 * falls through to the DB scan then writes back before returning. The push
 * flow invalidates the cache via `LearningService.invalidateCache` after a
 * FieldOverride write.
 */
describe("LearningService — snapshot cache", () => {
  const WS = "ws_default";

  function makeService(opts: {
    cachedSnap?: unknown;
    rows?: Array<{ predicted: unknown; confirmed: unknown; adjustments?: unknown }>;
  } = {}) {
    const findMany = jest.fn().mockResolvedValue(opts.rows ?? []);
    const prisma = {
      fieldOverride: { findMany, count: jest.fn().mockResolvedValue(0) },
      workspacePushConfig: {
        findUnique: jest.fn().mockResolvedValue({
          assignableMembers: [],
          sprintLists: [],
        }),
      },
    } as never;
    const cache = {
      read: jest.fn().mockResolvedValue(opts.cachedSnap ?? null),
      write: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const stream = {
      publish: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn(),
    } as never;
    // v2 Phase 5 — snapshot() now reads per-workspace tunables via MlConfigService.
    // Stub returns hardcoded defaults so the cache-behavior assertions remain focused.
    const mlConfig = {
      forWorkspace: jest.fn().mockResolvedValue({
        tunables: { minCorrections: 3, minAgreement: 0.6 },
        models: {},
      }),
    } as never;
    return {
      service: new LearningService(prisma, cache as never, stream, mlConfig),
      cache,
      findMany,
    };
  }

  it("cache MISS → hits the DB then writes back", async () => {
    const { service, cache, findMany } = makeService({ cachedSnap: null });
    const snap = await service.snapshot(WS);
    expect(cache.read).toHaveBeenCalledWith(WS);
    expect(findMany).toHaveBeenCalled();
    expect(cache.write).toHaveBeenCalledWith(WS, snap);
    expect(snap.assignee).toBeDefined();
    expect(snap.sprint).toBeDefined();
  });

  it("cache HIT → skips the DB scan and returns the cached value", async () => {
    const cached = {
      assignee: {
        corrections: [],
        rawOverrideRate: null,
        rawSample: 0,
        nudgeAcceptanceRate: null,
        nudgeSample: 0,
        unresolved: 0,
      },
      sprint: {
        corrections: [],
        rawOverrideRate: null,
        rawSample: 0,
        nudgeAcceptanceRate: null,
        nudgeSample: 0,
        unresolved: 0,
      },
    };
    const { service, cache, findMany } = makeService({ cachedSnap: cached });
    const snap = await service.snapshot(WS);
    expect(cache.read).toHaveBeenCalledWith(WS);
    expect(findMany).not.toHaveBeenCalled();
    expect(cache.write).not.toHaveBeenCalled();
    expect(snap).toBe(cached);
  });

  it("invalidateCache delegates to the cache", async () => {
    const { service, cache } = makeService();
    await service.invalidateCache(WS);
    expect(cache.invalidate).toHaveBeenCalledWith(WS);
  });
});
