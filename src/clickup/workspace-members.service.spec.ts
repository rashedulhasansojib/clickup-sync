import { WorkspaceMembersService } from './workspace-members.service';

function makeClient(members: unknown[]) {
  const getTeamMembers = jest.fn().mockResolvedValue(members);
  return { client: { getTeamMembers } as any, getTeamMembers };
}

describe('WorkspaceMembersService', () => {
  it('returns member ids as strings, dropping members without an id', async () => {
    const { client } = makeClient([{ user: { id: 123 } }, { user: { id: '456' } }, { user: { id: null } }, { user: {} }, {}]);
    const svc = new WorkspaceMembersService(client);
    expect(await svc.getMemberIds('ws1')).toEqual(['123', '456']);
  });

  it('caches across calls within the TTL window (single ClickUp fetch)', async () => {
    const { client, getTeamMembers } = makeClient([{ user: { id: 1 } }]);
    const svc = new WorkspaceMembersService(client);
    await svc.getMemberIds('ws1');
    await svc.getMemberIds('ws1');
    expect(getTeamMembers).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent calls into a single ClickUp fetch', async () => {
    const { client, getTeamMembers } = makeClient([{ user: { id: 1 } }]);
    const svc = new WorkspaceMembersService(client);
    const [a, b] = await Promise.all([svc.getMemberIds('ws1'), svc.getMemberIds('ws1')]);
    expect(a).toEqual(['1']);
    expect(b).toEqual(['1']);
    expect(getTeamMembers).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL elapses', async () => {
    const { client, getTeamMembers } = makeClient([{ user: { id: 1 } }]);
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      const svc = new WorkspaceMembersService(client);
      await svc.getMemberIds('ws1');
      now.mockReturnValue(1_000_000 + 11 * 60 * 1000); // 11 min later, past the 10-min TTL
      await svc.getMemberIds('ws1');
      expect(getTeamMembers).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('caches per workspaceId (distinct workspaces fetch independently)', async () => {
    const { client, getTeamMembers } = makeClient([{ user: { id: 1 } }]);
    const svc = new WorkspaceMembersService(client);
    await svc.getMemberIds('ws1');
    await svc.getMemberIds('ws1');
    await svc.getMemberIds('ws2');
    expect(getTeamMembers).toHaveBeenCalledTimes(2);
    expect(getTeamMembers).toHaveBeenNthCalledWith(1, 'ws1');
    expect(getTeamMembers).toHaveBeenNthCalledWith(2, 'ws2');
  });

  it('passes the workspaceId through when fetching', async () => {
    const { client, getTeamMembers } = makeClient([{ user: { id: 1 } }]);
    const svc = new WorkspaceMembersService(client);
    await svc.getMemberIds('ws1');
    expect(getTeamMembers).toHaveBeenCalledWith('ws1');
  });

  it('getDirectory maps profilePicture/color/initials and drops members without an id', async () => {
    const { client } = makeClient([
      { user: { id: 123, username: 'Ada', email: 'ada@x.com', profilePicture: 'https://cdn/ada.png', color: '#7B68EE', initials: 'AD' } },
      { user: { id: '456', username: 'Bo', email: 'bo@x.com', profilePicture: null } },
      { user: { id: null } },
      {},
    ]);
    const svc = new WorkspaceMembersService(client);
    expect(await svc.getDirectory('ws1')).toEqual([
      { id: '123', name: 'Ada', email: 'ada@x.com', profilePicture: 'https://cdn/ada.png', color: '#7B68EE', initials: 'AD' },
      { id: '456', name: 'Bo', email: 'bo@x.com', profilePicture: null, color: null, initials: null },
    ]);
  });

  it('getDirectory and getMemberIds share a single ClickUp fetch within the TTL', async () => {
    const { client, getTeamMembers } = makeClient([{ user: { id: 1, username: 'A' } }]);
    const svc = new WorkspaceMembersService(client);
    await svc.getDirectory('ws1');
    await svc.getMemberIds('ws1');
    expect(getTeamMembers).toHaveBeenCalledTimes(1);
  });
});
