import { TasksLookupService } from "./tasks-lookup.service";

/**
 * v2 Phase 0 — the task-lookup endpoint that hydrates ClickUp chips in the
 * review UI. Cross-workspace / cross-org / soft-deleted / missing rows all
 * return null (200) so a chip pointing at a task predating the KB sync (or a
 * task deleted since) degrades to "unavailable" instead of an error banner.
 */
describe("TasksLookupService", () => {
  const WS = "ws_default";
  const OTHER_WS = "ws_other";

  function makeService(findResult: unknown) {
    const findUnique = jest.fn().mockResolvedValue(findResult);
    const prisma = { clickupTask: { findUnique } };
    const service = new TasksLookupService(prisma as never);
    return { service, findUnique };
  }

  it("returns the view when the task is in this workspace", async () => {
    const updatedAt = new Date("2026-07-01T09:30:00Z");
    const { service, findUnique } = makeService({
      taskId: "CU-1",
      workspaceId: WS,
      taskName: "Refactor OAuth bounce",
      status: "in progress",
      assigneesNames: "Alice, Bob",
      url: "https://app.clickup.com/t/CU-1",
      updatedDate: updatedAt,
      isDeleted: false,
    });

    const view = await service.forWorkspace(WS, "CU-1");

    expect(findUnique).toHaveBeenCalledWith({
      where: { taskId: "CU-1" },
      select: expect.any(Object),
    });
    expect(view).toEqual({
      id: "CU-1",
      title: "Refactor OAuth bounce",
      status: "in progress",
      assigneeName: "Alice, Bob",
      url: "https://app.clickup.com/t/CU-1",
      updatedAt: updatedAt.toISOString(),
    });
  });

  it("returns null when the task doesn't exist", async () => {
    const { service } = makeService(null);
    const view = await service.forWorkspace(WS, "CU-missing");
    expect(view).toBeNull();
  });

  it("returns null when the task belongs to a different workspace (no cross-ws leak)", async () => {
    const { service } = makeService({
      taskId: "CU-2",
      workspaceId: OTHER_WS,
      taskName: "Someone else's task",
      status: "open",
      assigneesNames: null,
      url: null,
      updatedDate: new Date(),
      isDeleted: false,
    });

    const view = await service.forWorkspace(WS, "CU-2");
    expect(view).toBeNull();
  });

  it("returns null when the task is soft-deleted", async () => {
    const { service } = makeService({
      taskId: "CU-3",
      workspaceId: WS,
      taskName: "Deleted task",
      status: "open",
      assigneesNames: null,
      url: null,
      updatedDate: new Date(),
      isDeleted: true,
    });

    const view = await service.forWorkspace(WS, "CU-3");
    expect(view).toBeNull();
  });

  it("handles a task with no updatedDate by returning epoch", async () => {
    const { service } = makeService({
      taskId: "CU-4",
      workspaceId: WS,
      taskName: "Legacy task without updatedDate",
      status: null,
      assigneesNames: null,
      url: null,
      updatedDate: null,
      isDeleted: false,
    });

    const view = await service.forWorkspace(WS, "CU-4");
    expect(view?.updatedAt).toBe(new Date(0).toISOString());
  });
});
