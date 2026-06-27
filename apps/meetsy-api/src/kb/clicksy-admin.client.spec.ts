import { ClicksyAdminClient } from "./clicksy-admin.client";
import { ConfigService } from "../config/config.service";

/** Minimal ConfigService stub: only `get` is used by the client. */
function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

describe("ClicksyAdminClient.pollUntilTasksFetched", () => {
  const config = configWith({
    CLICKSY_ADMIN_URL: "http://clicksy.local",
    ADMIN_API_KEY: "k".repeat(40),
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns true as soon as no space is FETCHING, even while time-entries still drain", async () => {
    // Round 1: a space is still fetching tasks. Round 2: it has moved to the
    // time-entries phase (which the embed does NOT need) → poll should return.
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ spaces: [{ spaceId: "s1", phase: "fetching" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ spaces: [{ spaceId: "s1", phase: "time-entries", remaining: 120 }] }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new ClicksyAdminClient(config);
    const drained = await client.pollUntilTasksFetched("ws1", { intervalMs: 1 });

    expect(drained).toBe(true);
    // It did NOT wait for the time-entries phase to clear (would be a 3rd call
    // returning empty spaces); two polls sufficed.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns false (degrade) when Clicksy is unreachable", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const client = new ClicksyAdminClient(config);
    expect(await client.pollUntilTasksFetched("ws1", { intervalMs: 1 })).toBe(false);
  });
});
