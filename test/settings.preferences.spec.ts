import { SettingsService } from '../src/settings/settings.service';

function makeRepo(row: any = null) {
  const store: { row: any } = { row };
  return {
    get: jest.fn(async () => store.row),
    upsert: jest.fn(async (data: any) => {
      store.row = { id: 'singleton', ...(store.row ?? {}), ...data, updatedAt: new Date() };
      return store.row;
    }),
  } as any;
}

describe('SettingsService preferences', () => {
  it('returns defaults when preferences column is null', async () => {
    const svc = new SettingsService(makeRepo(null));
    await svc.onModuleInit();
    const prefs = svc.getPreferences();
    expect(prefs.notifications.alerts.syncFail).toBe(true);
    expect(prefs.notifications.channels.pagerduty).toBe(false);
    expect(prefs.cost.autoRecalcOnRateChange).toBe(true);
    expect(prefs.cost.rateMatching).toBe('start');
    expect(prefs.cost.nonBillableZero).toBe(false);
    expect(prefs.failure.webhookRetryAttempts).toBe(5);
  });

  it('deep-merges a partial preferences patch over current values', async () => {
    const repo = makeRepo(null);
    const svc = new SettingsService(repo);
    await svc.onModuleInit();
    await svc.update({ preferences: { notifications: { channels: { slack: false } } } }, 'alice');
    const prefs = svc.getPreferences();
    expect(prefs.notifications.channels.slack).toBe(false);
    expect(prefs.notifications.channels.email).toBe(true);
    expect(prefs.notifications.alerts.syncFail).toBe(true);
  });

  it('deep-merges a cost preference without clobbering other cost keys', async () => {
    const repo = makeRepo(null);
    const svc = new SettingsService(repo);
    await svc.onModuleInit();
    await svc.update({ preferences: { cost: { nonBillableZero: true } } });
    const prefs = svc.getPreferences();
    expect(prefs.cost.nonBillableZero).toBe(true);
    expect(prefs.cost.rateMatching).toBe('start');
    expect(prefs.cost.autoRecalcOnRateChange).toBe(true);
  });
});
