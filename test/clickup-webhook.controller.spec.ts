import { ClickupWebhookController } from '../src/webhooks/clickup-webhook.controller';

const PARSED = { fingerprint: 'fp-1', eventType: 'taskUpdated', taskId: 't1', payload: {} };

function build(overrides: { add?: jest.Mock; saveReceived?: jest.Mock; markFailed?: jest.Mock; realtimeWebhooks?: boolean } = {}) {
  const add = overrides.add ?? jest.fn().mockResolvedValue(undefined);
  const saveReceived = overrides.saveReceived ?? jest.fn().mockResolvedValue({ duplicate: false, id: 1n });
  const markFailed = overrides.markFailed ?? jest.fn().mockResolvedValue(undefined);
  const parser = { parse: jest.fn().mockReturnValue(PARSED) } as any;
  const repo = { saveReceived, markFailed } as any;
  const queues = {
    get: jest.fn().mockReturnValue({ add }),
    defaultJobOptions: jest.fn().mockReturnValue({}),
    webhookJobOptions: jest.fn().mockReturnValue({}),
  } as any;
  const realtimeWebhooks = overrides.realtimeWebhooks ?? true;
  const workspaces = {
    hasWorkspace: () => true,
    getSyncPreferences: () => ({ realtimeWebhooks }),
  } as any;
  const controller = new ClickupWebhookController(parser, repo, queues, workspaces);
  return { controller, add, saveReceived, markFailed };
}

describe('ClickupWebhookController.receive', () => {
  it('enqueues a job for a fresh event', async () => {
    const { controller, add } = build();
    const res = await controller.receive('ws1', {});
    expect(add).toHaveBeenCalled();
    expect(res).toEqual({ success: true, queued: true });
  });

  it('does not enqueue for a duplicate event', async () => {
    const { controller, add } = build({ saveReceived: jest.fn().mockResolvedValue({ duplicate: true }) });
    const res = await controller.receive('ws1', {});
    expect(add).not.toHaveBeenCalled();
    expect(res).toEqual({ success: true, duplicate: true });
  });

  it('marks the event failed (recoverable) when enqueue throws, without throwing', async () => {
    const { controller, markFailed } = build({
      add: jest.fn().mockRejectedValue(new Error('redis down')),
    });

    const res = await controller.receive('ws1', {});

    // The event row is already written; if we let this throw, ClickUp's retry
    // would be deduped and the event lost. Instead flag it failed so the admin
    // retry-failed-webhooks tool can re-enqueue it.
    expect(markFailed).toHaveBeenCalledWith('fp-1', expect.stringContaining('redis down'));
    expect(res).toEqual({ success: true, queued: false });
  });
});
