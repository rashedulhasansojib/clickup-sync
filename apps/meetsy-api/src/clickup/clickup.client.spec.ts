import { ClickUpClient } from "./clickup.client";
import { ClickUpTokenService } from "./clickup-token.service";

describe("ClickUpClient (fetch mocked)", () => {
  const tokens = {
    resolve: jest.fn().mockResolvedValue({ token: "pk_TEST", teamId: "team123" }),
  } as unknown as ClickUpTokenService;
  const client = new ClickUpClient(tokens);

  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    (tokens.resolve as jest.Mock).mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  function ok(body: unknown) {
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  }

  it("createTask POSTs to /list/{id}/task with the token and returns id+url", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ id: "abc1", url: "https://app.clickup.com/t/abc1" }),
    );
    const res = await client.createTask("ws1", "list9", { name: "Hi", priority: 2 });

    expect(res).toEqual({ id: "abc1", url: "https://app.clickup.com/t/abc1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.clickup.com/api/v2/list/list9/task");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("pk_TEST");
    expect(JSON.parse(init.body)).toEqual({ name: "Hi", priority: 2 });
  });

  it("createTask falls back to a synthesized url when ClickUp omits one", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "xyz" }));
    const res = await client.createTask("ws1", "list9", { name: "Hi" });
    expect(res.url).toBe("https://app.clickup.com/t/xyz");
  });

  it("getTeamMembers GETs /team/{teamId} and returns team.members", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ team: { members: [{ user: { id: 7, username: "sarah" } }] } }),
    );
    const members = await client.getTeamMembers("ws1");
    expect(members).toHaveLength(1);
    expect(members[0].user.username).toBe("sarah");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.clickup.com/api/v2/team/team123");
  });

  it("getSpaceTree walks spaces → folders → folderless lists", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/team/team123/space?archived=false")) {
        return Promise.resolve(ok({ spaces: [{ id: 100, name: "Eng" }] }));
      }
      if (url.endsWith("/space/100/folder?archived=false")) {
        return Promise.resolve(
          ok({ folders: [{ id: 200, name: "Sprints", lists: [{ id: 300, name: "S1" }] }] }),
        );
      }
      if (url.endsWith("/space/100/list?archived=false")) {
        return Promise.resolve(ok({ lists: [{ id: 400, name: "Backlog" }] }));
      }
      return Promise.resolve(ok({}));
    });

    const tree = await client.getSpaceTree("ws1");
    expect(tree).toEqual([
      {
        id: "100",
        name: "Eng",
        folders: [{ id: "200", name: "Sprints", lists: [{ id: "300", name: "S1" }] }],
        lists: [{ id: "400", name: "Backlog" }],
      },
    ]);
  });

  it("throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"err":"Token invalid"}',
      json: async () => ({}),
    });
    await expect(client.createTask("ws1", "l", { name: "x" })).rejects.toThrow(/401/);
  });
});
