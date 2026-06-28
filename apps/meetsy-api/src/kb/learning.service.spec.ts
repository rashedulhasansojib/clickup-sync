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
        clientOptions: [{ optionId: "uuid-ait", name: "AIT" }, { optionId: "uuid-er", name: "Energy Reporting" }],
        assignableMembers: [{ clickupUserId: "u-ahmad", name: "Ahmad" }],
      }),
    },
  } as unknown as PrismaService;
  return new LearningService(prisma);
}

const ov = (clientOpt: string) => ({
  predicted: { client: { value: "Nifty AI", abstain: false }, assigneeHint: { value: null, abstain: true } },
  confirmed: { clientOptionId: clientOpt, clickupUserId: null },
});

describe("LearningService", () => {
  it("resolves the confirmed option UUID → name and learns predicted→confirmed", async () => {
    const svc = makeService([ov("uuid-ait"), ov("uuid-ait"), ov("uuid-ait")]);
    const snap = await svc.snapshot("ws1");
    const c = snap.client.corrections.find((x) => x.predicted === "Nifty AI" && x.confirmed === "AIT")!;
    expect(c.count).toBe(3);
    expect(c.gatePassed).toBe(true);
  });

  it("counts an unresolved confirmed option (resolution miss, not sparse)", async () => {
    const svc = makeService([ov("uuid-MISSING")]);
    const snap = await svc.snapshot("ws1");
    expect(snap.client.unresolved).toBe(1);
    expect(snap.client.corrections).toHaveLength(0);
  });

  it("adjustForTasks surfaces the gated nudge for a fresh matching prediction", async () => {
    const svc = makeService([ov("uuid-ait"), ov("uuid-ait"), ov("uuid-ait")]);
    const adj = await svc.adjustForTasks("ws1", {
      t1: { client: { value: "Nifty AI", abstain: false }, assigneeHint: { value: null, abstain: true } },
    });
    expect(adj.t1.client).toMatchObject({ from: "Nifty AI", to: "AIT", count: 3 });
  });

  it("does NOT nudge below the gate", async () => {
    const svc = makeService([ov("uuid-ait"), ov("uuid-ait")]); // only 2
    const adj = await svc.adjustForTasks("ws1", {
      t1: { client: { value: "Nifty AI", abstain: false }, assigneeHint: { value: null, abstain: true } },
    });
    expect(adj.t1).toBeUndefined();
  });
});
