import { KbQueue } from "./kb.queue";
import { ConfigService } from "../config/config.service";

describe("KbQueue.enqueue (stable-jobId supersede)", () => {
  function makeQueue(existingState: string | null) {
    const removed = { calls: 0 };
    const added: unknown[] = [];
    const existing =
      existingState === null
        ? null
        : {
            getState: jest.fn().mockResolvedValue(existingState),
            remove: jest.fn().mockImplementation(async () => {
              removed.calls += 1;
            }),
          };
    const fakeBullQueue = {
      getJob: jest.fn().mockResolvedValue(existing),
      add: jest.fn().mockImplementation(async (_name, data, opts) => {
        added.push({ data, opts });
      }),
    };
    const kbQueue = new KbQueue({ get: () => undefined } as unknown as ConfigService);
    // Inject the fake BullMQ queue (normally built in onModuleInit against Redis).
    (kbQueue as unknown as { queue: unknown }).queue = fakeBullQueue;
    return { kbQueue, fakeBullQueue, existing, removed, added };
  }

  it("removes a retained COMPLETED job before re-adding, so re-onboard isn't a no-op", async () => {
    const { kbQueue, existing, removed, added } = makeQueue("completed");
    await kbQueue.enqueue({ workspaceId: "ws1", range: "all" });

    expect(existing!.remove).toHaveBeenCalledTimes(1);
    expect(removed.calls).toBe(1);
    expect(added).toHaveLength(1);
    expect((added[0] as { opts: { jobId: string } }).opts.jobId).toBe("ws1");
  });

  it("leaves an in-flight ACTIVE job alone (genuine idempotency) and still calls add", async () => {
    const { kbQueue, existing, removed } = makeQueue("active");
    await kbQueue.enqueue({ workspaceId: "ws1", range: "all" });

    expect(existing!.remove).not.toHaveBeenCalled();
    expect(removed.calls).toBe(0);
  });

  it("adds straight away when no prior job exists", async () => {
    const { kbQueue, added } = makeQueue(null);
    await kbQueue.enqueue({ workspaceId: "ws1", range: "all" });
    expect(added).toHaveLength(1);
  });
});
