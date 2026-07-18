import { LearningService, lastNWeekStarts, weekStartIso } from "./learning.service";

/**
 * v2 Phase 1 — per-user weekly digest at GET /workspaces/:id/learning/me.
 * The tsvector column is DB-only so the service reads via $queryRaw; these
 * tests stub the raw result rows and assert bucket math + zero-padding.
 */
describe("LearningService — meSummary", () => {
  const WS = "ws_default";
  const USER = "user_abc";

  function makeService(opts: {
    rows: Array<Record<string, unknown>>;
    members?: Array<{ clickupUserId: string; name: string }>;
  }) {
    const queryRaw = jest.fn().mockResolvedValue(opts.rows);
    const workspacePushConfigFindUnique = jest.fn().mockResolvedValue(
      opts.members ? { assignableMembers: opts.members } : null,
    );
    const prisma = {
      $queryRaw: queryRaw,
      workspacePushConfig: { findUnique: workspacePushConfigFindUnique },
      fieldOverride: { count: jest.fn(), findMany: jest.fn() },
    };
    return { service: new LearningService(prisma as never), queryRaw };
  }

  it("zero-pads to 6 weeks (oldest first) when there are no overrides", async () => {
    const { service } = makeService({ rows: [] });
    const view = await service.meSummary(WS, USER);
    expect(view.userId).toBe(USER);
    expect(view.totalOverrides).toBe(0);
    expect(view.weeks).toHaveLength(6);
    // Every week zeroed.
    for (const w of view.weeks) {
      expect(w.overrides).toBe(0);
      expect(w.agreements).toBe(0);
      expect(w.nudgesShown).toBe(0);
      expect(w.nudgesAccepted).toBe(0);
    }
    // Oldest first.
    const dates = view.weeks.map((w) => w.weekStart);
    expect([...dates].sort()).toEqual(dates);
  });

  it("counts an override and its agreement + nudge acceptance in the correct weekly bucket", async () => {
    const now = new Date();
    const thisWeekMonday = new Date(`${weekStartIso(now)}T00:00:00Z`);
    const rows = [
      {
        created_at: thisWeekMonday,
        // Model predicted "Alice" and the user confirmed the same ClickUp id (mapped → "Alice").
        predicted: { assigneeHint: { value: "Alice", abstain: false } },
        confirmed: { clickupUserId: "u_alice" },
        adjustments: { assignee: { shown: "Alice", accepted: true } },
      },
    ];
    const { service } = makeService({
      rows,
      members: [{ clickupUserId: "u_alice", name: "Alice" }],
    });

    const view = await service.meSummary(WS, USER);
    const bucket = view.weeks[view.weeks.length - 1]!;
    expect(bucket.overrides).toBe(1);
    expect(bucket.agreements).toBe(1);
    expect(bucket.nudgesShown).toBe(1);
    expect(bucket.nudgesAccepted).toBe(1);
    expect(view.totalOverrides).toBe(1);
  });

  it("counts rows outside the 6-week window in totalOverrides but not in any weekly bucket", async () => {
    const now = new Date();
    // 20 weeks ago — well outside the 6-week window.
    const oldDate = new Date(now.getTime() - 20 * 7 * 24 * 60 * 60 * 1000);
    const { service } = makeService({
      rows: [
        {
          created_at: oldDate,
          predicted: { assigneeHint: { value: "Bob", abstain: false } },
          confirmed: { clickupUserId: "u_bob" },
          adjustments: null,
        },
      ],
      members: [{ clickupUserId: "u_bob", name: "Bob" }],
    });

    const view = await service.meSummary(WS, USER);
    expect(view.totalOverrides).toBe(1);
    for (const w of view.weeks) {
      expect(w.overrides).toBe(0);
    }
  });

  it("does not count agreement when predicted was an abstain", async () => {
    const now = new Date();
    const thisWeekMonday = new Date(`${weekStartIso(now)}T00:00:00Z`);
    const { service } = makeService({
      rows: [
        {
          created_at: thisWeekMonday,
          predicted: { assigneeHint: { value: null, abstain: true } },
          confirmed: { clickupUserId: "u_alice" },
          adjustments: null,
        },
      ],
      members: [{ clickupUserId: "u_alice", name: "Alice" }],
    });

    const view = await service.meSummary(WS, USER);
    const bucket = view.weeks[view.weeks.length - 1]!;
    expect(bucket.overrides).toBe(1);
    // predValue is null (abstain), confValue is "Alice" → not equal.
    expect(bucket.agreements).toBe(0);
  });

  it("passes the userId through to the SQL for cross-user isolation", async () => {
    const { service, queryRaw } = makeService({ rows: [] });
    await service.meSummary(WS, USER);
    // Tagged-template form: mock.calls[0] === [TemplateStringsArray, ...values].
    // The interpolated values (workspaceId, userId) follow the strings array.
    const args = queryRaw.mock.calls[0] as unknown[];
    expect(args.slice(1)).toContain(WS);
    expect(args.slice(1)).toContain(USER);
  });
});

describe("weekStartIso + lastNWeekStarts", () => {
  it("normalizes any weekday in a week to its Monday, in UTC", () => {
    // Wednesday 2026-07-15 UTC → Monday 2026-07-13.
    expect(weekStartIso(new Date("2026-07-15T13:00:00Z"))).toBe("2026-07-13");
    // Sunday 2026-07-19 UTC → Monday 2026-07-13 (Sunday is the END of the week).
    expect(weekStartIso(new Date("2026-07-19T23:00:00Z"))).toBe("2026-07-13");
    // Monday itself → itself.
    expect(weekStartIso(new Date("2026-07-13T00:00:00Z"))).toBe("2026-07-13");
  });

  it("returns N Monday ISOs, oldest first, ending at now's week", () => {
    const now = new Date("2026-07-16T00:00:00Z");
    const weeks = lastNWeekStarts(6, now);
    expect(weeks).toHaveLength(6);
    expect(weeks[weeks.length - 1]).toBe("2026-07-13");
    expect(weeks[0]).toBe("2026-06-08");
  });
});
