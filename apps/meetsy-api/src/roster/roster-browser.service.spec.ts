import { ConflictException, NotFoundException } from "@nestjs/common";
import type { ParticipantAlias } from "@prisma/client";
import { RosterBrowserService } from "./roster-browser.service";

/**
 * v2 Phase 7 PR-D — RosterBrowserService unit tests. Prisma + ClickUp are
 * hand-stubbed to keep this a pure-code test: no DB, no HTTP.
 */

function row(overrides: Partial<ParticipantAlias> = {}): ParticipantAlias {
  // Use spread so `null` overrides for `clickupUserId` are honored (`?? "cu_sarah"`
  // would drop the null).
  return {
    id: "a1",
    workspaceId: "w1",
    alias: "sarah khan",
    aliasRaw: "Sarah Khan",
    clickupUserId: "cu_sarah",
    source: "user_confirmed",
    confirmations: 3,
    lastSeenAt: new Date("2026-07-18T12:00:00Z"),
    createdBy: "u1",
    createdAt: new Date("2026-07-01T12:00:00Z"),
    updatedAt: new Date("2026-07-18T12:00:00Z"),
    ...overrides,
  } as ParticipantAlias;
}

function makeSvc(opts?: {
  members?: Array<{ clickupUserId: string; name: string }>;
  membersFail?: boolean;
}) {
  const findMany = jest.fn(async () => [] as ParticipantAlias[]);
  const findUnique = jest.fn(async () => null as ParticipantAlias | null);
  const findFirst = jest.fn(async () => null as ParticipantAlias | null);
  const count = jest.fn(async () => 0);
  const upsert = jest.fn(async () => row());
  const update = jest.fn(async () => row());
  const create = jest.fn(async () => row());
  const del = jest.fn(async () => row());
  const prisma = {
    participantAlias: {
      findMany,
      findUnique,
      findFirst,
      count,
      upsert,
      update,
      create,
      delete: del,
    },
  } as never;
  const clickup = {
    getAssignableMembers: jest.fn(async () => {
      if (opts?.membersFail) throw new Error("no token");
      return opts?.members ?? [];
    }),
  } as never;
  const svc = new RosterBrowserService(prisma, clickup);
  return { svc, prisma: { findMany, findUnique, findFirst, count, upsert, update, create, delete: del }, clickup };
}

