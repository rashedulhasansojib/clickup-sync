import type { Task } from "@ma/shared";
import { AzureOpenAIService } from "../../azure/azure-openai.service";
import { enrichTasks } from "./stage4-enrich";

/** Stub azure.structured() to return a canned enrich payload. */
function azureReturning(result: unknown) {
  const structured = jest.fn().mockResolvedValue(result);
  return { structured } as unknown as AzureOpenAIService;
}

const seed: Task = {
  id: "t1",
  title: "Build portal",
  description: "seed one-liner",
  acceptanceCriteria: [],
  assigneeId: "p1",
  assigneeName: "Sarah",
  priority: "high",
  dueDate: null,
  estimate: null,
  estimateHours: null,
  dependencies: [],
  tags: [],
  subtasks: [],
  evidence: [{ quote: "build it", speaker: null, timestamp: null }],
  explicit: true,
  confidence: 0.9,
};

describe("enrichTasks — description + estimateHours", () => {
  it("merges the expanded description and numeric estimateHours from the LLM", async () => {
    const azure = azureReturning({
      tasks: [
        {
          id: "t1",
          description: "A detailed, self-contained work item spanning several sentences.",
          acceptanceCriteria: ["x"],
          dependencies: [],
          subtasks: [],
          tags: ["web"],
          estimate: "2d",
          estimateHours: 16,
          dueDate: null,
        },
      ],
    });

    const [out] = await enrichTasks(azure, [seed], "summary", "2026-06-28");
    expect(out.description).toBe("A detailed, self-contained work item spanning several sentences.");
    expect(out.estimateHours).toBe(16);
  });

  it("falls back to the seed description when the LLM returns an empty one", async () => {
    const azure = azureReturning({
      tasks: [
        {
          id: "t1",
          description: "   ",
          acceptanceCriteria: [],
          dependencies: [],
          subtasks: [],
          tags: [],
          estimate: null,
          estimateHours: 4,
          dueDate: null,
        },
      ],
    });

    const [out] = await enrichTasks(azure, [seed], "summary", "2026-06-28");
    expect(out.description).toBe("seed one-liner");
  });

  it("coerces a non-positive estimateHours to null instead of throwing TaskSchema.parse", async () => {
    const azure = azureReturning({
      tasks: [
        {
          id: "t1",
          description: "expanded",
          acceptanceCriteria: [],
          dependencies: [],
          subtasks: [],
          tags: [],
          estimate: null,
          estimateHours: 0, // model disobeyed the "0.5-1 for trivial" instruction
          dueDate: null,
        },
      ],
    });

    // TaskSchema requires estimateHours > 0; a 0 must coerce to null, not crash.
    const [out] = await enrichTasks(azure, [seed], "summary", "2026-06-28");
    expect(out.estimateHours).toBeNull();
  });
});
