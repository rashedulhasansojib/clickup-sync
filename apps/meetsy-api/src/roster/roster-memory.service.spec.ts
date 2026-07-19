import type { Participant } from "@ma/shared";
import { RosterMemoryService, normalizeAlias } from "./roster-memory.service";

function p(id: string, displayName: string, clickupUserId: string | null = null): Participant {
  return { id, displayName, aliases: [], clickupUserId, clickupName: null };
}

describe("normalizeAlias", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeAlias("  Sarah  Khan  ")).toBe("sarah khan");
  });
  it("strips punctuation (Dan L. and Dan L collide)", () => {
    expect(normalizeAlias("Dan L.")).toBe("dan l");
    expect(normalizeAlias("Dan L")).toBe("dan l");
  });
  it("preserves unicode letters", () => {
    expect(normalizeAlias("Zoë")).toBe("zoë");
  });
  it("returns empty for null/undefined/whitespace", () => {
    expect(normalizeAlias(null)).toBe("");
    expect(normalizeAlias(undefined)).toBe("");
    expect(normalizeAlias("   ")).toBe("");
    expect(normalizeAlias("!!!")).toBe("");
  });
});

describe("RosterMemoryService.learnFromConfirmation (diff)", () => {
  interface UpsertCall {
    where: { workspace_alias_unique: { workspaceId: string; alias: string } };
    create: {
      workspaceId: string;
      alias: string;
      aliasRaw: string;
      clickupUserId: string | null;
      source: string;
      confirmations: number;
      createdBy: string;
    };
    update: {
      source: string;
      confirmations: number | { increment: number };
      clickupUserId: string | null;
      aliasRaw: string;
      lastSeenAt: Date;
    };
  }

  function makeSvc() {
    const calls: UpsertCall[] = [];
    const upsert = jest.fn(async (args: UpsertCall) => {
      calls.push(args);
      return {} as never;
    });
    const prisma = { participantAlias: { upsert } } as never;
    const svc = new RosterMemoryService(prisma);
    return { svc, calls };
  }

  it("KEPT non-null → user_confirmed with confirmations increment", async () => {
    const { svc, calls } = makeSvc();
    const stats = await svc.learnFromConfirmation({
      workspaceId: "w1",
      userId: "u1",
      suggested: [p("p1", "Sarah Khan", "cu_sarah")],
      confirmed: [p("p1", "Sarah Khan", "cu_sarah")],
    });
    expect(stats).toEqual({ learned: 0, corrected: 0, kept: 1, blocklisted: 0, skipped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].where.workspace_alias_unique).toEqual({ workspaceId: "w1", alias: "sarah khan" });
    expect(calls[0].create.source).toBe("user_confirmed");
    expect(calls[0].update.source).toBe("user_confirmed");
    expect(calls[0].update.confirmations).toEqual({ increment: 1 });
    expect(calls[0].update.clickupUserId).toBe("cu_sarah");
  });

  it("CORRECTED (X → Y, both non-null) → user_corrected, counter reset", async () => {
    const { svc, calls } = makeSvc();
    const stats = await svc.learnFromConfirmation({
      workspaceId: "w1",
      userId: "u1",
      suggested: [p("p1", "Dan L", "cu_dan_leary")],
      confirmed: [p("p1", "Dan L", "cu_daniel_kim")],
    });
    expect(stats).toEqual({ learned: 0, corrected: 1, kept: 0, blocklisted: 0, skipped: 0 });
    expect(calls[0].update.source).toBe("user_corrected");
    expect(calls[0].update.confirmations).toBe(1);
    expect(calls[0].update.clickupUserId).toBe("cu_daniel_kim");
  });

  it("LEARNED (null → Y) → user_corrected, first mapping", async () => {
    const { svc, calls } = makeSvc();
    const stats = await svc.learnFromConfirmation({
      workspaceId: "w1",
      userId: "u1",
      suggested: [p("p1", "Rejaur", null)],
      confirmed: [p("p1", "Rejaur", "cu_rejaur")],
    });
    expect(stats).toEqual({ learned: 1, corrected: 0, kept: 0, blocklisted: 0, skipped: 0 });
    expect(calls[0].create.source).toBe("user_corrected");
    expect(calls[0].create.clickupUserId).toBe("cu_rejaur");
  });

  it("CLEARED (X → null) → skip (blocklist is a PR-C explicit action)", async () => {
    const { svc, calls } = makeSvc();
    const stats = await svc.learnFromConfirmation({
      workspaceId: "w1",
      userId: "u1",
      suggested: [p("p1", "Nifty IT", "cu_someone")],
      confirmed: [p("p1", "Nifty IT", null)],
    });
    expect(stats).toEqual({ learned: 0, corrected: 0, kept: 0, blocklisted: 0, skipped: 1 });
    expect(calls).toHaveLength(0);
  });

  it("STAYED-NULL (null → null) → NO-OP", async () => {
    const { svc, calls } = makeSvc();
    const stats = await svc.learnFromConfirmation({
      workspaceId: "w1",
      userId: "u1",
      suggested: [p("p1", "Unknown Speaker", null)],
      confirmed: [p("p1", "Unknown Speaker", null)],
    });
    expect(stats).toEqual({ learned: 0, corrected: 0, kept: 0, blocklisted: 0, skipped: 1 });
    expect(calls).toHaveLength(0);
  });

  it("skips participants with empty/punctuation-only displayName", async () => {
    const { svc, calls } = makeSvc();
    const stats = await svc.learnFromConfirmation({
      workspaceId: "w1",
      userId: "u1",
      suggested: [p("p1", "   ", "cu_a"), p("p2", "!!!", null)],
      confirmed: [p("p1", "   ", "cu_a"), p("p2", "!!!", "cu_b")],
    });
    expect(stats).toEqual({ learned: 0, corrected: 0, kept: 0, blocklisted: 0, skipped: 2 });
    expect(calls).toHaveLength(0);
  });

  it("normalizes displayName variants to the same alias key", async () => {
    const { svc, calls } = makeSvc();
    await svc.learnFromConfirmation({
      workspaceId: "w1",
      userId: "u1",
      suggested: [p("p1", "Dan L.", null)],
      confirmed: [p("p1", "Dan L.", "cu_dan")],
    });
    expect(calls[0].where.workspace_alias_unique.alias).toBe("dan l");
    expect(calls[0].create.aliasRaw).toBe("Dan L."); // original casing preserved for display
  });

  it("handles a mixed batch of KEPT + CORRECTED + LEARNED + skipped", async () => {
    const { svc, calls } = makeSvc();
    const stats = await svc.learnFromConfirmation({
      workspaceId: "w1",
      userId: "u1",
      suggested: [
        p("p1", "Sarah Khan", "cu_sarah"), // KEPT
        p("p2", "Dan L", "cu_dan_leary"), //  CORRECTED
        p("p3", "Rejaur", null), //            LEARNED
        p("p4", "Nifty IT", "cu_someone"), //  CLEARED → skip
        p("p5", "Unknown", null), //           STAYED-NULL → skip
      ],
      confirmed: [
        p("p1", "Sarah Khan", "cu_sarah"),
        p("p2", "Dan L", "cu_daniel_kim"),
        p("p3", "Rejaur", "cu_rejaur"),
        p("p4", "Nifty IT", null),
        p("p5", "Unknown", null),
      ],
    });
    expect(stats).toEqual({ learned: 1, corrected: 1, kept: 1, blocklisted: 0, skipped: 2 });
    expect(calls).toHaveLength(3);
  });

  it("EXPLICIT BLOCKLIST (blocklist=true + null) → user_blocklisted write", async () => {
    const { svc, calls } = makeSvc();
    const stats = await svc.learnFromConfirmation({
      workspaceId: "w1",
      userId: "u1",
      suggested: [p("p1", "Nifty IT", "cu_someone")],
      confirmed: [{ ...p("p1", "Nifty IT", null), blocklist: true }],
    });
    expect(stats).toEqual({ learned: 0, corrected: 0, kept: 0, blocklisted: 1, skipped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].create.source).toBe("user_blocklisted");
    expect(calls[0].create.clickupUserId).toBeNull();
    expect(calls[0].update.source).toBe("user_blocklisted");
    expect(calls[0].update.clickupUserId).toBeNull();
    expect(calls[0].update.confirmations).toBe(1);
  });

  it("EXPLICIT BLOCKLIST works even when there was no prior suggestion (null → blocklist)", async () => {
    const { svc, calls } = makeSvc();
    const stats = await svc.learnFromConfirmation({
      workspaceId: "w1",
      userId: "u1",
      suggested: [p("p1", "Auto Bot", null)],
      confirmed: [{ ...p("p1", "Auto Bot", null), blocklist: true }],
    });
    expect(stats.blocklisted).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].create.source).toBe("user_blocklisted");
  });

  it("swallows a Prisma error and counts as skipped (best-effort)", async () => {
    const upsert = jest.fn(async () => {
      throw new Error("DB blew up");
    });
    const prisma = { participantAlias: { upsert } } as never;
    const svc = new RosterMemoryService(prisma);
    const stats = await svc.learnFromConfirmation({
      workspaceId: "w1",
      userId: "u1",
      suggested: [p("p1", "Sarah", null)],
      confirmed: [p("p1", "Sarah", "cu_sarah")],
    });
    expect(stats).toEqual({ learned: 0, corrected: 0, kept: 0, blocklisted: 0, skipped: 1 });
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe("RosterMemoryService.suggest (KB lookup)", () => {
  it("returns a mapping hit with confirmations", async () => {
    const findUnique = jest.fn(async () => ({ clickupUserId: "cu_x", confirmations: 5 }));
    const prisma = { participantAlias: { findUnique } } as never;
    const svc = new RosterMemoryService(prisma);
    const out = await svc.suggest("w1", "Dan L.");
    expect(out).toEqual({ clickupUserId: "cu_x", source: "kb", confirmations: 5 });
    expect(findUnique).toHaveBeenCalledWith({
      where: { workspace_alias_unique: { workspaceId: "w1", alias: "dan l" } },
      select: { clickupUserId: true, confirmations: true },
    });
  });

  it("returns a blocklist hit (clickupUserId=null, source=kb)", async () => {
    const findUnique = jest.fn(async () => ({ clickupUserId: null, confirmations: 1 }));
    const prisma = { participantAlias: { findUnique } } as never;
    const svc = new RosterMemoryService(prisma);
    const out = await svc.suggest("w1", "Nifty IT");
    expect(out).toEqual({ clickupUserId: null, source: "kb", confirmations: 1 });
  });

  it("returns null when the row does not exist", async () => {
    const findUnique = jest.fn(async () => null);
    const prisma = { participantAlias: { findUnique } } as never;
    const svc = new RosterMemoryService(prisma);
    expect(await svc.suggest("w1", "Nobody")).toBe(null);
  });

  it("returns null for empty/blank names", async () => {
    const findUnique = jest.fn(async () => null);
    const prisma = { participantAlias: { findUnique } } as never;
    const svc = new RosterMemoryService(prisma);
    expect(await svc.suggest("w1", "   ")).toBe(null);
    expect(await svc.suggest("w1", "")).toBe(null);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("swallows Prisma errors and returns null (best-effort)", async () => {
    const findUnique = jest.fn(async () => {
      throw new Error("DB blew up");
    });
    const prisma = { participantAlias: { findUnique } } as never;
    const svc = new RosterMemoryService(prisma);
    expect(await svc.suggest("w1", "Sarah")).toBe(null);
  });
});
