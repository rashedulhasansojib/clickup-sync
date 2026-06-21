import { WebhookEventsRepository } from '../src/webhooks/webhook-events.repository';

function makePrisma(eventCreate: jest.Mock) {
  return {
    clickupWebhookEvent: { create: eventCreate },
    clickupWebhookSeen: { create: jest.fn().mockResolvedValue({}) },
  } as any;
}

const parsed = { fingerprint: 'fp', eventType: 'taskUpdated', taskId: 't', payload: {} } as any;

describe('WebhookEventsRepository.saveReceived — dedupe boundary', () => {
  it('returns {duplicate:false, id} on first insert and persists the workspaceId', async () => {
    const create = jest.fn().mockResolvedValue({ id: BigInt(7) });
    const repo = new WebhookEventsRepository(makePrisma(create));
    await expect(repo.saveReceived(parsed, 'ws1')).resolves.toEqual({ duplicate: false, id: BigInt(7) });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ workspaceId: 'ws1' }) });
  });

  it('maps a P2002 unique-violation to {duplicate:true} (the dedupe guarantee)', async () => {
    const create = jest.fn().mockRejectedValue({ code: 'P2002' });
    const repo = new WebhookEventsRepository(makePrisma(create));
    await expect(repo.saveReceived(parsed, 'ws1')).resolves.toEqual({ duplicate: true });
  });

  it('rethrows non-P2002 errors instead of masking them as duplicates', async () => {
    const create = jest.fn().mockRejectedValue(new Error('db down'));
    const repo = new WebhookEventsRepository(makePrisma(create));
    await expect(repo.saveReceived(parsed, 'ws1')).rejects.toThrow('db down');
  });
});
