import { WorkspaceService } from '../src/workspaces/workspace.service';

// Reversible fake "encryption" so we can assert what gets stored and round-trip
// decryption without a real key.
function makeCrypto(isEnabled = true) {
  return {
    isEnabled,
    encrypt: (s: string) => `enc:${s}`,
    decrypt: (b: string) => {
      if (!b.startsWith('enc:')) throw new Error('bad ciphertext');
      return b.slice(4);
    },
  } as any;
}

function makeRow(over: Partial<any> = {}): any {
  return {
    id: 'ws_seed',
    orgId: 'org_seed',
    name: 'Nifty',
    clickupTeamId: '3450636',
    clickupApiTokenEnc: 'enc:tok-seed',
    webhookSecretEnc: 'enc:sec-seed',
    webhookEndpoint: 'https://x/api/webhooks/clickup/ws_seed',
    webhookEvents: 'taskCreated',
    webhookId: 'wh_1',
    spikeHoursCap: 12,
    preferences: { sync: { maxBackfillLookbackDays: 200 } },
    isDefault: true,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    updatedBy: null,
    spaces: [
      { id: 's1', workspaceId: 'ws_seed', spaceId: '111', name: 'Digital Marketing', backfillLookbackDays: 30, enabled: true },
      { id: 's2', workspaceId: 'ws_seed', spaceId: '222', name: 'Projects', backfillLookbackDays: 30, enabled: false },
    ],
    ...over,
  };
}

// Stateful repo mock: writes mutate the in-memory list so the post-write
// refresh() (which calls listAll) sees the change.
function makeRepo(rows: any[]) {
  const store = [...rows];
  return {
    _store: store,
    listAll: jest.fn(async () => store.slice().sort((a, b) => Number(b.isDefault) - Number(a.isDefault))),
    findById: jest.fn(async (id: string) => store.find((r) => r.id === id) ?? null),
    create: jest.fn(async (data: any) => {
      const row = makeRow({
        id: 'ws_new',
        orgId: data.org?.connect?.id ?? 'org_seed',
        name: data.name,
        clickupTeamId: data.clickupTeamId,
        clickupApiTokenEnc: data.clickupApiTokenEnc ?? null,
        webhookSecretEnc: null,
        webhookEndpoint: data.webhookEndpoint ?? null,
        webhookEvents: data.webhookEvents ?? null,
        webhookId: null,
        preferences: null,
        isDefault: false,
        spaces: [],
      });
      store.push(row);
      return row;
    }),
    update: jest.fn(async (id: string, data: any) => {
      const row = store.find((r) => r.id === id);
      Object.assign(row, data);
      return row;
    }),
    delete: jest.fn(async (id: string) => {
      const i = store.findIndex((r) => r.id === id);
      if (i >= 0) store.splice(i, 1);
    }),
    countData: jest.fn(async () => 0),
    upsertSpace: jest.fn(async () => undefined),
    deleteSpace: jest.fn(async () => undefined),
  } as any;
}

async function build(rows: any[], crypto = makeCrypto()) {
  const repo = makeRepo(rows);
  const svc = new WorkspaceService(repo, crypto);
  await svc.onModuleInit();
  return { svc, repo, crypto };
}

