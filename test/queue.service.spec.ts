import { QueueService } from '../src/queues/queue.service';

function makeQueues() {
  const q = {} as any;
  // One placeholder per @InjectQueue param on QueueService (webhooks, tasks,
  // time-entries, backfills, maintenance, assignee-replacement, comments).
  return [q, q, q, q, q, q, q] as const;
}

describe('QueueService.webhookJobOptions', () => {
  it('overrides attempts from settings while keeping defaults', () => {
    const settings = { getPreferences: () => ({ failure: { webhookRetryAttempts: 10 } }) } as any;
    const svc = new QueueService(...makeQueues(), settings);
    const opts = svc.webhookJobOptions();
    expect(opts.attempts).toBe(10);
    expect(opts.backoff.type).toBe('exponential');
    expect(opts.removeOnComplete).toBe(1000);
  });
});
