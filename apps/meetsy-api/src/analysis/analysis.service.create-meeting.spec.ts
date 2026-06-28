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

    const service = new AnalysisService(
      prisma as never,
      azure as never,
      {} as never,
      {} as never,
      workspaces as never,
      clickup as never,
      resolver as never,
    );
    return { service, getPersistedRoster: () => persistedRoster, prisma };
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
    // Sarah → Sarah Khan (first-name match).
    expect(res.roster[0].clickupUserId).toBe("42");
    expect(res.roster[0].clickupName).toBe("Sarah Khan");
    // No member matches → stays null.
    expect(res.roster[1].clickupUserId).toBeNull();
    expect(res.roster[1].clickupName).toBeNull();
    // The SAME annotated array is persisted, not a pre-annotation copy.
    expect(getPersistedRoster()).toBe(res.roster);
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
});
