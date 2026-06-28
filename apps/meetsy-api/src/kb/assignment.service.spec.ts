import { AssignmentService } from "./assignment.service";
import { AssigneeResolverService } from "../clickup/assignee-resolver.service";
import { PrismaService } from "../prisma/prisma.service";
import type { Neighbour } from "./prediction-prior";
import type { TaskPrediction } from "./field-prediction.service";

function nb(over: Partial<Neighbour>): Neighbour {
  return { taskId: "t", sim: 0.8, client: null, sprint: null, assignee: null, estimation: null, createdDate: null, closedDate: new Date("2026-01-01"), ...over };
}
const noPred: Record<string, TaskPrediction> = {};

function makeService(openTasks: Array<{ assigneesNames: string | null }> = []) {
  const prisma = {
    clickupTask: { findMany: jest.fn().mockResolvedValue(openTasks) },
    clickupTimeEntry: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  return new AssignmentService(prisma, new AssigneeResolverService());
}

const members = [
  { clickupUserId: "u-ahmad", name: "Ahmad Syed Anwar" },
  { clickupUserId: "u-rashedul", name: "Rashedul Hasan" },
];

describe("AssignmentService.rank", () => {
  it("returns {} when no candidate pool is configured", async () => {
    const out = await makeService().rank("ws1", { t1: [nb({ assignee: "Ahmad" })] }, noPred, []);
    expect(out).toEqual({});
  });

  it("recommends the in-pool owner with ownership precedent (name resolves history→member)", async () => {
    const out = await makeService().rank("ws1", { t1: [nb({ assignee: "Ahmad", sim: 0.8 })] }, noPred, members);
    expect(out.t1.abstain).toBe(false);
    expect(out.t1.recommended?.clickupUserId).toBe("u-ahmad");
    expect(out.t1.recommended?.name).toBe("Ahmad Syed Anwar");
  });

  it("ABSTAINS but names the out-of-pool owner when history points outside the pool", async () => {
    const out = await makeService().rank("ws1", { t1: [nb({ assignee: "Ghost Person" })] }, noPred, members);
    expect(out.t1.abstain).toBe(true);
    expect(out.t1.recommended).toBeNull();
    expect(out.t1.rationale).toContain("not in the assignable pool");
  });

  it("abstains with 'no clear owner' when there is no qualifying ownership", async () => {
    const out = await makeService().rank("ws1", { t1: [nb({ assignee: null })] }, noPred, members);
    expect(out.t1.abstain).toBe(true);
    expect(out.t1.rationale).toContain("No clear owner");
  });

  it("workload breaks a near-tie toward the lighter teammate", async () => {
    // Both own one similar task each (a tie); Rashedul has 3 open tasks, Ahmad 0.
    const neighbours = [nb({ taskId: "a", assignee: "Ahmad", sim: 0.7 }), nb({ taskId: "b", assignee: "Rashedul Hasan", sim: 0.7 })];
    const openTasks = [
      { assigneesNames: "Rashedul Hasan" }, { assigneesNames: "Rashedul Hasan" }, { assigneesNames: "Rashedul Hasan" },
    ];
    const out = await makeService(openTasks).rank("ws1", { t1: neighbours }, noPred, members);
    expect(out.t1.recommended?.name).toBe("Ahmad Syed Anwar"); // lighter wins the tie
  });
});
