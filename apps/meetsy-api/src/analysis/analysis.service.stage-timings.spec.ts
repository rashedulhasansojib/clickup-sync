import { AnalysisService } from "./analysis.service";

/**
 * v2 SSE progress-polish — `GET /workspaces/:id/runs/stage-timings`.
 *
 * Returns the median seconds per stage across the last N completed runs so
 * the pipeline stepper can show a "typical: ~4s" hint per stage while the
 * pipeline is working. Reads `AnalysisRun.stageDurations` (JSON), skips rows
 * that are null / malformed, and rejects non-numeric / negative values.
 */
describe("AnalysisService — runStageTimings", () => {
  function makeService(rows: unknown[]) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const prisma = { analysisRun: { findMany } };
    const workspaces = { resolve: jest.fn().mockResolvedValue("ws1") };
    const service = new AnalysisService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      workspaces as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { publish: jest.fn() } as never,
    );
    return { service, findMany };
  }

  it("empty sample → empty medianByStage + sampleSize 0", async () => {
    const { service } = makeService([]);
    const res = await service.runStageTimings("org", "ws");
    expect(res).toEqual({ medianByStage: {}, sampleSize: 0 });
  });

  it("odd sample → median is the middle value", async () => {
    const { service } = makeService([
      { stageDurations: { comprehend: 3, extract: 1 } },
      { stageDurations: { comprehend: 6, extract: 1 } },
      { stageDurations: { comprehend: 9, extract: 1 } },
    ]);
    const res = await service.runStageTimings("org", "ws");
    expect(res.sampleSize).toBe(3);
    expect(res.medianByStage).toEqual({ comprehend: 6, extract: 1 });
  });

  it("even sample → median is the average of the two middle values", async () => {
    const { service } = makeService([
      { stageDurations: { critic: 2 } },
      { stageDurations: { critic: 4 } },
      { stageDurations: { critic: 6 } },
      { stageDurations: { critic: 8 } },
    ]);
    const res = await service.runStageTimings("org", "ws");
    expect(res.medianByStage.critic).toBe(5); // (4 + 6) / 2
  });

  it("malformed / negative values are silently dropped from the bucket", async () => {
    const { service } = makeService([
      { stageDurations: { assemble: 2, comprehend: "oops" } },
      { stageDurations: { assemble: 4, comprehend: -1 } },
      { stageDurations: { assemble: 6, comprehend: null } },
    ]);
    const res = await service.runStageTimings("org", "ws");
    expect(res.medianByStage).toEqual({ assemble: 4 });
    // sampleSize counts rows, not per-stage values (that's the whole point of
    // making the stepper's hint show "typical over 3 recent runs").
    expect(res.sampleSize).toBe(3);
  });

  it("limit is clamped to [1, 50]", async () => {
    const { service, findMany } = makeService([]);
    await service.runStageTimings("org", "ws", 0); // → 1
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1 }),
    );
    await service.runStageTimings("org", "ws", 100); // → 50
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  it("only completed runs are queried", async () => {
    const { service, findMany } = makeService([]);
    await service.runStageTimings("org", "ws");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "completed" }),
      }),
    );
  });
});
