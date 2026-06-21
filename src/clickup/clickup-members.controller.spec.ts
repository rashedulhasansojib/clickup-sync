import { ClickupMembersController } from './clickup-members.controller';
import type { MemberDto } from './workspace-members.service';

describe('ClickupMembersController', () => {
  it('returns the workspace member directory', async () => {
    const directory: MemberDto[] = [
      { id: '1', name: 'Ada', email: 'ada@x.com', profilePicture: 'https://cdn/ada.png', color: '#7B68EE', initials: 'AD' },
    ];
    const members = { getDirectory: jest.fn().mockResolvedValue(directory) } as any;
    const workspaces = { resolveWorkspaceId: jest.fn((id?: string) => id ?? 'ws1') } as any;
    const controller = new ClickupMembersController(members, workspaces);
    expect(await controller.list()).toBe(directory);
    expect(workspaces.resolveWorkspaceId).toHaveBeenCalledWith(undefined);
    expect(members.getDirectory).toHaveBeenCalledTimes(1);
    expect(members.getDirectory).toHaveBeenCalledWith('ws1');
  });

  it('resolves an explicit workspaceId query param', async () => {
    const directory: MemberDto[] = [];
    const members = { getDirectory: jest.fn().mockResolvedValue(directory) } as any;
    const workspaces = { resolveWorkspaceId: jest.fn((id?: string) => id ?? 'ws1') } as any;
    const controller = new ClickupMembersController(members, workspaces);
    await controller.list('ws2');
    expect(workspaces.resolveWorkspaceId).toHaveBeenCalledWith('ws2');
    expect(members.getDirectory).toHaveBeenCalledWith('ws2');
  });
});
