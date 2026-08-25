import { SettingsSyncService, SETTINGS_CHANGED_CHANNEL } from './settings-sync.service';
import { SettingsService } from './settings.service';

/** Minimal ioredis stand-in: records publishes and replays messages to handlers. */
function makeRedis() {
  const handlers: Record<string, ((...args: any[]) => void)[]> = {};
  const sub: any = {
    on: jest.fn((event: string, fn: (...args: any[]) => void) => {
      (handlers[event] ??= []).push(fn);
    }),
    subscribe: jest.fn().mockResolvedValue(1),
    unsubscribe: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue('OK'),
  };
  const client = {
    duplicate: jest.fn(() => sub),
    publish: jest.fn().mockResolvedValue(1),
  };
  const emit = (event: string, ...args: any[]) => (handlers[event] ?? []).forEach((fn) => fn(...args));
  return { client, sub, emit };
}

function makeSettings() {
  const repo = { get: jest.fn().mockResolvedValue({ preferences: {} }), upsert: jest.fn().mockResolvedValue(undefined) } as any;
  const crypto = { isEnabled: false, encrypt: (s: string) => s, decrypt: (s: string) => s } as any;
  return new SettingsService(repo, crypto);
}

describe('SettingsSyncService', () => {
  it('subscribes to the settings channel on a DUPLICATED connection', async () => {
    // Reusing the shared BullMQ connection would put it in subscriber mode and
    // break every queue command issued on it.
    const { client, sub } = makeRedis();
    const svc = new SettingsSyncService(makeSettings(), { redis: async () => client } as any);
    await svc.onModuleInit();
    expect(client.duplicate).toHaveBeenCalled();
    expect(sub.subscribe).toHaveBeenCalledWith(SETTINGS_CHANGED_CHANNEL);
  });

  it('publishes when settings are written, so peer processes reload', async () => {
    const { client } = makeRedis();
    const settings = makeSettings();
    const svc = new SettingsSyncService(settings, { redis: async () => client } as any);
    await svc.onModuleInit();

    await settings.setWebhookSecret('rotated-secret', 'test');
    await new Promise((r) => setImmediate(r)); // publish is fire-and-forget

    expect(client.publish).toHaveBeenCalledWith(SETTINGS_CHANGED_CHANNEL, expect.any(String));
  });

  it('reloads the cache when another process publishes a change', async () => {
    const { client, emit } = makeRedis();
    const settings = makeSettings();
    const refresh = jest.spyOn(settings, 'refresh');
    const svc = new SettingsSyncService(settings, { redis: async () => client } as any);
    await svc.onModuleInit();
    refresh.mockClear();

    emit('message', SETTINGS_CHANGED_CHANNEL, JSON.stringify({ from: 'some-other-process' }));
    await new Promise((r) => setImmediate(r));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ignores its own publish (the writer already refreshed synchronously)', async () => {
    const { client, emit } = makeRedis();
    const settings = makeSettings();
    const svc = new SettingsSyncService(settings, { redis: async () => client } as any);
    await svc.onModuleInit();

    await settings.setWebhookSecret('rotated-secret', 'test');
    await new Promise((r) => setImmediate(r));
    const ownMessage = (client.publish.mock.calls[0] as [string, string])[1];

    const refresh = jest.spyOn(settings, 'refresh');
    emit('message', SETTINGS_CHANGED_CHANNEL, ownMessage);
    await new Promise((r) => setImmediate(r));

    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes on an unparseable payload rather than dropping the invalidation', async () => {
    const { client, emit } = makeRedis();
    const settings = makeSettings();
    const svc = new SettingsSyncService(settings, { redis: async () => client } as any);
    await svc.onModuleInit();
    const refresh = jest.spyOn(settings, 'refresh');

    emit('message', SETTINGS_CHANGED_CHANNEL, 'not-json');
    await new Promise((r) => setImmediate(r));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('re-subscribes after a reconnect so invalidation does not silently stop', async () => {
    const { client, sub, emit } = makeRedis();
    const svc = new SettingsSyncService(makeSettings(), { redis: async () => client } as any);
    await svc.onModuleInit();
    expect(sub.subscribe).toHaveBeenCalledTimes(1);

    emit('ready');
    await new Promise((r) => setImmediate(r));

    expect(sub.subscribe).toHaveBeenCalledTimes(2);
  });

  it('boots (degraded) when Redis is unreachable instead of failing startup', async () => {
    const settings = makeSettings();
    const svc = new SettingsSyncService(settings, {
      redis: async () => {
        throw new Error('redis down');
      },
    } as any);

    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    // A later write must not throw either, even though the broadcast can't land.
    await expect(settings.setWebhookSecret('s', 'test')).resolves.toBeUndefined();
  });
});
