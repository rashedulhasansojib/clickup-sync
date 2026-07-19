import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AnalysisService } from "./analysis.service";

/**
 * v2 SSE progress-polish — `POST /runs/:id/cancel` and `POST /runs/:id/retry`.
 *
 * Cancel semantics:
 *  - Queued  → row settled `cancelled` here + BullMQ job removed + toast fired.
 *  - Running → only `cancelRequestedAt` set; the processor picks it up between
 *              stages and writes the terminal state itself.
 *  - Terminal (completed/failed/cancelled) → 400 (idempotency guard).
 *
 * Retry semantics:
 *  - Only `failed` / `cancelled` runs are retryable → 400 otherwise.
 *  - A fresh AnalysisRun is created against the same Meeting (roster already
 *    confirmed) and enqueued. Mirrors push-retry's "retry = new work" shape.
 */
describe("AnalysisService — cancelRun / retryRun", () => {
  const ORG = "org_1";
  const WS = "ws_default";
  const RUN = "run_1";
  const MEETING = "mtg_1";

  function makeService(overrides: {
    run?: unknown;
    meeting?: unknown;
    removeJobResult?: boolean;
    createdRunId?: string;
  } = {}) {
    const findRun = jest.fn().mockResolvedValue(overrides.run ?? null);
    const updateRun = jest.fn().mockResolvedValue({});
    const findMeeting = jest
      .fn()
      .mockResolvedValue(overrides.meeting ?? { id: MEETING, roster: [{ id: "p1" }] });
    const createRun = jest
      .fn()
      .mockResolvedValue({ id: overrides.createdRunId ?? "run_new" });

    const prisma = {
      analysisRun: { findFirst: findRun, update: updateRun, create: createRun },
      meeting: { findFirst: findMeeting },
    };
    const workspaces = { resolve: jest.fn().mockResolvedValue(WS) };
    const queue = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      removeJob: jest.fn().mockResolvedValue(overrides.removeJobResult ?? true),
    };
    const runNotify = { publish: jest.fn().mockResolvedValue(undefined) };

    const service = new AnalysisService(
      prisma as never,
      {} as never,
      {} as never,
      queue as never,
      workspaces as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runNotify as never,
    );
    return { service, findRun, updateRun, findMeeting, createRun, queue, runNotify };
  }

  // ── cancelRun ──────────────────────────────────────────────────────────

  it("cancelRun — 404 when the run does not exist", async () => {
    const { service } = makeService({ run: null });
    await expect(service.cancelRun(ORG, RUN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "cancelRun — 400 when the run is already terminal (%s)",
    async (status) => {
      const { service } = makeService({
        run: { id: RUN, status, meeting: { title: "Meeting X" } },
      });
      await expect(service.cancelRun(ORG, RUN)).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it("cancelRun — queued: strikes BullMQ, settles row, fires toast", async () => {
    const { service, updateRun, queue, runNotify } = makeService({
      run: { id: RUN, status: "queued", meeting: { title: "Sprint kickoff" } },
    });
    const res = await service.cancelRun(ORG, RUN);
    expect(res).toEqual({ runId: RUN, status: "cancelled" });
    expect(queue.removeJob).toHaveBeenCalledWith(RUN);
    // Row settled immediately (no worker path).
    expect(updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: RUN },
        data: expect.objectContaining({
          status: "cancelled",
          cancelRequestedAt: expect.any(Date),
          finishedAt: expect.any(Date),
        }),
      }),
    );
    // Cross-page toast fires for the user who navigated away.
    expect(runNotify.publish).toHaveBeenCalledWith({
      workspaceId: WS,
      runId: RUN,
      meetingTitle: "Sprint kickoff",
      kind: "cancelled",
    });
  });

  it("cancelRun — running: only sets cancelRequestedAt, worker completes it", async () => {
    const { service, updateRun, queue, runNotify } = makeService({
      run: { id: RUN, status: "running", meeting: { title: "Sprint kickoff" } },
    });
    const res = await service.cancelRun(ORG, RUN);
    // Still `running` on return — the processor writes the terminal state.
    expect(res).toEqual({ runId: RUN, status: "running" });
    expect(queue.removeJob).not.toHaveBeenCalled();
    // No `status` field — only cancelRequestedAt is flipped.
    expect(updateRun).toHaveBeenCalledWith({
      where: { id: RUN },
      data: { cancelRequestedAt: expect.any(Date) },
    });
    // Worker owns the terminal notification; here we stay quiet.
    expect(runNotify.publish).not.toHaveBeenCalled();
  });

  // ── retryRun ───────────────────────────────────────────────────────────

  it("retryRun — 404 when the run does not exist", async () => {
    const { service } = makeService({ run: null });
    await expect(service.retryRun(ORG, RUN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(["queued", "running", "completed"] as const)(
    "retryRun — 400 when the run is %s (not failed/cancelled)",
    async (status) => {
      const { service } = makeService({ run: { id: RUN, status, meetingId: MEETING } });
      await expect(service.retryRun(ORG, RUN)).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it("retryRun — 400 when the meeting has no confirmed roster", async () => {
    const { service } = makeService({
      run: { id: RUN, status: "failed", meetingId: MEETING },
      meeting: { id: MEETING, roster: null },
    });
    await expect(service.retryRun(ORG, RUN)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("retryRun — failed: creates fresh queued run + enqueues + returns new id", async () => {
    const { service, createRun, queue } = makeService({
      run: { id: RUN, status: "failed", meetingId: MEETING },
      createdRunId: "run_fresh",
    });
    const res = await service.retryRun(ORG, RUN);
    expect(res).toEqual({ runId: "run_fresh" });
    expect(createRun).toHaveBeenCalledWith({
      data: {
        orgId: ORG,
        workspaceId: WS,
        meetingId: MEETING,
        status: "queued",
      },
    });
    expect(queue.enqueue).toHaveBeenCalledWith({
      runId: "run_fresh",
      meetingId: MEETING,
      orgId: ORG,
    });
  });

  it("retryRun — cancelled runs are retryable too", async () => {
    const { service, createRun } = makeService({
      run: { id: RUN, status: "cancelled", meetingId: MEETING },
      createdRunId: "run_fresh2",
    });
    const res = await service.retryRun(ORG, RUN);
    expect(res).toEqual({ runId: "run_fresh2" });
    expect(createRun).toHaveBeenCalled();
  });
});
