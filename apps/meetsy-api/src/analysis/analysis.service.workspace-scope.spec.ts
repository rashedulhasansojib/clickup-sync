import { NotFoundException } from "@nestjs/common";
import { AnalysisService } from "./analysis.service";

/**
 * Phase-1 workspace-isolation contract (the foundation slice).
 *
 * Every run/meeting read resolves `?workspaceId=` to a concrete workspace (the
 * org default when absent) and scopes the lookup to `{ id, orgId, workspaceId }`.
 * A run that lives in a DIFFERENT workspace must read as 404 — never returned,
 * never 403 (403 would leak the run's existence across workspaces). These tests
 * lock that behavior so a future refactor can't silently widen the scope back to
 * org-only (which is what the now-removed `TODO(phase1)` left in place).
 */
describe("AnalysisService — workspace scoping", () => {
  const ORG = "org_seed";
  const DEFAULT_WS = "ws_default";
  const OTHER_WS = "ws_other";

  function makeService(opts: {
    resolvedWorkspaceId: string;
    runRow: unknown; // what prisma.analysisRun.findFirst resolves to
    chatRows?: unknown[];
  }) {
    const findFirst = jest.fn().mockResolvedValue(opts.runRow);
    const chatFindMany = jest.fn().mockResolvedValue(opts.chatRows ?? []);
    const prisma = {
      analysisRun: { findFirst },
      chatMessage: { findMany: chatFindMany },
    };
    const resolve = jest.fn().mockResolvedValue(opts.resolvedWorkspaceId);
    const workspaces = { resolve };

    // azure / config / queue / clickup / resolver are unused on the read paths
    // under test — minimal stubs.
    const service = new AnalysisService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      workspaces as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, findFirst, resolve, chatFindMany };
  }

  it("getRun: resolves the workspace and scopes the lookup to {id, orgId, workspaceId}", async () => {
    const runRow = {
      id: "run_1",
      meetingId: "mtg_1",
      status: "completed",
      result: null,
      error: null,
    };
    const { service, findFirst, resolve } = makeService({
      resolvedWorkspaceId: DEFAULT_WS,
      runRow,
    });

    const res = await service.getRun(ORG, "run_1", undefined);

    expect(resolve).toHaveBeenCalledWith(ORG, undefined);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "run_1", orgId: ORG, workspaceId: DEFAULT_WS },
    });
    expect(res.runId).toBe("run_1");
    expect(res.result).toBeNull();
  });

  it("getRun: a run in another workspace reads as 404 (not returned)", async () => {
    // The explicit ?workspaceId= resolves to OTHER_WS, but the run lives in a
    // different workspace, so the scoped findFirst returns null.
    const { service, resolve, findFirst } = makeService({
      resolvedWorkspaceId: OTHER_WS,
      runRow: null,
    });

    await expect(service.getRun(ORG, "run_in_default_ws", OTHER_WS)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(resolve).toHaveBeenCalledWith(ORG, OTHER_WS);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "run_in_default_ws", orgId: ORG, workspaceId: OTHER_WS },
    });
  });

  it("getChat: a run in another workspace reads as 404 and never reaches chatMessage.findMany", async () => {
    const { service, chatFindMany } = makeService({
      resolvedWorkspaceId: OTHER_WS,
      runRow: null,
    });

    await expect(service.getChat(ORG, "run_x", OTHER_WS)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // The 404 short-circuits before any message read — no cross-workspace leak.
    expect(chatFindMany).not.toHaveBeenCalled();
  });
});
