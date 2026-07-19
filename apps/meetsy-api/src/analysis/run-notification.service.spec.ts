import { runsChannel } from "./run-notification.service";

/**
 * v2 SSE progress-polish — the cross-page run notification channel.
 *
 * The service itself is thin (mirrors LearningStreamService): full Redis I/O
 * is exercised in `learning-stream.service.spec.ts`. Here we lock the channel
 * name so a downstream refactor can't silently split publisher and subscriber
 * across two different channels (which would look "green" but never deliver
 * a toast).
 */
describe("runsChannel", () => {
  it("is `meetsy-runs:{workspaceId}` — matches the publisher/subscriber contract", () => {
    expect(runsChannel("ws1")).toBe("meetsy-runs:ws1");
    expect(runsChannel("ws_default")).toBe("meetsy-runs:ws_default");
  });

  it("is stable across calls (used as a Redis pub/sub key)", () => {
    expect(runsChannel("ws1")).toBe(runsChannel("ws1"));
  });
});
