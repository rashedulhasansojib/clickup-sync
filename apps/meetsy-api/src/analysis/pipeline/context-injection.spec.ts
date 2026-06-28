import type { Participant, Task } from "@ma/shared";
import { AzureOpenAIService } from "../../azure/azure-openai.service";
import { criticPass } from "./stage5-critic";
import { enrichTasks } from "./stage4-enrich";

/** Capture the `user` prompt passed to azure.structured() and return a canned result. */
function azureCapture(result: unknown) {
  const calls: Array<{ user: string }> = [];
  const structured = jest.fn().mockImplementation(async (opts: { user: string }) => {
    calls.push({ user: opts.user });
    return result;
  });
  return { azure: { structured } as unknown as AzureOpenAIService, calls };
}

const roster: Participant[] = [{ id: "p1", displayName: "Sarah", aliases: [] }];
const tasks: Task[] = [
  {
    id: "t1", title: "Build portal", description: "d", acceptanceCriteria: [],
    assigneeId: "p1", assigneeName: "Sarah", priority: "high", dueDate: null, estimate: null,
    dependencies: [], tags: [], subtasks: [], evidence: [{ quote: "build it", speaker: null, timestamp: null }],
    explicit: true, confidence: 0.9,
  },
];

describe("Phase 2c context injection — default is inert", () => {
  const criticResult = {
    tasks: [{ title: "Build portal", description: "d", assigneeId: "p1", priority: "high", dueDate: null, evidence: [{ quote: "build it", speaker: null, timestamp: null }], explicit: true, confidence: 0.9 }],
    changes: [],
  };
  const enrichResult = {
    tasks: [{ id: "t1", acceptanceCriteria: ["x"], dependencies: [], subtasks: [], tags: ["web"], estimate: "2d", dueDate: null }],
  };

  it("criticPass without context injects NO context block", async () => {
    const { azure, calls } = azureCapture(criticResult);
    await criticPass(azure, "transcript text", roster, tasks);
    expect(calls[0].user).not.toContain("Related existing work");
    expect(calls[0].user).toContain("Return the corrected task list and the changes you made.");
  });

  it("criticPass WITH context injects the labelled reference block", async () => {
    const { azure, calls } = azureCapture(criticResult);
    await criticPass(azure, "transcript text", roster, tasks, "[1] (TASK) Existing energy portal");
    expect(calls[0].user).toContain("Related existing work");
    expect(calls[0].user).toContain("[1] (TASK) Existing energy portal");
    // Still ends with the instruction (context inserted BEFORE it).
    expect(calls[0].user.trimEnd().endsWith("Return the corrected task list and the changes you made.")).toBe(true);
  });

  it("criticPass with empty/whitespace context stays inert", async () => {
    const { azure, calls } = azureCapture(criticResult);
    await criticPass(azure, "transcript text", roster, tasks, "   ");
    expect(calls[0].user).not.toContain("Related existing work");
  });

  it("enrichTasks without context injects NO context block", async () => {
    const { azure, calls } = azureCapture(enrichResult);
    await enrichTasks(azure, tasks, "summary", "2026-06-28");
    expect(calls[0].user).not.toContain("Related existing work");
  });

  it("enrichTasks WITH context injects the reference block", async () => {
    const { azure, calls } = azureCapture(enrichResult);
    await enrichTasks(azure, tasks, "summary", "2026-06-28", "[1] (TASK) Similar portal sized 3d");
    expect(calls[0].user).toContain("Related existing work");
    expect(calls[0].user).toContain("Similar portal sized 3d");
  });
});
