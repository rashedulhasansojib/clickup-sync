import type { SubmitFeedbackRequest } from "@ma/shared";
import { AnalysisService } from "./analysis.service";

/**
 * v2 Phase 0 acceptance test — the five review-UI signal keys attached to
 * AnalysisRun.result (kbContext, fieldPredictions, duplicates, assignment,
 * adjustments) must round-trip through feedback + chat mutations.
 *
 * Before this fix, `loadRunContext` used plain AnalysisResultSchema.parse() —
 * which strips unknown keys — and then feedback/chat wrote the stripped result
 * back to the DB. First feedback submit or chat-added task on a run silently
 * deleted every signal from the persisted row. push.service.ts:158 (which reads
 * `.fieldPredictions` for the FieldOverride reader) then read `{}` on those runs
 * and the learning-loop signal died. See:
 *   docs/superpowers/specs/2026-07-18-meetsy-v2-phase0-foundations-design.md §1.
 */
describe("AnalysisService — signal round-trip (v2 Phase 0)", () => {
  const ORG = "org_seed";
  const WS = "ws_default";
  const RUN_ID = "run_1";
  const MEETING_ID = "mtg_1";

  const overview = "The team discussed the OAuth refactor and sprint planning.";
  const validTask = {
    id: "t1",
    title: "Refactor OAuth bounce",
    description: "The current OAuth bounce loses session state on redirect.",
    acceptanceCriteria: ["Session survives redirect"],
    assigneeId: "p1",
    assigneeName: "Alice",
    priority: "high" as const,
    dueDate: null,
    estimate: null,
    estimateHours: 4,
    dependencies: [],
    tags: [],
    subtasks: [],
    evidence: [{ quote: "we need to fix the OAuth bounce", speaker: "Alice", timestamp: "00:12:30" }],
    explicit: true,
    confidence: 0.9,
  };
  const roster = [
    {
      id: "p1",
      displayName: "Alice",
      aliases: [],
      clickupUserId: null,
      clickupName: null,
    },
  ];

  // The five signal keys attached to the stored run.result (Phase-2c/3 pipeline).
  const kbContext = [
    {
      sourceType: "clickup_task" as const,
      sourceId: "CU-01H8QX",
      score: 0.71,
      snippet: "Prior OAuth work: fix Google OAuth flow…",
    },
  ];
  const fieldPredictions = {
    t1: {
      sprint: {
        value: "Sprint-24",
        abstain: false,
        support: 4,
        share: 0.66,
        isModal: true,
        confidence: "high" as const,
        candidates: [
          { value: "Sprint-24", support: 4, share: 0.66 },
          { value: "Sprint-23", support: 2, share: 0.34 },
        ],
        reason: "matches OAuth cluster",
      },
      assigneeHint: {
        value: "Alice",
        abstain: false,
        support: 3,
        share: 0.6,
        isModal: true,
        confidence: "high" as const,
        candidates: [{ value: "Alice", support: 3, share: 0.6 }],
      },
      estimate: {
        value: "4h",
        abstain: false,
        support: 3,
        share: 0.5,
        isModal: true,
        confidence: "low" as const,
        candidates: [{ value: "4h", support: 3, share: 0.5 }],
      },
      due: { date: "2026-08-01", abstain: false, basedOnClosedTasks: 3, cycleDaysP80: 14 },
      qualifyingNeighbours: 6,
    },
  };
  const duplicates = {
    t1: [{ taskId: "CU-01H8QX", score: 0.68, band: "suggest" as const }],
  };
  const assignment = {
    t1: {
      recommended: {
        clickupUserId: "42",
        name: "Alice",
        inPool: true,
        ownershipScore: 0.82,
        closedSimilar: 5,
        openTasks: 2,
        trackedHours30d: 22.5,
        evidenceTaskIds: ["CU-01H8QX", "CU-01H7GZ", "CU-01H6RN"],
      },
      ranked: [
        {
          clickupUserId: "42",
          name: "Alice",
          inPool: true,
          ownershipScore: 0.82,
          closedSimilar: 5,
          openTasks: 2,
          trackedHours30d: 22.5,
          evidenceTaskIds: ["CU-01H8QX", "CU-01H7GZ", "CU-01H6RN"],
        },
      ],
      abstain: false,
      conditionedOnClient: true,
      rationale: "Alice owns this work (5 closed similar)",
    },
  };
  const adjustments = {
    t1: {
      assignee: { from: "Rashedul", to: "Alice", count: 3, agreement: 0.75 },
    },
  };
  // v2 Phase 2 — top-5 kNN neighbours per task. Persisted with ISO date strings
  // (Prisma.InputJsonValue calls Date.prototype.toJSON on write).
  const neighboursByTask = {
    t1: [
      {
        taskId: "CU-01H8QX",
        sim: 0.91,
        client: "Acme",
        sprint: "Sprint-24",
        assignee: "Alice",
        estimation: "4",
        createdDate: "2026-06-01T00:00:00.000Z",
        closedDate: "2026-06-15T00:00:00.000Z",
      },
    ],
  };

  function seededRunRow() {
    return {
      id: RUN_ID,
      orgId: ORG,
      workspaceId: WS,
      meetingId: MEETING_ID,
      status: "completed",
      error: null,
      // The five signal keys live alongside the AnalysisResult base as top-level
      // extras on run.result (v2c/3 pipeline attachment at analysis.processor.ts:240-248).
      result: {
        overview,
        people: [{ participant: roster[0], tasks: [validTask] }],
        unassignedTasks: [],
        kbContext,
        fieldPredictions,
        duplicates,
        assignment,
        adjustments,
        neighboursByTask,
      },
    };
  }

  function makeService(prismaOverrides: Record<string, unknown> = {}, azureOverrides: Record<string, unknown> = {}) {
    const runRow = seededRunRow();
    const meetingRow = {
      id: MEETING_ID,
      workspaceId: WS,
      transcript: "Alice: we need to fix the OAuth bounce.",
      normalizedTranscript: "Alice: we need to fix the OAuth bounce.",
      roster,
      meetingDate: new Date("2026-07-15T00:00:00Z"),
      createdAt: new Date("2026-07-15T00:00:00Z"),
    };

    // Capture what got persisted so the test can assert on it.
    let persistedResult: unknown = null;

    const prisma = {
      analysisRun: {
        findFirst: jest.fn().mockResolvedValue(runRow),
        update: jest.fn().mockImplementation(async ({ data }: { data: { result: unknown } }) => {
          persistedResult = data.result;
          return runRow;
        }),
      },
      meeting: {
        findFirst: jest.fn().mockResolvedValue(meetingRow),
      },
      feedback: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      chatMessage: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(async ({ data }: { data: { role: string } }) => ({
          id: `msg_${data.role}`,
          role: data.role,
          content: "…",
          createdAt: new Date(),
        })),
      },
      ...prismaOverrides,
    };

    // chatOverResult calls azure.structured; return a valid FullTaskLLMSchema shape.
    const azure = {
      structured: jest.fn().mockResolvedValue({
        reply: "Added the missed task.",
        newTasks: [
          {
            title: "Draft OAuth migration doc",
            description: "Write a migration doc for the OAuth flow change.",
            acceptanceCriteria: ["Doc reviewed by team"],
            assigneeId: "p1",
            priority: "normal",
            dueDate: null,
            estimate: null,
            dependencies: [],
            subtasks: [],
            tags: [],
            evidence: [{ quote: "let's document this", speaker: "Alice", timestamp: "00:15:00" }],
            explicit: true,
            confidence: 0.7,
          },
        ],
      }),
      ...azureOverrides,
    };
    const workspaces = { resolve: jest.fn().mockResolvedValue(WS) };

    const service = new AnalysisService(
      prisma as never,
      azure as never,
      {} as never,
      {} as never,
      workspaces as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { publish: jest.fn() } as never,
    );
    return { service, prisma, azure, getPersistedResult: () => persistedResult };
  }

  it("submitFeedback: signal keys survive a downvote-with-no-comment (remove path)", async () => {
    const { service, getPersistedResult } = makeService();

    const body: SubmitFeedbackRequest = {
      // Downvote a task we don't know about (removes it, no LLM refine).
      items: [{ taskId: "t_unknown", vote: "down" }],
    };
    const res = await service.submitFeedback(ORG, RUN_ID, body);

    // Response carries the signals.
    expect(res.result.kbContext).toEqual(kbContext);
    expect(res.result.fieldPredictions).toEqual(fieldPredictions);
    expect(res.result.duplicates).toEqual(duplicates);
    expect(res.result.assignment).toEqual(assignment);
    expect(res.result.adjustments).toEqual(adjustments);
    expect(res.result.neighboursByTask).toEqual(neighboursByTask);

    // …and so does the persisted row (this is the real bug being guarded).
    const persisted = getPersistedResult() as Record<string, unknown>;
    expect(persisted).toBeTruthy();
    expect(persisted.kbContext).toEqual(kbContext);
    expect(persisted.fieldPredictions).toEqual(fieldPredictions);
    expect(persisted.duplicates).toEqual(duplicates);
    expect(persisted.assignment).toEqual(assignment);
    expect(persisted.adjustments).toEqual(adjustments);
    expect(persisted.neighboursByTask).toEqual(neighboursByTask);
  });

  it("submitFeedback: signal keys survive when there is a real remove (task in result)", async () => {
    const { service, getPersistedResult } = makeService();

    const body: SubmitFeedbackRequest = {
      // Downvote-no-comment on a task that IS in the result → removes it → assemble runs.
      items: [{ taskId: "t1", vote: "down" }],
    };
    const res = await service.submitFeedback(ORG, RUN_ID, body);

    expect(res.changed).toBe(true);
    // The assembled result may drop t1 from `people`, but the top-level signal
    // keys must still be present verbatim (they key by taskId; stale entries are
    // harmless — the UI reads by task presence).
    const persisted = getPersistedResult() as Record<string, unknown>;
    expect(persisted.kbContext).toEqual(kbContext);
    expect(persisted.fieldPredictions).toEqual(fieldPredictions);
    expect(persisted.duplicates).toEqual(duplicates);
    expect(persisted.assignment).toEqual(assignment);
    expect(persisted.adjustments).toEqual(adjustments);
    expect(persisted.neighboursByTask).toEqual(neighboursByTask);
    // And on the response too.
    expect(res.result.kbContext).toEqual(kbContext);
    expect(res.result.fieldPredictions).toEqual(fieldPredictions);
    expect(res.result.neighboursByTask).toEqual(neighboursByTask);
  });

  it("sendChat: signal keys survive when the chat adds a task (newTasks.length > 0)", async () => {
    const { service, getPersistedResult } = makeService();

    const res = await service.sendChat(ORG, RUN_ID, "Did we miss anything?");

    expect(res.resultUpdated).toBe(true);
    expect(res.result).not.toBeNull();
    // The response result carries the signals.
    expect(res.result!.kbContext).toEqual(kbContext);
    expect(res.result!.fieldPredictions).toEqual(fieldPredictions);
    expect(res.result!.duplicates).toEqual(duplicates);
    expect(res.result!.assignment).toEqual(assignment);
    expect(res.result!.adjustments).toEqual(adjustments);
    expect(res.result!.neighboursByTask).toEqual(neighboursByTask);

    // And the persisted row does too — this is the write path that previously
    // stripped everything when a new task got added.
    const persisted = getPersistedResult() as Record<string, unknown>;
    expect(persisted).toBeTruthy();
    expect(persisted.kbContext).toEqual(kbContext);
    expect(persisted.fieldPredictions).toEqual(fieldPredictions);
    expect(persisted.duplicates).toEqual(duplicates);
    expect(persisted.assignment).toEqual(assignment);
    expect(persisted.adjustments).toEqual(adjustments);
    expect(persisted.neighboursByTask).toEqual(neighboursByTask);
  });

  it("sendChat: does NOT write when newTasks is empty (unchanged branch)", async () => {
    const { service, prisma } = makeService({}, {
      // No new tasks → resultUpdated stays false, no analysisRun.update fires.
      structured: jest.fn().mockResolvedValue({ reply: "Nothing missed.", newTasks: [] }),
    });

    const res = await service.sendChat(ORG, RUN_ID, "Anything missed?");

    expect(res.resultUpdated).toBe(false);
    expect(res.result).toBeNull();
    expect((prisma.analysisRun as { update: jest.Mock }).update).not.toHaveBeenCalled();
  });
});
