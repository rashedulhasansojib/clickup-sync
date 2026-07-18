import { LearningService } from "./learning.service";

/**
 * v2 Phase 3 (PR-N) — `maybePublishThreshold` fires a near-gate or
 * gate-passed event exactly when the post-write organic count matches a
 * threshold. Nudge-influenced rows never trigger publish (they don't count
 * toward the organic aggregate, per `learning-aggregate.ts:73-78`).
 */
describe("LearningService — maybePublishThreshold", () => {
  const WS = "ws1";

  function ov(memberId: string, adj: unknown = null) {
    return {
      predicted: { assigneeHint: { value: "Rashedul", abstain: false } },
      confirmed: { clickupUserId: memberId, listId: null },
      adjustments: adj,
    };
  }

  function makeService(historicalOverrides: unknown[]) {
    const prisma = {
      fieldOverride: {
        findMany: jest.fn().mockResolvedValue(historicalOverrides),
        count: jest.fn().mockResolvedValue(historicalOverrides.length),
      },
      workspacePushConfig: {
        findUnique: jest.fn().mockResolvedValue({
          assignableMembers: [{ clickupUserId: "u-ahmad", name: "Ahmad" }],
          sprintLists: [],
        }),
      },
    } as never;
    const cache = {
      read: jest.fn().mockResolvedValue(null),
      write: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    } as never;
    const publish = jest.fn().mockResolvedValue(undefined);
    const stream = { publish, subscribe: jest.fn() } as never;
    return { service: new LearningService(prisma, cache, stream), publish };
  }

  it("fires 'near-gate' when the fresh count reaches 2 (one shy of gate)", async () => {
    // Historical rows already have 2 organic corrections; the new write
    // itself IS the 2nd. `findMany` mock returns the post-write set.
    const { service, publish } = makeService([ov("u-ahmad"), ov("u-ahmad")]);
    await service.maybePublishThreshold(WS, {
      predicted: { assigneeHint: { value: "Rashedul", abstain: false } },
      confirmed: { clickupUserId: "u-ahmad" },
      adjustments: null,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      field: "assignee",
      predicted: "Rashedul",
      confirmed: "Ahmad",
      count: 2,
      kind: "near-gate",
    });
  });

  it("fires 'gate-passed' when the fresh count reaches 3", async () => {
    const { service, publish } = makeService([ov("u-ahmad"), ov("u-ahmad"), ov("u-ahmad")]);
    await service.maybePublishThreshold(WS, {
      predicted: { assigneeHint: { value: "Rashedul", abstain: false } },
      confirmed: { clickupUserId: "u-ahmad" },
      adjustments: null,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      kind: "gate-passed",
      count: 3,
    });
  });

  it("stays quiet at count=1 (still sparse)", async () => {
    const { service, publish } = makeService([ov("u-ahmad")]);
    await service.maybePublishThreshold(WS, {
      predicted: { assigneeHint: { value: "Rashedul", abstain: false } },
      confirmed: { clickupUserId: "u-ahmad" },
      adjustments: null,
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("stays quiet AFTER the gate (count=4)", async () => {
    const { service, publish } = makeService([
      ov("u-ahmad"),
      ov("u-ahmad"),
      ov("u-ahmad"),
      ov("u-ahmad"),
    ]);
    await service.maybePublishThreshold(WS, {
      predicted: { assigneeHint: { value: "Rashedul", abstain: false } },
      confirmed: { clickupUserId: "u-ahmad" },
      adjustments: null,
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("never fires when the just-written row was NUDGE-influenced (organic only)", async () => {
    const { service, publish } = makeService([
      ov("u-ahmad"),
      ov("u-ahmad", { assignee: { shown: "Ahmad", accepted: true } }),
    ]);
    await service.maybePublishThreshold(WS, {
      predicted: { assigneeHint: { value: "Rashedul", abstain: false } },
      confirmed: { clickupUserId: "u-ahmad" },
      // The write itself was nudge-influenced — must not fire.
      adjustments: { assignee: { shown: "Ahmad", accepted: true } },
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("stays quiet when the row is an agreement (predicted === confirmed)", async () => {
    // Predicted "Ahmad", confirmed "Ahmad" — nothing to nudge.
    const { service, publish } = makeService([]);
    await service.maybePublishThreshold(WS, {
      predicted: { assigneeHint: { value: "Ahmad", abstain: false } },
      confirmed: { clickupUserId: "u-ahmad" },
      adjustments: null,
    });
    expect(publish).not.toHaveBeenCalled();
  });
});
