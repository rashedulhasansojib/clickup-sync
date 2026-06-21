import { ClickupWebhooksService } from '../src/clickup/clickup-webhooks.service';

describe('ClickupWebhooksService', () => {
  const BASE = 'https://app.example.com/webhooks/clickup';
  // Each workspace registers at <base>/<workspaceId>.
  const ENDPOINT = `${BASE}/ws1`;
  const TEAM_ID = '3450636';

  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.CLICKUP_WEBHOOK_ENDPOINT;
    process.env.CLICKUP_WEBHOOK_ENDPOINT = BASE;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CLICKUP_WEBHOOK_ENDPOINT;
    else process.env.CLICKUP_WEBHOOK_ENDPOINT = savedEnv;
  });

  function makeWorkspaces(events = 'taskCreated,taskUpdated,taskDeleted,taskTimeTrackedUpdated') {
    return {
      getTeamId: () => TEAM_ID,
      getWebhookEvents: () => events,
      setWebhook: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  // The 4 events makeWorkspaces() returns by default, as a sorted-agnostic array.
  const DEFAULT_EVENTS = ['taskCreated', 'taskUpdated', 'taskDeleted', 'taskTimeTrackedUpdated'];

  function makeService(
    webhooks: any[],
    createResult = { id: 'new-id', secret: 'new-secret' },
    workspaces = makeWorkspaces(),
  ) {
    const client = {
      getWebhooks: jest.fn().mockResolvedValue(webhooks),
      createWebhook: jest.fn().mockResolvedValue(createResult),
      updateWebhook: jest.fn().mockResolvedValue(undefined),
    } as any;
    return { svc: new ClickupWebhooksService(client, workspaces), client, workspaces };
  }

  it('returns existing (no-op) when an active webhook is already subscribed to the configured events', async () => {
    const webhooks = [{ id: 'existing-id', endpoint: ENDPOINT, events: DEFAULT_EVENTS, health: { status: 'active', fail_count: 0 } }];
    const { svc, client } = makeService(webhooks);
    const result = await svc.register('ws1');
    expect(result).toEqual({ action: 'existing', webhookId: 'existing-id', endpoint: ENDPOINT });
    expect(client.updateWebhook).not.toHaveBeenCalled();
    expect(client.createWebhook).not.toHaveBeenCalled();
  });

  it('updates an active webhook in place when configured events changed, reporting added events', async () => {
    const webhooks = [{ id: 'existing-id', endpoint: ENDPOINT, events: DEFAULT_EVENTS, health: { status: 'active', fail_count: 0 } }];
    const workspaces = makeWorkspaces('taskCreated,taskUpdated,taskDeleted,taskTimeTrackedUpdated,taskStatusUpdated');
    const { svc, client } = makeService(webhooks, undefined, workspaces);
    const result = await svc.register('ws1');
    expect(result).toMatchObject({ action: 'updated', webhookId: 'existing-id', addedEvents: ['taskStatusUpdated'] });
    expect(client.updateWebhook).toHaveBeenCalledWith(
      'ws1',
      'existing-id',
      expect.objectContaining({ endpoint: ENDPOINT, status: 'active' }),
    );
    expect(client.createWebhook).not.toHaveBeenCalled();
  });

  it('creates new webhook and stores the returned secret', async () => {
    const { svc, workspaces } = makeService([]);
    const result = await svc.register('ws1', 'alice');
    expect(result).toEqual({ action: 'created', webhookId: 'new-id', endpoint: ENDPOINT, secretStored: true });
    expect(workspaces.setWebhook).toHaveBeenCalledWith('ws1', { secret: 'new-secret', webhookId: 'new-id', endpoint: ENDPOINT });
  });

  it('reports secretStored=false when the secret cannot be persisted', async () => {
    const workspaces = makeWorkspaces();
    workspaces.setWebhook = jest.fn().mockRejectedValue(new Error('no key'));
    const result = await makeService([], { id: 'new-id', secret: 'new-secret' }, workspaces).svc.register('ws1');
    expect(result).toEqual({ action: 'created', webhookId: 'new-id', endpoint: ENDPOINT, secretStored: false });
  });

  it('ignores webhooks pointing to a different endpoint', async () => {
    const webhooks = [{ id: 'other', endpoint: 'https://other.com', health: { status: 'active', fail_count: 0 } }];
    const result = await makeService(webhooks).svc.register('ws1');
    expect(result.action).toBe('created');
  });

  it('reactivates and updates an existing webhook with non-active health instead of creating a duplicate', async () => {
    const webhooks = [{ id: 'bad', endpoint: ENDPOINT, events: DEFAULT_EVENTS, health: { status: 'failing', fail_count: 10 } }];
    const { svc, client } = makeService(webhooks);
    const result = await svc.register('ws1');
    expect(result.action).toBe('updated');
    expect(client.updateWebhook).toHaveBeenCalledWith('ws1', 'bad', { endpoint: ENDPOINT, events: DEFAULT_EVENTS, status: 'active' });
    expect(client.createWebhook).not.toHaveBeenCalled();
  });

  it('passes correct events to createWebhook', async () => {
    const { svc, client } = makeService([], { id: 'x', secret: 'y' }, makeWorkspaces('taskCreated,taskDeleted'));
    await svc.register('ws1');
    expect(client.createWebhook).toHaveBeenCalledWith('ws1', ENDPOINT, ['taskCreated', 'taskDeleted']);
  });
});
