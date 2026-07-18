import { MlConfigPreviewService } from "./ml-config-preview.service";
import { DEFAULT_TUNABLES, DEFAULT_MODELS } from "../kb/ml-config.defaults";
import type { RunSnapshotPayload } from "@ma/shared";

/**
 * v2 Phase 5 (PR-V) — the preview endpoint replays the last N completed runs
 * against a candidate config. The only tunable we can honestly replay from
 * stored signals is the duplicate classifier (via per-task `neighboursByTask`);
 * every other field appears in the `skipped` list with a documented reason.
 */
describe("MlConfigPreviewService", () => {
  const WS = "ws_test";

  function makeService(opts: {
    runs: Array<{
      id: string;
      neighboursByTask: Record<string, Array<{ taskId: string; sim: number }>> | null;
      snapshotTunables?: object | null;
      title?: string;
      meetingDate?: Date | null;
    }>;
    workspaceTunables?: object;
    snapshot?: {
      assignee: {
        corrections: Array<{ count: number; agreement: number; key: string; predicted: string; confirmed: string; field: string; gatePassed: boolean }>;
      };
      sprint: { corrections: Array<never> };
    };
  }) {
    const findMany = jest.fn().mockResolvedValue(
      opts.runs.map((r) => ({
        id: r.id,
        result: r.neighboursByTask ? { neighboursByTask: r.neighboursByTask } : null,
        snapshot: r.snapshotTunables === undefined
          ? { tunables: DEFAULT_TUNABLES }
          : r.snapshotTunables === null
            ? null
            : { tunables: r.snapshotTunables },
        meeting: { title: r.title ?? "meeting", meetingDate: r.meetingDate ?? null },
      })),
    );
    const prisma = { analysisRun: { findMany } };
    const mlConfig = {
      forWorkspace: jest.fn().mockResolvedValue({
        tunables: opts.workspaceTunables ?? DEFAULT_TUNABLES,
        models: DEFAULT_MODELS,
      }),
    };
    const learning = {
      snapshot: jest.fn().mockResolvedValue(
        opts.snapshot ?? {
          assignee: { corrections: [] },
          sprint: { corrections: [] },
        },
      ),
    };
    const service = new MlConfigPreviewService(
      prisma as never,
      mlConfig as never,
      learning as never,
    );
    return { service, findMany };
  }

  function candidate(tunables: Partial<RunSnapshotPayload["tunables"]>): RunSnapshotPayload {
    return {
      tunables: { ...DEFAULT_TUNABLES, ...tunables },
      models: DEFAULT_MODELS,
    };
  }

  it("counts baseline vs candidate duplicates using stored neighboursByTask", async () => {
    const { service } = makeService({
      runs: [
        {
          id: "run1",
          // sim 0.65 is in the default suggest band (0.64-0.72). A candidate
          // that tightens dupSuggest to 0.70 should drop this hit entirely.
          neighboursByTask: {
            t1: [{ taskId: "n1", sim: 0.65 }],
          },
        },
      ],
    });

    const view = await service.run(WS, candidate({ dupFlag: 0.9, dupSuggest: 0.7 }));

    expect(view.runs).toHaveLength(1);
    expect(view.runs[0].duplicates).toEqual({
      baseline: { flag: 0, suggest: 1 },
      candidate: { flag: 0, suggest: 0 },
      changed: 1,
    });
  });

  it("returns duplicates=null on legacy runs missing neighboursByTask", async () => {
    const { service } = makeService({
      runs: [{ id: "legacy", neighboursByTask: null }],
    });
    const view = await service.run(WS, candidate({}));
    expect(view.runs[0].duplicates).toBeNull();
    expect(view.runs[0].taskCount).toBe(0);
  });

  it("uses AnalysisRunSnapshot tunables as baseline when present, workspace default otherwise", async () => {
    // Two runs: run1 has a snapshot with DIFFERENT bands than the current
    // workspace; run2 has no snapshot (legacy). Baseline for run1 must reflect
    // the snapshot values, run2 must fall back to workspace tunables.
    const { service } = makeService({
      runs: [
        {
          id: "with-snap",
          neighboursByTask: { t: [{ taskId: "n", sim: 0.55 }] },
          // Snapshot bands were relaxed: 0.5 flag / 0.5 suggest → sim 0.55 flags.
          snapshotTunables: { ...DEFAULT_TUNABLES, dupFlag: 0.5, dupSuggest: 0.5 },
        },
        {
          id: "no-snap",
          neighboursByTask: { t: [{ taskId: "n", sim: 0.55 }] },
          snapshotTunables: null, // no AnalysisRunSnapshot row
        },
      ],
      // Workspace config uses tighter bands than the with-snap snapshot.
      workspaceTunables: { ...DEFAULT_TUNABLES, dupFlag: 0.9, dupSuggest: 0.9 },
    });

    const view = await service.run(WS, candidate({}));
    // With-snap baseline used the snapshot's relaxed bands → sim 0.55 flags.
    expect(view.runs[0].duplicates?.baseline).toEqual({ flag: 1, suggest: 0 });
    // No-snap baseline uses the workspace default (tight bands) → nothing surfaces.
    expect(view.runs[1].duplicates?.baseline).toEqual({ flag: 0, suggest: 0 });
  });

  it("reports non-replayable tunables in `skipped`", async () => {
    const { service } = makeService({ runs: [] });
    const view = await service.run(WS, candidate({}));
    const fields = view.skipped.map((s) => s.field);
    expect(fields).toContain("tunables.simFloor");
    expect(fields).toContain("tunables.rrfK");
    expect(fields).toContain("models.*");
  });

  it("gate summary counts baseline + candidate patterns from a workspace-wide snapshot", async () => {
    // Two organic patterns: one gates at (count>=3, agreement>=0.6), one doesn't.
    const stat = (count: number, agreement: number) => ({
      field: "assignee",
      key: "k",
      predicted: "A",
      confirmed: "B",
      count,
      agreement,
      gatePassed: false,
    });
    const { service } = makeService({
      runs: [],
      snapshot: {
        assignee: {
          corrections: [
            stat(5, 0.9), // gates under both baseline (3, 0.6) and candidate (6, 0.9): candidate should NOT gate this
            stat(3, 0.6), // gates only under baseline
          ],
        },
        sprint: { corrections: [] },
      },
    });

    const view = await service.run(WS, candidate({ minCorrections: 6, minAgreement: 0.9 }));
    expect(view.gate.baseline.patternsGating).toBe(2);
    expect(view.gate.candidate.patternsGating).toBe(0);
    // Near-gate under candidate: count >= 5 (6-1), agreement >= 0.9 → the first stat qualifies.
    expect(view.gate.candidate.patternsNearGate).toBe(1);
  });

  it("clamps limit to [1, 20]", async () => {
    const { service, findMany } = makeService({ runs: [] });
    await service.run(WS, candidate({}), { limit: 100 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    );

    await service.run(WS, candidate({}), { limit: 0 });
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1 }),
    );
  });
});
