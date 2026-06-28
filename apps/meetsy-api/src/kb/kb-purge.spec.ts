import { KbProcessor } from "./kb.processor";
import type { PrismaService } from "../prisma/prisma.service";
import type { ConfigService } from "../config/config.service";
import type { AzureEmbeddingService } from "../azure/azure-embedding.service";
import type { KbOnboardingService } from "./kb-onboarding.service";
import type { KbQueue } from "./kb.queue";
import type { KbScope } from "./kb.dto";

/**
 * Build a KbProcessor with mocked prisma whose task scan returns no rows, so
 * embedWorkspace() falls straight through the embed loop to the purge-on-narrow
 * block. The scan call and the in-scope lookup both hit clickupTask.findMany; we
 * sequence them with mockResolvedValueOnce (scan first → [], then in-scope).
 */
function makeProc(opts: {
  inScope?: Array<{ taskId: string }>;
}) {
  const findUnique = jest.fn().mockResolvedValue({ lastTaskCursor: new Date("2020-01-01T00:00:00.000Z") });
  const count = jest.fn().mockResolvedValue(0);
  const findMany = jest
    .fn()
    // 1) the page scan — empty so the embed loop breaks immediately
    .mockResolvedValueOnce([])
    // 2) the in-scope lookup used by the purge block (only reached for a scope)
    .mockResolvedValueOnce(opts.inScope ?? []);
  const update = jest.fn().mockResolvedValue({});
  const deleteMany = jest.fn().mockResolvedValue({ count: 3 });

  const prisma = {
    kbSyncState: { findUnique, update },
    clickupTask: { count, findMany },
    kbChunk: { deleteMany },
  } as unknown as PrismaService;
  const config = { get: jest.fn().mockReturnValue("embed-deploy") } as unknown as ConfigService;

  const proc = new KbProcessor(
    config,
    prisma,
    {} as unknown as AzureEmbeddingService,
    {} as unknown as KbOnboardingService,
    {} as unknown as KbQueue,
  );
  // embedWorkspace is private; invoke it directly to exercise the purge branch.
  const embedWorkspace = (workspaceId: string, scope?: KbScope) =>
    (proc as unknown as {
      embedWorkspace: (w: string, r: string, s?: KbScope) => Promise<number>;
    }).embedWorkspace(workspaceId, "3m", scope);

  return { embedWorkspace, findMany, deleteMany };
}

describe("KbProcessor purge-on-narrow", () => {
  it("does NOT purge for an empty/absent scope (whole-workspace embed)", async () => {
    const { embedWorkspace, findMany, deleteMany } = makeProc({});
    await embedWorkspace("ws1", undefined);

    // Only the page scan ran — no in-scope lookup, no deleteMany.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("SKIPS the purge (no deleteMany) when a non-empty scope matches 0 mirrored tasks", async () => {
    const { embedWorkspace, deleteMany } = makeProc({ inScope: [] });
    await embedWorkspace("ws1", { spaceIds: ["s1"] });

    // notIn:[] would wipe every task chunk — the guard must skip instead.
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("deletes only out-of-scope clickup_task chunks when narrowing (documents untouched)", async () => {
    const { embedWorkspace, deleteMany } = makeProc({
      inScope: [{ taskId: "a" }, { taskId: "b" }],
    });
    await embedWorkspace("ws1", { spaceIds: ["s1"] });

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws1",
        // sourceType filter is what keeps `document` chunks safe.
        sourceType: "clickup_task",
        sourceId: { notIn: ["a", "b"] },
      },
    });
  });
});
