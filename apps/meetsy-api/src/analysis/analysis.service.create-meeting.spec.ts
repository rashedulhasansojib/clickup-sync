import type { CreateMeetingRequest } from "@ma/shared";
import { AnalysisService } from "./analysis.service";
import { AssigneeResolverService } from "../clickup/assignee-resolver.service";

/**
 * createMeeting annotates each roster participant with a SUGGESTED ClickUp member
 * (transcript name → workspace member) so the user confirms (not types) the
 * assignee mapping at the roster step — and degrades to null when ClickUp is
 * unreachable, never blocking meeting creation.
 */
describe("AnalysisService.createMeeting — ClickUp member suggestion", () => {
  const ORG = "org_seed";
  const WS = "ws_default";

  function makeService(opts: {
    rosterParticipants: Array<{ displayName: string; aliases: string[] }>;
    getAssignableMembers: jest.Mock;
    rosterMemory?: {
      suggest: jest.Mock;
    };
    rosterLlm?: {
      suggest: jest.Mock;
    };
  }) {
    // buildRoster (plain-text path) makes a single azure.structured() call.
    const azure = {
      structured: jest.fn().mockResolvedValue({ participants: opts.rosterParticipants }),
    };

    let persistedRoster: unknown = null;
    const prisma = {
      meeting: {
        create: jest.fn().mockImplementation(async ({ data }: { data: { roster: unknown } }) => {
          persistedRoster = data.roster;
          return { id: "mtg_1" };
        }),
      },
      analysisRun: { create: jest.fn().mockResolvedValue({ id: "run_1" }) },
    };
    const workspaces = { resolve: jest.fn().mockResolvedValue(WS) };
    const clickup = { getAssignableMembers: opts.getAssignableMembers };
    // Use the real resolver — its matching is what we want to exercise.
    const resolver = new AssigneeResolverService();
    // Default rosterMemory: always miss (KB empty). Individual tests override.
    const rosterMemory = opts.rosterMemory ?? { suggest: jest.fn().mockResolvedValue(null) };
    // Default rosterLlm: always miss. Individual tests override to exercise the
    // tier-3 fallback.
    const rosterLlm = opts.rosterLlm ?? { suggest: jest.fn().mockResolvedValue(null) };

    const service = new AnalysisService(
      prisma as never,
      azure as never,
      {} as never,
      {} as never,
      workspaces as never,
      clickup as never,
      resolver as never,
      rosterMemory as never,
      rosterLlm as never,
    );
    return {
      service,
      getPersistedRoster: () => persistedRoster,
      prisma,
      rosterMemory,
      rosterLlm,
    };
  }

  const body: CreateMeetingRequest = {
    title: "Weekly sync",
    transcript: "Sarah will build the portal. Dan will write the docs.",
  };

  it("annotates participants with the matched member id + name (persisted and returned)", async () => {
    const getAssignableMembers = jest.fn().mockResolvedValue([
      { clickupUserId: "42", name: "Sarah Khan", email: "sarah@x.com" },
      { clickupUserId: "99", name: "Dan Leary", email: "dan@x.com" },
    ]);
    const { service, getPersistedRoster } = makeService({
      rosterParticipants: [
        { displayName: "Sarah", aliases: [] },
        { displayName: "Unknown Person", aliases: [] },
      ],
      getAssignableMembers,
    });

    const res = await service.createMeeting(ORG, body, undefined);

    expect(getAssignableMembers).toHaveBeenCalledWith(WS);
    // Sarah → Sarah Khan (first-name match; KB is empty so it falls to heuristic).
    expect(res.roster[0].clickupUserId).toBe("42");
    expect(res.roster[0].clickupName).toBe("Sarah Khan");
    expect(res.roster[0].source).toBe("heuristic");
    // No member matches → stays null, tagged as `none`.
    expect(res.roster[1].clickupUserId).toBeNull();
    expect(res.roster[1].clickupName).toBeNull();
    expect(res.roster[1].source).toBe("none");
    // The SAME annotated array is persisted, not a pre-annotation copy.
    expect(getPersistedRoster()).toBe(res.roster);
  });

  it("KB hit shortcuts the heuristic (source=kb, confirmations passed through)", async () => {
    const getAssignableMembers = jest.fn().mockResolvedValue([
      { clickupUserId: "42", name: "Sarah Khan", email: "sarah@x.com" },
      { clickupUserId: "77", name: "Daniel Kim", email: "daniel@x.com" },
      { clickupUserId: "99", name: "Dan Leary", email: "dan@x.com" },
    ]);
    // KB: "dan l" → Daniel Kim (a prior CORRECTION away from Dan Leary).
    const suggest = jest.fn().mockImplementation((_ws: string, name: string) => {
      if (name.toLowerCase() === "dan l") {
        return Promise.resolve({ clickupUserId: "77", source: "kb", confirmations: 4 });
      }
      return Promise.resolve(null);
    });
    const { service } = makeService({
      rosterParticipants: [{ displayName: "Dan L", aliases: [] }],
      getAssignableMembers,
      rosterMemory: { suggest },
    });

    const res = await service.createMeeting(ORG, body, undefined);

    // KB wins over the heuristic (which would have picked Dan Leary via first-name).
    expect(res.roster[0].clickupUserId).toBe("77");
    expect(res.roster[0].clickupName).toBe("Daniel Kim");
    expect(res.roster[0].source).toBe("kb");
    expect(res.roster[0].confirmations).toBe(4);
    expect(suggest).toHaveBeenCalled();
  });

  it("KB blocklist row (clickupUserId=null) forces Unassigned and skips heuristic", async () => {
    const getAssignableMembers = jest
      .fn()
      .mockResolvedValue([{ clickupUserId: "42", name: "Sarah Khan" }]);
    const suggest = jest
      .fn()
      .mockResolvedValue({ clickupUserId: null, source: "kb", confirmations: 1 });
    const { service } = makeService({
      rosterParticipants: [{ displayName: "Sarah", aliases: [] }],
      getAssignableMembers,
      rosterMemory: { suggest },
    });

    const res = await service.createMeeting(ORG, body, undefined);
    // Heuristic would have matched Sarah Khan; blocklist blocks it.
    expect(res.roster[0].clickupUserId).toBeNull();
    expect(res.roster[0].clickupName).toBeNull();
    expect(res.roster[0].source).toBe("kb");
  });

  it("KB hit to a departed member falls through to heuristic", async () => {
    const getAssignableMembers = jest
      .fn()
      .mockResolvedValue([{ clickupUserId: "42", name: "Sarah Khan" }]);
    // KB says "sarah" → user 99, but 99 is no longer allowlisted.
    const suggest = jest
      .fn()
      .mockResolvedValue({ clickupUserId: "99", source: "kb", confirmations: 2 });
    const { service } = makeService({
      rosterParticipants: [{ displayName: "Sarah", aliases: [] }],
      getAssignableMembers,
      rosterMemory: { suggest },
    });

    const res = await service.createMeeting(ORG, body, undefined);
    // Heuristic picks the still-allowlisted Sarah Khan.
    expect(res.roster[0].clickupUserId).toBe("42");
    expect(res.roster[0].source).toBe("heuristic");
  });

  it("matches on an alias when the displayName misses", async () => {
    const getAssignableMembers = jest
      .fn()
      .mockResolvedValue([{ clickupUserId: "42", name: "Sarah Khan", email: "sarah@x.com" }]);
    const { service } = makeService({
      rosterParticipants: [{ displayName: "Speaker 2", aliases: ["Sarah"] }],
      getAssignableMembers,
    });

    const res = await service.createMeeting(ORG, body, undefined);
    expect(res.roster[0].clickupUserId).toBe("42");
    expect(res.roster[0].source).toBe("heuristic");
  });

  it("degrades to null clickupUserId when the members fetch throws (no ClickUp connection)", async () => {
    const getAssignableMembers = jest.fn().mockRejectedValue(new Error("no token"));
    const { service } = makeService({
      rosterParticipants: [{ displayName: "Sarah", aliases: [] }],
      getAssignableMembers,
    });

    const res = await service.createMeeting(ORG, body, undefined);
    // Meeting still creates; participant left unannotated.
    expect(res.meetingId).toBe("mtg_1");
    expect(res.roster[0].clickupUserId).toBeNull();
    expect(res.roster[0].clickupName).toBeNull();
  });

  it("LLM tier fires only when KB + heuristic both miss (source=llm)", async () => {
    const getAssignableMembers = jest.fn().mockResolvedValue([
      { clickupUserId: "42", name: "Daniel Kim" },
    ]);
    const rosterLlm = { suggest: jest.fn().mockResolvedValue("42") };
    const { service, rosterMemory } = makeService({
      // Neither the display name nor the heuristic can resolve "Danny Boi" to
      // "Daniel Kim" without help.
      rosterParticipants: [{ displayName: "Danny Boi", aliases: [] }],
      getAssignableMembers,
      rosterLlm,
    });

    const res = await service.createMeeting(ORG, body, undefined);
    expect(rosterMemory.suggest).toHaveBeenCalled();
    expect(rosterLlm.suggest).toHaveBeenCalledTimes(1);
    expect(res.roster[0].clickupUserId).toBe("42");
    expect(res.roster[0].clickupName).toBe("Daniel Kim");
    expect(res.roster[0].source).toBe("llm");
  });

  it("LLM tier is SKIPPED when the heuristic already matched (source=heuristic)", async () => {
    const getAssignableMembers = jest.fn().mockResolvedValue([
      { clickupUserId: "42", name: "Sarah Khan" },
    ]);
    const rosterLlm = { suggest: jest.fn().mockResolvedValue("42") };
    const { service } = makeService({
      rosterParticipants: [{ displayName: "Sarah", aliases: [] }],
      getAssignableMembers,
      rosterLlm,
    });

    const res = await service.createMeeting(ORG, body, undefined);
    expect(rosterLlm.suggest).not.toHaveBeenCalled();
    expect(res.roster[0].source).toBe("heuristic");
  });

  it("LLM returning an out-of-allowlist id is defended against (source=none)", async () => {
    const getAssignableMembers = jest.fn().mockResolvedValue([
      { clickupUserId: "42", name: "Daniel Kim" },
    ]);
    // Service returns an id NOT in the members list — the LLM path already
    // filters this out and returns null, but assert one more layer of defense.
    const rosterLlm = { suggest: jest.fn().mockResolvedValue("cu_ghost") };
    const { service } = makeService({
      rosterParticipants: [{ displayName: "Danny Boi", aliases: [] }],
      getAssignableMembers,
      rosterLlm,
    });

    const res = await service.createMeeting(ORG, body, undefined);
    expect(res.roster[0].clickupUserId).toBeNull();
    expect(res.roster[0].source).toBe("none");
  });
});
