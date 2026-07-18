import { BadRequestException, NotFoundException } from "@nestjs/common";
import { LearningService } from "./learning.service";
import { patternKey } from "./learning-aggregate";

/**
 * v2 Phase 3 (PR-M) — `patternHistory` decodes the pattern key, confirms the
 * pattern exists in the snapshot, then returns a chronological list of
 * FieldOverride rows matching (predicted, confirmed) after name resolution.
 * A malformed key → 400; an unknown pattern → 404.
 */
describe("LearningService — patternHistory", () => {
  const WS = "ws1";

  function ovAssignee(memberId: string, adj: unknown = null) {
    return {
      predicted: { assigneeHint: { value: "Rashedul", abstain: false } },
      confirmed: { clickupUserId: memberId, listId: null },
      adjustments: adj,
    };
  }

  function makeService(overrides: unknown[], now = new Date("2026-07-15T12:00:00Z")) {
    // Attach fake timeline metadata + a stable createdAt.
    const rows = (overrides as Array<Record<string, unknown>>).map((o, i) => ({
      runId: `run_${i + 1}`,
      meetsyTaskId: `t${i + 1}`,
      createdAt: new Date(now.getTime() - i * 60_000),
      ...o,
    }));
    const prisma = {
      fieldOverride: {
        findMany: jest.fn().mockImplementation(async ({ select }: { select?: unknown }) => {
          // The snapshot query uses a narrow select; the history query uses a
          // wider one (includes runId/meetsyTaskId/createdAt). Return the same
          // rows either way — the shape is a superset of both.
          void select;
          return rows;
        }),
        count: jest.fn().mockResolvedValue(rows.length),
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
    const stream = {
      publish: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn(),
    } as never;
    return new LearningService(prisma, cache, stream);
  }

  it("returns the matching entries (newest first) with the pattern's aggregate stats", async () => {
    const svc = makeService([
      ovAssignee("u-ahmad"),
      ovAssignee("u-ahmad"),
      ovAssignee("u-ahmad"),
    ]);
    const key = patternKey("assignee", "Rashedul", "Ahmad");
    const view = await svc.patternHistory(WS, key);
    expect(view.field).toBe("assignee");
    expect(view.predicted).toBe("Rashedul");
    expect(view.confirmed).toBe("Ahmad");
    expect(view.count).toBe(3);
    expect(view.gatePassed).toBe(true);
    expect(view.entries).toHaveLength(3);
    // Newest first — createdAt DESC ordering preserved by the service.
    expect(view.entries[0].createdAt >= view.entries[1].createdAt).toBe(true);
    expect(view.entries.every((e) => e.nudgeShown === false)).toBe(true);
  });

  it("tags nudge-influenced rows with nudgeShown=true", async () => {
    const svc = makeService([
      ovAssignee("u-ahmad", { assignee: { shown: "Ahmad", accepted: true } }),
      ovAssignee("u-ahmad"),
      ovAssignee("u-ahmad"),
    ]);
    const key = patternKey("assignee", "Rashedul", "Ahmad");
    const view = await svc.patternHistory(WS, key);
    const shown = view.entries.filter((e) => e.nudgeShown);
    expect(shown).toHaveLength(1);
  });

  it("throws BadRequestException on a malformed key", async () => {
    const svc = makeService([]);
    await expect(svc.patternHistory(WS, "%%%")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("throws BadRequestException on an unknown field in the key", async () => {
    const svc = makeService([]);
    // base64url("client|X|Y") — a plausible but not-in-FIELDS field.
    const bogus = Buffer.from("client|X|Y", "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expect(svc.patternHistory(WS, bogus)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("throws NotFoundException when the pattern isn't in the snapshot", async () => {
    const svc = makeService([]);
    const key = patternKey("assignee", "Alice", "Bob");
    await expect(svc.patternHistory(WS, key)).rejects.toBeInstanceOf(NotFoundException);
  });
});
