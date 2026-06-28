import { PushService } from "./push.service";
import { PrismaService } from "../prisma/prisma.service";
import { ClickUpClient } from "./clickup.client";
import { TaskMapperService } from "./task-mapper.service";
import { PushConfigService } from "./push-config.service";
import { AssigneeResolverService } from "./assignee-resolver.service";
import { LearningService } from "../kb/learning.service";

function makeService(fieldPredictions: Record<string, unknown>) {
  const created: Array<{ predicted: unknown; confirmed: unknown; meetsyTaskId: string }> = [];
  const prisma = {
    analysisRun: {
      findUnique: jest.fn().mockResolvedValue({ id: "run1", orgId: "org1", workspaceId: "ws1", meetingId: "m1", result: { fieldPredictions } }),
    },
    meeting: {
      findUnique: jest.fn().mockResolvedValue({ clientOptionId: null }),
    },
    taskPush: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
    },
    fieldOverride: {
      create: jest.fn().mockImplementation(async ({ data }) => {
        created.push({ predicted: data.predicted, confirmed: data.confirmed, meetsyTaskId: data.meetsyTaskId });
      }),
    },
  } as unknown as PrismaService;
  const client = { createTask: jest.fn().mockResolvedValue({ id: "ct1", url: "u" }) } as unknown as ClickUpClient;
  const pushConfig = {
    get: jest.fn().mockResolvedValue({
      targetListId: "L1", assignableMembers: [], clientOptions: [], defaultStatus: null, clientFieldId: "f-client",
    }),
  } as unknown as PushConfigService;
  // Learning stub: empty snapshot, no nudges → adjustments stay null (existing assertions hold).
  const learning = {
    snapshot: jest.fn().mockResolvedValue({ assignee: {} }),
    applyNudges: jest.fn().mockReturnValue({}),
  } as unknown as LearningService;
  const svc = new PushService(prisma, client, new TaskMapperService(), pushConfig, {} as AssigneeResolverService, learning);
  return { svc, created, prisma };
}

const task = (id: string, over: Record<string, unknown> = {}) => ({
  meetsyTaskId: id, title: "T", description: "", acceptanceCriteria: [], evidence: [],
  priority: "normal" as const, tags: [], subtasks: [], dependencies: [], ...over,
});

describe("PushService — FieldOverride logging", () => {
  it("writes predicted (from the run result) + confirmed for a pushed task", async () => {
    const predicted = { assigneeHint: { value: "Ahmad", abstain: false, support: 5, share: 0.33, isModal: false } };
    const { svc, created } = makeService({ t1: predicted });
    await svc.pushTasks("org1", "run1", { tasks: [task("t1", { clientOptionId: "opt-er", points: 8 })] }, "user1");

    expect(created).toHaveLength(1);
    expect(created[0].predicted).toEqual(predicted); // captures what the model said
    expect(created[0].confirmed).toMatchObject({ clientOptionId: "opt-er", points: 8, listId: "L1" }); // ...vs what the human pushed
  });

  it("SKIPS the override (no null-poison) when the task id has no prediction", async () => {
    const { svc, created } = makeService({ t1: { assigneeHint: { value: "Ahmad" } } });
    await svc.pushTasks("org1", "run1", { tasks: [task("t-unknown", { clientOptionId: "opt-er" })] }, "user1");
    expect(created).toHaveLength(0);
  });

  it("still logs when the prediction ABSTAINED (an abstain is real content, not a miss)", async () => {
    const { svc, created } = makeService({ t1: { assigneeHint: { value: null, abstain: true } } });
    await svc.pushTasks("org1", "run1", { tasks: [task("t1", { clientOptionId: "opt-er" })] }, "user1");
    expect(created).toHaveLength(1);
    expect(created[0].predicted).toEqual({ assigneeHint: { value: null, abstain: true } });
  });
});