describe("RosterBrowserService.list", () => {
  it("returns joined clickupName when the member is still allowlisted", async () => {
    const { svc, prisma } = makeSvc({
      members: [{ clickupUserId: "cu_sarah", name: "Sarah Khan" }],
    });
    prisma.findMany.mockResolvedValueOnce([row()]);
    prisma.count.mockResolvedValueOnce(1);
    const page = await svc.list("w1", {});
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.clickupName).toBe("Sarah Khan");
    expect(page.total).toBe(1);
    expect(page.nextCursor).toBeNull();
  });

  it("clickupName=null when the mapping points at a departed member", async () => {
    const { svc, prisma } = makeSvc({ members: [] });
    prisma.findMany.mockResolvedValueOnce([row()]);
    prisma.count.mockResolvedValueOnce(1);
    const page = await svc.list("w1", {});
    expect(page.rows[0]!.clickupName).toBeNull();
  });

  it("blocklist row surfaces with clickupName=null and source=user_blocklisted", async () => {
    const { svc, prisma } = makeSvc();
    prisma.findMany.mockResolvedValueOnce([
      row({ clickupUserId: null, source: "user_blocklisted", aliasRaw: "Nifty IT" }),
    ]);
    prisma.count.mockResolvedValueOnce(1);
    const page = await svc.list("w1", {});
    expect(page.rows[0]!.source).toBe("user_blocklisted");
    expect(page.rows[0]!.clickupUserId).toBeNull();
    expect(page.rows[0]!.clickupName).toBeNull();
  });

  it("emits nextCursor when there are more rows", async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      row({ id: `a${i}`, alias: `alias${i}`, aliasRaw: `Alias ${i}` }),
    );
    const { svc, prisma } = makeSvc();
    prisma.findMany.mockResolvedValueOnce(rows);
    prisma.count.mockResolvedValueOnce(3);
    const page = await svc.list("w1", { limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it("swallows ClickUp errors and still returns rows (no join)", async () => {
    const { svc, prisma } = makeSvc({ membersFail: true });
    prisma.findMany.mockResolvedValueOnce([row()]);
    prisma.count.mockResolvedValueOnce(1);
    const page = await svc.list("w1", {});
    expect(page.rows[0]!.clickupName).toBeNull();
  });
});

describe("RosterBrowserService.create", () => {
  it("normalizes alias and upserts as admin_seeded when clickupUserId is set", async () => {
    const { svc, prisma } = makeSvc();
    prisma.upsert.mockResolvedValueOnce(
      row({ aliasRaw: "Dan L.", alias: "dan l", source: "admin_seeded", clickupUserId: "cu_x" }),
    );
    const out = await svc.create("w1", "u1", {
      aliasRaw: "Dan L.",
      clickupUserId: "cu_x",
    });
    expect(prisma.upsert).toHaveBeenCalledTimes(1);
    const args = (prisma.upsert.mock.calls as unknown as unknown[][])[0][0] as {
      where: { workspace_alias_unique: { workspaceId: string; alias: string } };
      create: { source: string; clickupUserId: string | null; confirmations: number };
    };
    expect(args.where.workspace_alias_unique.alias).toBe("dan l");
    expect(args.create.source).toBe("admin_seeded");
    expect(args.create.clickupUserId).toBe("cu_x");
    expect(args.create.confirmations).toBe(1);
    expect(out.source).toBe("admin_seeded");
  });

  it("writes user_blocklisted when clickupUserId is null", async () => {
    const { svc, prisma } = makeSvc();
    prisma.upsert.mockResolvedValueOnce(
      row({ clickupUserId: null, source: "user_blocklisted", aliasRaw: "Nifty IT", alias: "nifty it" }),
    );
    await svc.create("w1", "u1", { aliasRaw: "Nifty IT", clickupUserId: null });
    const args = (prisma.upsert.mock.calls as unknown as unknown[][])[0][0] as {
      create: { source: string; clickupUserId: string | null };
    };
    expect(args.create.source).toBe("user_blocklisted");
    expect(args.create.clickupUserId).toBeNull();
  });

  it("rejects an empty-normalized alias", async () => {
    const { svc } = makeSvc();
    await expect(
      svc.create("w1", "u1", { aliasRaw: "!!!", clickupUserId: "cu_x" }),
    ).rejects.toThrow(ConflictException);
  });
});

describe("RosterBrowserService.update", () => {
  it("404s on missing row", async () => {
    const { svc, prisma } = makeSvc();
    prisma.findFirst.mockResolvedValueOnce(null);
    await expect(
      svc.update("w1", "nope", { clickupUserId: "cu_x" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("changing clickupUserId to null flips source to user_blocklisted", async () => {
    const { svc, prisma } = makeSvc();
    prisma.findFirst.mockResolvedValueOnce(row({ source: "user_confirmed" }));
    prisma.update.mockResolvedValueOnce(
      row({ clickupUserId: null, source: "user_blocklisted" }),
    );
    await svc.update("w1", "a1", { clickupUserId: null });
    const args = (prisma.update.mock.calls as unknown as unknown[][])[0][0] as {
      data: { source: string; clickupUserId: string | null };
    };
    expect(args.data.source).toBe("user_blocklisted");
    expect(args.data.clickupUserId).toBeNull();
  });

  it("changing clickupUserId to a member flips source to admin_seeded", async () => {
    const { svc, prisma } = makeSvc();
    prisma.findFirst.mockResolvedValueOnce(row({ source: "user_blocklisted", clickupUserId: null }));
    prisma.update.mockResolvedValueOnce(
      row({ clickupUserId: "cu_new", source: "admin_seeded" }),
    );
    await svc.update("w1", "a1", { clickupUserId: "cu_new" });
    const args = (prisma.update.mock.calls as unknown as unknown[][])[0][0] as {
      data: { source: string; clickupUserId: string | null };
    };
    expect(args.data.source).toBe("admin_seeded");
  });

  it("aliasRaw-only edit does not change source", async () => {
    const { svc, prisma } = makeSvc();
    prisma.findFirst.mockResolvedValueOnce(row({ source: "user_confirmed" }));
    prisma.update.mockResolvedValueOnce(row());
    await svc.update("w1", "a1", { aliasRaw: "Sarah Kahn" });
    const args = (prisma.update.mock.calls as unknown as unknown[][])[0][0] as {
      data: { source: string; aliasRaw?: string };
    };
    expect(args.data.source).toBe("user_confirmed");
    expect(args.data.aliasRaw).toBe("Sarah Kahn");
  });
});

describe("RosterBrowserService.delete", () => {
  it("404s on missing row", async () => {
    const { svc, prisma } = makeSvc();
    prisma.findFirst.mockResolvedValueOnce(null);
    await expect(svc.delete("w1", "nope")).rejects.toThrow(NotFoundException);
  });

  it("deletes when present", async () => {
    const { svc, prisma } = makeSvc();
    prisma.findFirst.mockResolvedValueOnce(row());
    await svc.delete("w1", "a1");
    expect(prisma.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
  });
});

describe("RosterBrowserService.bulkImport", () => {
  it("splits into imported vs updated by presence, and skips empty aliases", async () => {
    const { svc, prisma } = makeSvc();
    // "Sarah Khan" (new), "Dan L." (existing → update), "!!!" (skipped)
    prisma.findUnique
      .mockResolvedValueOnce(null) // sarah khan
      .mockResolvedValueOnce({ id: "aX" } as ParticipantAlias); // dan l
    prisma.create.mockResolvedValueOnce(row());
    prisma.update.mockResolvedValueOnce(row());

    const result = await svc.bulkImport("w1", "u1", {
      rows: [
        { aliasRaw: "Sarah Khan", clickupUserId: "cu_sarah" },
        { aliasRaw: "Dan L.", clickupUserId: "cu_dan" },
        { aliasRaw: "!!!", clickupUserId: "cu_x" },
      ],
    });
    expect(result).toEqual({ imported: 1, updated: 1, skipped: 1 });
  });

  it("collides duplicates within the batch (last row wins)", async () => {
    const { svc, prisma } = makeSvc();
    prisma.findUnique.mockResolvedValueOnce(null);
    prisma.create.mockResolvedValueOnce(row());
    const result = await svc.bulkImport("w1", "u1", {
      rows: [
        { aliasRaw: "Sarah Khan", clickupUserId: "cu_first" },
        { aliasRaw: "Sarah Khan", clickupUserId: "cu_last" },
      ],
    });
    // Both rows normalize to "sarah khan" — one collapse, so one write.
    expect(result.imported + result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    const createArgs = (prisma.create.mock.calls as unknown as unknown[][])[0][0] as {
      data: { clickupUserId: string | null };
    };
    expect(createArgs.data.clickupUserId).toBe("cu_last");
  });

  it("treats missing clickupUserId as blocklist (null)", async () => {
    const { svc, prisma } = makeSvc();
    prisma.findUnique.mockResolvedValueOnce(null);
    prisma.create.mockResolvedValueOnce(row());
    await svc.bulkImport("w1", "u1", {
      rows: [{ aliasRaw: "Nifty IT" }],
    });
    const createArgs = (prisma.create.mock.calls as unknown as unknown[][])[0][0] as {
      data: { clickupUserId: string | null; source: string };
    };
    expect(createArgs.data.clickupUserId).toBeNull();
    expect(createArgs.data.source).toBe("user_blocklisted");
  });

  it("swallows per-row Prisma errors and counts them as skipped", async () => {
    const { svc, prisma } = makeSvc();
    prisma.findUnique.mockRejectedValueOnce(new Error("db down"));
    const result = await svc.bulkImport("w1", "u1", {
      rows: [{ aliasRaw: "Sarah Khan", clickupUserId: "cu_sarah" }],
    });
    expect(result).toEqual({ imported: 0, updated: 0, skipped: 1 });
  });
});
