import type { AssignableMember } from "../clickup/clickup.types";
import { RosterLlmService } from "./roster-llm.service";

/**
 * v2 Phase 7 PR-E — RosterLlmService unit tests. Both Prisma and the Azure
 * client are hand-stubbed; no real HTTP, no real DB.
 */

function makeSvc(opts?: {
  llmResult?: { clickupUserId: string | null; reasoning: string };
  llmError?: Error;
  exemplars?: Array<{ aliasRaw: string; clickupUserId: string }>;
  prismaError?: Error;
}) {
  const structured = jest.fn(async () => {
    if (opts?.llmError) throw opts.llmError;
    return opts?.llmResult ?? { clickupUserId: null, reasoning: "no match" };
  });
  const azure = { structured } as never;

  const findMany = jest.fn(async () => {
    if (opts?.prismaError) throw opts.prismaError;
    return (opts?.exemplars ?? []).map((e) => ({
      aliasRaw: e.aliasRaw,
      clickupUserId: e.clickupUserId,
    }));
  });
  const prisma = { participantAlias: { findMany } } as never;

  const svc = new RosterLlmService(azure, prisma);
  return { svc, structured, findMany };
}

const M: AssignableMember[] = [
  { clickupUserId: "cu_daniel", name: "Daniel Kim" },
  { clickupUserId: "cu_sarah", name: "Sarah Khan" },
  { clickupUserId: "cu_rejaur", name: "Rejaur Rahman" },
];

describe("RosterLlmService.suggest", () => {
  it("returns null when the member allowlist is empty (short-circuits)", async () => {
    const { svc, structured } = makeSvc();
    const out = await svc.suggest({
      workspaceId: "w1",
      displayName: "Dan L.",
      aliases: [],
      members: [],
    });
    expect(out).toBeNull();
    expect(structured).not.toHaveBeenCalled();
  });

  it("returns null on blank displayName without calling the LLM", async () => {
    const { svc, structured } = makeSvc();
    const out = await svc.suggest({
      workspaceId: "w1",
      displayName: "   ",
      aliases: [],
      members: M,
    });
    expect(out).toBeNull();
    expect(structured).not.toHaveBeenCalled();
  });

  it("returns the picked id when it's in the allowlist", async () => {
    const { svc, structured } = makeSvc({
      llmResult: { clickupUserId: "cu_daniel", reasoning: "first name + last initial" },
    });
    const out = await svc.suggest({
      workspaceId: "w1",
      displayName: "Dan L.",
      aliases: [],
      members: M,
    });
    expect(out).toBe("cu_daniel");
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it("returns null (defends against hallucination) when the picked id is not in the allowlist", async () => {
    const { svc } = makeSvc({
      llmResult: { clickupUserId: "cu_bogus", reasoning: "guess" },
    });
    const out = await svc.suggest({
      workspaceId: "w1",
      displayName: "Some Stranger",
      aliases: [],
      members: M,
    });
    expect(out).toBeNull();
  });

  it("returns null when the LLM says null (no confident match)", async () => {
    const { svc } = makeSvc({
      llmResult: { clickupUserId: null, reasoning: "ambiguous" },
    });
    const out = await svc.suggest({
      workspaceId: "w1",
      displayName: "Someone",
      aliases: [],
      members: M,
    });
    expect(out).toBeNull();
  });

  it("swallows LLM errors and returns null (best-effort)", async () => {
    const { svc } = makeSvc({ llmError: new Error("azure timeout") });
    const out = await svc.suggest({
      workspaceId: "w1",
      displayName: "Dan L.",
      aliases: [],
      members: M,
    });
    expect(out).toBeNull();
  });

  it("passes KB exemplars only for members still in the allowlist", async () => {
    const { svc, structured } = makeSvc({
      llmResult: { clickupUserId: "cu_daniel", reasoning: "" },
      exemplars: [
        { aliasRaw: "Dan L.", clickupUserId: "cu_daniel" },
        { aliasRaw: "Ghost", clickupUserId: "cu_departed" }, // not in M — dropped
      ],
    });
    await svc.suggest({
      workspaceId: "w1",
      displayName: "Danny",
      aliases: [],
      members: M,
    });
    const [{ user }] = structured.mock.calls[0] as unknown as [
      { user: string },
    ];
    expect(user).toContain('transcript "Dan L." → Daniel Kim');
    expect(user).not.toContain("cu_departed");
    expect(user).not.toContain("Ghost");
  });

  it("still runs when the exemplar query fails (LLM only gets the allowlist)", async () => {
    const { svc, structured } = makeSvc({
      llmResult: { clickupUserId: "cu_sarah", reasoning: "" },
      prismaError: new Error("db down"),
    });
    const out = await svc.suggest({
      workspaceId: "w1",
      displayName: "Sara",
      aliases: [],
      members: M,
    });
    expect(out).toBe("cu_sarah");
    const [{ user }] = structured.mock.calls[0] as unknown as [
      { user: string },
    ];
    // No exemplars block in the prompt when the KB query failed.
    expect(user).not.toContain("Recent confirmed mappings");
  });

  it("includes aliases in the user prompt when present", async () => {
    const { svc, structured } = makeSvc({
      llmResult: { clickupUserId: null, reasoning: "" },
    });
    await svc.suggest({
      workspaceId: "w1",
      displayName: "Dan",
      aliases: ["Dan L.", "Daniel"],
      members: M,
    });
    const [{ user }] = structured.mock.calls[0] as unknown as [
      { user: string },
    ];
    expect(user).toContain("Dan L.");
    expect(user).toContain("Daniel");
  });
});
