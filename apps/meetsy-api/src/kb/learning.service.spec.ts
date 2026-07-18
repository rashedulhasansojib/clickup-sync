import { LearningService } from "./learning.service";
import { PrismaService } from "../prisma/prisma.service";

function makeService(overrides: Array<{ predicted: unknown; confirmed: unknown; adjustments?: unknown }>) {
  const prisma = {
    fieldOverride: {
      findMany: jest.fn().mockResolvedValue(overrides.map((o) => ({ adjustments: null, ...o }))),
      count: jest.fn().mockResolvedValue(overrides.length),
    },
    workspacePushConfig: {
      findUnique: jest.fn().mockResolvedValue({
        assignableMembers: [{ clickupUserId: "u-ahmad", name: "Ahmad" }],
        sprintLists: [],
      }),
    },
  } as unknown as PrismaService;
  // v2 Phase 3 — LearningService now takes a cache + stream. Both are best-
  // effort: a null read + noop write/publish keep the fallback path clean.
  const cache = {
    read: jest.fn().mockResolvedValue(null),
    write: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(undefined),
  } as never;
  const stream = {
    publish: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn(),
  } as never;
  return new LearningService(prisma, cache, stream);
}

const ov = (memberId: string) => ({
  predicted: { assigneeHint: { value: "Rashedul", abstain: false } },
  confirmed: { clientOptionId: null, clickupUserId: memberId },
});

describe("LearningService", () => {
  it("resolves the confirmed member id → name and learns predicted→confirmed", async () => {
    const svc = makeService([ov("u-ahmad"), ov("u-ahmad"), ov("u-ahmad")]);
    const snap = await svc.snapshot("ws1");
    const c = snap.assignee.corrections.find((x) => x.predicted === "Rashedul" && x.confirmed === "Ahmad")!;
    expect(c.count).toBe(3);
    expect(c.gatePassed).toBe(true);
  });

  it("counts an unresolved confirmed member id (resolution miss, not sparse)", async () => {
    const svc = makeService([ov("u-MISSING")]);
    const snap = await svc.snapshot("ws1");
    expect(snap.assignee.unresolved).toBe(1);
    expect(snap.assignee.corrections).toHaveLength(0);
  });

  it("adjustForTasks surfaces the gated nudge for a fresh matching prediction", async () => {
    const svc = makeService([ov("u-ahmad"), ov("u-ahmad"), ov("u-ahmad")]);
    const adj = await svc.adjustForTasks("ws1", {
      t1: { assigneeHint: { value: "Rashedul", abstain: false } },
    });
    expect(adj.t1.assignee).toMatchObject({ from: "Rashedul", to: "Ahmad", count: 3 });
  });

  it("does NOT nudge below the gate", async () => {
    const svc = makeService([ov("u-ahmad"), ov("u-ahmad")]); // only 2
    const adj = await svc.adjustForTasks("ws1", {
      t1: { assigneeHint: { value: "Rashedul", abstain: false } },
    });
    expect(adj.t1).toBeUndefined();
  });
});