describe('WorkspaceService', () => {
  afterEach(() => {
    for (const k of ['CLICKUP_API_TOKEN', 'CLICKUP_TEAM_ID', 'CLICKUP_WEBHOOK_SECRET', 'CLICKUP_WEBHOOK_ENDPOINT', 'CLICKUP_WEBHOOK_EVENTS']) {
      delete process.env[k];
    }
  });

  describe('resolution', () => {
    it('resolves the default workspace by the isDefault flag', async () => {
      const { svc } = await build([makeRow({ id: 'a', isDefault: false }), makeRow({ id: 'ws_seed', isDefault: true })]);
      expect(svc.getDefaultWorkspaceId()).toBe('ws_seed');
    });

    it('resolveWorkspaceId falls back to default when absent, echoes a known id, throws on unknown', async () => {
      const { svc } = await build([makeRow()]);
      expect(svc.resolveWorkspaceId(undefined)).toBe('ws_seed');
      expect(svc.resolveWorkspaceId('ws_seed')).toBe('ws_seed');
      expect(() => svc.resolveWorkspaceId('nope')).toThrow();
    });

    it('hasWorkspace reflects the cache', async () => {
      const { svc } = await build([makeRow()]);
      expect(svc.hasWorkspace('ws_seed')).toBe(true);
      expect(svc.hasWorkspace('nope')).toBe(false);
    });

    it('lists only ACTIVE workspace ids for the scheduler', async () => {
      const { svc } = await build([makeRow({ id: 'ws_seed' }), makeRow({ id: 'off', isDefault: false, status: 'DISABLED' })]);
      expect(svc.listActiveWorkspaceIds()).toEqual(['ws_seed']);
    });
  });

  describe('connection getters', () => {
    it('decrypts the per-workspace token and team id', async () => {
      const { svc } = await build([makeRow()]);
      expect(svc.getApiToken('ws_seed')).toBe('tok-seed');
      expect(svc.getTeamId('ws_seed')).toBe('3450636');
    });

    it('falls back to the shared CLICKUP_API_TOKEN env when a workspace has no token', async () => {
      process.env.CLICKUP_API_TOKEN = 'shared-token';
      const { svc } = await build([makeRow({ clickupApiTokenEnc: null })]);
      expect(svc.getApiToken('ws_seed')).toBe('shared-token');
    });

    it('webhook secret: per-workspace value wins; default workspace falls back to env; non-default does not', async () => {
      process.env.CLICKUP_WEBHOOK_SECRET = 'env-secret';
      const { svc } = await build([
        makeRow({ id: 'ws_seed', isDefault: true, webhookSecretEnc: 'enc:sec-seed' }),
        makeRow({ id: 'ws_2', isDefault: false, webhookSecretEnc: null }),
        makeRow({ id: 'ws_def_nosecret', isDefault: false, webhookSecretEnc: null }),
      ]);
      expect(svc.getWebhookSecret('ws_seed')).toBe('sec-seed');
      // non-default with no stored secret → no env fallback
      expect(svc.getWebhookSecret('ws_2')).toBe('');
    });

    it('a decrypt failure degrades to the env/empty fallback rather than throwing', async () => {
      process.env.CLICKUP_API_TOKEN = 'shared-token';
      // Stored ciphertext is corrupt → decrypt throws → tryDecrypt returns null.
      const { svc } = await build([makeRow({ clickupApiTokenEnc: 'not-a-valid-blob' })]);
      expect(svc.getApiToken('ws_seed')).toBe('shared-token');
    });

    it('exposes per-workspace spaces and enabled flags', async () => {
      const { svc } = await build([makeRow()]);
      expect(svc.getSpaces('ws_seed').map((s) => s.spaceId)).toEqual(['111', '222']);
      expect(svc.isSpaceEnabled('ws_seed', '111')).toBe(true);
      expect(svc.isSpaceEnabled('ws_seed', '222')).toBe(false);
      expect(svc.isSpaceEnabled('ws_seed', 'unknown')).toBe(false);
    });
  });

  describe('masking (no secret leak)', () => {
    it('getMasked exposes only token last4 + set flags, never the raw secrets', async () => {
      const { svc } = await build([makeRow({ clickupApiTokenEnc: 'enc:pk_abcd1234' })]);
      const m = svc.getMasked('ws_seed');
      expect(m.apiTokenSet).toBe(true);
      expect(m.apiTokenLast4).toBe('1234');
      expect(m.webhookSecretSet).toBe(true);
      expect(JSON.stringify(m)).not.toContain('pk_abcd1234');
      expect(JSON.stringify(m)).not.toContain('sec-seed');
    });

    it('listForSwitcher returns no token/secret hints at all', async () => {
      const { svc } = await build([makeRow()]);
      const [w] = svc.listForSwitcher();
      expect(w).toEqual(
        expect.objectContaining({ id: 'ws_seed', name: 'Nifty', isDefault: true, teamId: '3450636' }),
      );
      expect(JSON.stringify(w)).not.toContain('apiTokenLast4');
      expect(JSON.stringify(w)).not.toContain('sec-seed');
    });
  });

  describe('encryption guard', () => {
    it('createWorkspace rejects a token when encryption is disabled', async () => {
      const { svc } = await build([makeRow()], makeCrypto(false));
      await expect(svc.createWorkspace({ name: 'Deno', teamId: '900', apiToken: 'pk_x' })).rejects.toThrow();
    });

    it('updateWorkspace rejects a token when encryption is disabled', async () => {
      const { svc } = await build([makeRow()], makeCrypto(false));
      await expect(svc.updateWorkspace('ws_seed', { apiToken: 'pk_x' })).rejects.toThrow();
    });

    it('createWorkspace encrypts the token and reflects the new workspace', async () => {
      const { svc, repo } = await build([makeRow()]);
      const created = await svc.createWorkspace({ name: 'Deno', teamId: '900', apiToken: 'pk_new' }, 'alice');
      const arg = repo.create.mock.calls.at(-1)![0];
      expect(arg.clickupApiTokenEnc).toBe('enc:pk_new');
      expect(arg.updatedBy).toBe('alice');
      expect(created.name).toBe('Deno');
      expect(svc.hasWorkspace('ws_new')).toBe(true);
    });
  });

  describe('webhook + delete', () => {
    it('setWebhook stores the encrypted secret + webhook id', async () => {
      const { svc, repo } = await build([makeRow()]);
      await svc.setWebhook('ws_seed', { secret: 'rawsecret', webhookId: 'wh_99', endpoint: 'https://e/ws_seed' });
      const [, data] = repo.update.mock.calls.at(-1)!;
      expect(data.webhookSecretEnc).toBe('enc:rawsecret');
      expect(data.webhookId).toBe('wh_99');
    });

    it('refuses to delete the default workspace', async () => {
      const { svc } = await build([makeRow({ id: 'ws_seed', isDefault: true })]);
      await expect(svc.deleteWorkspace('ws_seed')).rejects.toThrow();
    });

    it('refuses to delete a workspace that still owns synced data', async () => {
      const { svc, repo } = await build([makeRow({ id: 'ws_seed', isDefault: true }), makeRow({ id: 'ws_2', isDefault: false })]);
      repo.countData.mockResolvedValueOnce(5);
      await expect(svc.deleteWorkspace('ws_2')).rejects.toThrow();
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('deletes an empty non-default workspace', async () => {
      const { svc, repo } = await build([makeRow({ id: 'ws_seed', isDefault: true }), makeRow({ id: 'ws_2', isDefault: false })]);
      repo.countData.mockResolvedValueOnce(0);
      await svc.deleteWorkspace('ws_2');
      expect(repo.delete).toHaveBeenCalledWith('ws_2');
    });
  });
});
