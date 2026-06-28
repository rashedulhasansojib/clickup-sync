import { Prisma } from "@prisma/client";
import { KbOnboardingService } from "./kb-onboarding.service";
import { PrismaService } from "../prisma/prisma.service";
import { KbQueue } from "./kb.queue";
import { ClicksyAdminClient } from "./clicksy-admin.client";
import { ConfigService } from "../config/config.service";

type StoredState = {
  range?: string | null;
  scope?: unknown;
  lastTaskCursor?: Date | null;
  status?: string;
  embeddedCount?: number;
  lastRunAt?: Date | null;
} | null;

function makeSvc(existing: StoredState) {
  const findUnique = jest.fn().mockResolvedValue(existing);
  const upsert = jest.fn().mockResolvedValue({});
  const count = jest.fn().mockResolvedValue(0);
  const groupBy = jest.fn().mockResolvedValue([]);
  const findMany = jest.fn().mockResolvedValue([]);
  const wsFindMany = jest.fn().mockResolvedValue([]);
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const prisma = {
    kbSyncState: { findUnique, upsert },
    clickupTask: { count, groupBy, findMany },
    workspaceSpace: { findMany: wsFindMany },
  } as unknown as PrismaService;
  const queue = { enqueue } as unknown as KbQueue;
  const svc = new KbOnboardingService(
    prisma,
    {} as unknown as ClicksyAdminClient,
    queue,
    {} as unknown as ConfigService,
  );
  return { svc, upsert, enqueue, count, groupBy, findMany, wsFindMany };
}

describe("KbOnboardingService.onboard (cursor reset)", () => {
  it("preserves the cursor when (range, scope) is unchanged", async () => {
    const { svc, upsert, enqueue } = makeSvc({ range: "3m", scope: { spaceIds: ["a"] }, status: "ready" });
    await svc.onboard("ws1", "3m", { spaceIds: ["a"] });

    const call = upsert.mock.calls[0][0];
    expect(call.update).not.toHaveProperty("lastTaskCursor");
    expect(enqueue).toHaveBeenCalledWith({ workspaceId: "ws1", range: "3m", scope: { spaceIds: ["a"] } });
  });

  it("treats reordered/empty axes as the same scope (no reset)", async () => {
    const { svc, upsert } = makeSvc({ range: "6m", scope: { spaceIds: ["a", "b"] } });
    await svc.onboard("ws1", "6m", { spaceIds: ["b", "a"], folderNames: [] });

    expect(upsert.mock.calls[0][0].update).not.toHaveProperty("lastTaskCursor");
  });

  it("resets the cursor to null when a space is added to the scope", async () => {
    const { svc, upsert } = makeSvc({ range: "3m", scope: { spaceIds: ["a"] } });
    await svc.onboard("ws1", "3m", { spaceIds: ["a", "b"] });

    expect(upsert.mock.calls[0][0].update.lastTaskCursor).toBeNull();
  });

  it("resets the cursor when the range changes", async () => {
    const { svc, upsert } = makeSvc({ range: "3m", scope: undefined });
    await svc.onboard("ws1", "6m");

    expect(upsert.mock.calls[0][0].update.lastTaskCursor).toBeNull();
  });

  it("writes Prisma.DbNull for an absent scope", async () => {
    const { svc, upsert } = makeSvc({ range: "3m", scope: undefined });
    await svc.onboard("ws1", "3m");

    expect(upsert.mock.calls[0][0].update.scope).toBe(Prisma.DbNull);
    expect(upsert.mock.calls[0][0].update).not.toHaveProperty("lastTaskCursor");
  });
});

describe("KbOnboardingService.status", () => {
  it("round-trips scope + range from the KbSyncState row", async () => {
    const { svc, count } = makeSvc({
      range: "6m",
      scope: { spaceIds: ["a"], clients: ["Acme"] },
      status: "ready",
      embeddedCount: 7,
      lastRunAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    count.mockResolvedValueOnce(42);

    const out = await svc.status("ws1");
    expect(out).toEqual({
      status: "ready",
      embeddedCount: 7,
      total: 42,
      lastRunAt: "2026-06-01T00:00:00.000Z",
      scope: { spaceIds: ["a"], clients: ["Acme"] },
      range: "6m",
    });
  });

  it("returns null scope/range when no state row exists", async () => {
    const { svc } = makeSvc(null);
    const out = await svc.status("ws1");
    expect(out.scope).toBeNull();
    expect(out.range).toBeNull();
    expect(out.status).toBe("idle");
  });
});

describe("KbOnboardingService.listSpaces", () => {
  it("returns all configured spaces (incl. disabled) with mirrored task counts, default 0", async () => {
    const { svc, wsFindMany, groupBy } = makeSvc(null);
    wsFindMany.mockResolvedValueOnce([
      { spaceId: "s1", name: "Alpha", enabled: true },
      { spaceId: "s2", name: "Beta", enabled: false },
    ]);
    groupBy.mockResolvedValueOnce([{ spaceId: "s1", _count: { _all: 12 } }]);

    const out = await svc.listSpaces("ws1");
    expect(out).toEqual({
      spaces: [
        { spaceId: "s1", name: "Alpha", enabled: true, taskCount: 12 },
        { spaceId: "s2", name: "Beta", enabled: false, taskCount: 0 },
      ],
    });
  });
});

describe("KbOnboardingService.scopeOptions", () => {
  it("returns distinct, sorted, null/empty-dropped folders/lists/clients", async () => {
    const { svc, findMany } = makeSvc(null);
    // Order of calls in scopeOptions: folders, lists, clients.
    findMany
      .mockResolvedValueOnce([{ folderName: "Zeta" }, { folderName: null }, { folderName: "Alpha" }, { folderName: "  " }])
      .mockResolvedValueOnce([
        { listId: "l2", listName: "List Two" },
        { listId: "l1", listName: "List One" },
        { listId: null, listName: "Skip" },
        { listId: "l3", listName: null },
      ])
      .mockResolvedValueOnce([{ client: "Beta" }, { client: "Acme" }, { client: null }]);

    const out = await svc.scopeOptions("ws1", ["s1"]);
    expect(out.folders).toEqual(["Alpha", "Zeta"]);
    expect(out.lists).toEqual([
      { listId: "l1", listName: "List One" },
      { listId: "l2", listName: "List Two" },
    ]);
    expect(out.clients).toEqual(["Acme", "Beta"]);
  });
});
