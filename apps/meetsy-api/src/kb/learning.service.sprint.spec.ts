import { LearningService } from "./learning.service";

/**
 * v2 Phase 3 (PR-L) — the sprint learning path parallels assignee: predicted
 * comes from `predicted.sprint.value`, confirmed comes from
 * `confirmed.listId` resolved via `WorkspacePushConfig.sprintLists[]`.
 *
 * These tests only cover the SPRINT branch; the assignee branch is already
 * covered by `learning.service.spec.ts`. The `key` on each CorrectionStat is
 * spot-checked here so its base64url shape doesn't silently regress.
 */
describe("LearningService — sprint learning", () => {
  function makeService(overrides: Array<{ predicted: unknown; confirmed: unknown; adjustments?: unknown }>) {
    const prisma = {
      fieldOverride: {
        findMany: jest.fn().mockResolvedValue(overrides.map((o) => ({ adjustments: null, ...o }))),
        count: jest.fn().mockResolvedValue(overrides.length),
      },
      workspacePushConfig: {
        findUnique: jest.fn().mockResolvedValue({
          assignableMembers: [],
          sprintLists: [
            { listId: "list-24", name: "Sprint-24" },
            { listId: "list-25", name: "Sprint-25" },
          ],
        }),
      },
    } as never;
    const cache = {
      read: jest.fn().mockResolvedValue(null),
      write: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    } as never;
    const stream = {
      publish: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn(),
    } as never;
    // v2 Phase 5 — snapshot() reads workspace tunables; stub the defaults.
    const mlConfig = {
      forWorkspace: jest.fn().mockResolvedValue({
        tunables: { minCorrections: 3, minAgreement: 0.6 },
        models: {},
      }),
    } as never;
    return new LearningService(prisma, cache, stream, mlConfig);
  }

  const ov = (confirmedListId: string) => ({
    predicted: { sprint: { value: "Sprint-24", abstain: false } },
    confirmed: { listId: confirmedListId, clickupUserId: null },
  });

  it("resolves confirmed listId → sprint name and learns predicted→confirmed", async () => {
    const svc = makeService([ov("list-25"), ov("list-25"), ov("list-25")]);
    const snap = await svc.snapshot("ws1");
    const c = snap.sprint.corrections.find(
      (x) => x.predicted === "Sprint-24" && x.confirmed === "Sprint-25",
    )!;
    expect(c).toBeDefined();
    expect(c.count).toBe(3);
    expect(c.gatePassed).toBe(true);
    expect(c.field).toBe("sprint");
    expect(c.key).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("counts an unresolved listId as unresolved, not a correction", async () => {
    const svc = makeService([ov("list-MISSING")]);
    const snap = await svc.snapshot("ws1");
    expect(snap.sprint.unresolved).toBe(1);
    expect(snap.sprint.corrections).toHaveLength(0);
  });

  it("applyNudges surfaces a gated sprint nudge for a fresh matching prediction", async () => {
    const svc = makeService([ov("list-25"), ov("list-25"), ov("list-25")]);
    const snap = await svc.snapshot("ws1");
    const adj = svc.applyNudges(snap, {
      sprint: { value: "Sprint-24", abstain: false },
    });
    expect(adj.sprint).toBeDefined();
    expect(adj.sprint!.from).toBe("Sprint-24");
    expect(adj.sprint!.to).toBe("Sprint-25");
    expect(adj.sprint!.count).toBe(3);
  });

  it("adjustForTasks emits a task's nudge even when only sprint fires (no assignee)", async () => {
    const svc = makeService([ov("list-25"), ov("list-25"), ov("list-25")]);
    const byTask = await svc.adjustForTasks("ws1", {
      t1: { sprint: { value: "Sprint-24", abstain: false } },
    });
    expect(byTask.t1).toBeDefined();
    expect(byTask.t1.sprint).toBeDefined();
    expect(byTask.t1.assignee).toBeUndefined();
  });
});
