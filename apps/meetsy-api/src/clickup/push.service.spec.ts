import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PushService } from "./push.service";
import { TaskMapperService } from "./task-mapper.service";
import { AssigneeResolverService } from "./assignee-resolver.service";
import { PrismaService } from "../prisma/prisma.service";
import { ClickUpClient } from "./clickup.client";
import { PushConfigService } from "./push-config.service";
import { PushRunDto } from "./clickup.dto";

function task(id: string): PushRunDto["tasks"][number] {
  return {
    meetsyTaskId: id,
    title: `Task ${id}`,
    description: "",
    acceptanceCriteria: [],
    evidence: [],
    priority: "normal",
    tags: [],
    subtasks: [],
    dependencies: [],
  };
}

const CONFIG = {
  workspaceId: "ws1",
  targetListId: "list1",
  targetListName: null,
  assignableMembers: [],
  defaultStatus: null,
  updatedAt: "",
  updatedBy: null,
};

function setup(opts: {
  run?: any;
  existing?: any[];
  config?: any;
}) {
  const run = "run" in opts ? opts.run : { id: "run1", orgId: "org1", workspaceId: "ws1" };
  const prisma = {
    analysisRun: { findUnique: jest.fn().mockResolvedValue(run) },
    meeting: { findUnique: jest.fn().mockResolvedValue(null) },
    taskPush: {
      findMany: jest.fn().mockResolvedValue(opts.existing ?? []),
      upsert: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;
  const client = { createTask: jest.fn() } as unknown as ClickUpClient;
  const pushConfig = {
    get: jest.fn().mockResolvedValue(opts.config === undefined ? CONFIG : opts.config),
  } as unknown as PushConfigService;
  const learning = {
    snapshot: jest.fn().mockResolvedValue({ client: {}, assignee: {} }),
    applyNudges: jest.fn().mockReturnValue({}),
  } as unknown as import("../kb/learning.service").LearningService;
  const svc = new PushService(
    prisma,
    client,
    new TaskMapperService(),
    pushConfig,
    new AssigneeResolverService(),
    learning,
  );
  return { svc, prisma, client, pushConfig };
}

describe("PushService.pushTasks", () => {
  it("creates a new task and records a pushed audit row", async () => {
    const { svc, client, prisma } = setup({});
    (client.createTask as jest.Mock).mockResolvedValue({ id: "cu1", url: "http://cu/1" });

    const { results } = await svc.pushTasks("org1", "run1", { tasks: [task("t1")] }, "user1");

    expect(client.createTask).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ meetsyTaskId: "t1", status: "pushed", clickupTaskId: "cu1", clickupUrl: "http://cu/1" });
    expect((prisma.taskPush.upsert as jest.Mock).mock.calls[0][0].create.status).toBe("pushed");
  });

  it("SKIPS an already-pushed task without creating or upserting (idempotent)", async () => {
    const { svc, client, prisma } = setup({
      existing: [{ meetsyTaskId: "t1", status: "pushed", clickupTaskId: "cuOLD", clickupUrl: "http://cu/OLD" }],
    });

    const { results } = await svc.pushTasks("org1", "run1", { tasks: [task("t1")] }, "user1");

    // The make-or-break: no ClickUp call, no upsert that could clobber the pushed row.
    expect(client.createTask).not.toHaveBeenCalled();
    expect(prisma.taskPush.upsert).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      meetsyTaskId: "t1",
      status: "skipped",
      clickupTaskId: "cuOLD",
      clickupUrl: "http://cu/OLD",
    });
  });

  it("retries a previously-FAILED task (not skipped) and updates its row", async () => {
    const { svc, client, prisma } = setup({
      existing: [{ meetsyTaskId: "t1", status: "failed", clickupTaskId: null, clickupUrl: null }],
    });
    (client.createTask as jest.Mock).mockResolvedValue({ id: "cu1", url: "http://cu/1" });

    const { results } = await svc.pushTasks("org1", "run1", { tasks: [task("t1")] }, "user1");

    expect(client.createTask).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe("pushed");
    expect(prisma.taskPush.upsert).toHaveBeenCalledTimes(1);
  });

  it("records a failed task and keeps other tasks independent", async () => {
    const { svc, client } = setup({});
    (client.createTask as jest.Mock)
      .mockRejectedValueOnce(new Error("ClickUp 400"))
      .mockResolvedValueOnce({ id: "cu2", url: "http://cu/2" });

    const { results } = await svc.pushTasks(
      "org1",
      "run1",
      { tasks: [task("t1"), task("t2")] },
      "user1",
    );

    expect(results[0]).toMatchObject({ meetsyTaskId: "t1", status: "failed", error: "ClickUp 400" });
    expect(results[1]).toMatchObject({ meetsyTaskId: "t2", status: "pushed", clickupTaskId: "cu2" });
  });

  it("drops an assignee that is not in the allowlist (assigns unassigned)", async () => {
    const { svc, client } = setup({
      config: { ...CONFIG, assignableMembers: [{ clickupUserId: "99", name: "Allowed" }] },
    });
    (client.createTask as jest.Mock).mockResolvedValue({ id: "cu1", url: "http://cu/1" });

    await svc.pushTasks(
      "org1",
      "run1",
      { tasks: [{ ...task("t1"), clickupUserId: "1" }] }, // "1" not in allowlist
      "user1",
    );

    // Payload sent to ClickUp must not carry the disallowed assignee.
    const payload = (client.createTask as jest.Mock).mock.calls[0][2];
    expect(payload.assignees).toBeUndefined();
  });

  it("keeps an assignee that IS in the allowlist", async () => {
    const { svc, client } = setup({
      config: { ...CONFIG, assignableMembers: [{ clickupUserId: "1", name: "Allowed" }] },
    });
    (client.createTask as jest.Mock).mockResolvedValue({ id: "cu1", url: "http://cu/1" });

    await svc.pushTasks(
      "org1",
      "run1",
      { tasks: [{ ...task("t1"), clickupUserId: "1" }] },
      "user1",
    );
    expect((client.createTask as jest.Mock).mock.calls[0][2].assignees).toEqual([1]);
  });

  it("throws BadRequest when push is unconfigured", async () => {
    const { svc } = setup({ config: null });
    await expect(
      svc.pushTasks("org1", "run1", { tasks: [task("t1")] }, "user1"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("throws NotFound when the run is in another org", async () => {
    const { svc } = setup({ run: { id: "run1", orgId: "OTHER", workspaceId: "ws1" } });
    await expect(
      svc.pushTasks("org1", "run1", { tasks: [task("t1")] }, "user1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws NotFound when the run does not exist", async () => {
    const { svc } = setup({ run: null });
    await expect(
      svc.pushTasks("org1", "run1", { tasks: [task("t1")] }, "user1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
