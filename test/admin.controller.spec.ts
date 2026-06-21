import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminController } from '../src/admin/admin.controller';

describe('AdminController', () => {
  function makeQueues() {
    const add = jest.fn().mockResolvedValue({});
    // getJobs defaults to empty so the reconcile in-flight guard finds no
    // running sweep and proceeds to enqueue.
    const getJobs = jest.fn().mockResolvedValue([]);
    return { get: jest.fn().mockReturnValue({ add, getJobs }), defaultJobOptions: jest.fn().mockReturnValue({}), webhookJobOptions: jest.fn().mockReturnValue({}) } as any;
  }

  function makeDeadLetters(record: any = null) {
    return {
      findPending: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      findById: jest.fn().mockResolvedValue(record),
      markRetried: jest.fn().mockResolvedValue({}),
    } as any;
  }

  function makeClickup() {
    return { getTeamMembers: jest.fn().mockResolvedValue([]) } as any;
  }

  function makeWebhooks(result: any = { action: 'created', webhookId: 'wh-1', secret: 'sec', endpoint: 'https://x.com' }) {
    return { register: jest.fn().mockResolvedValue(result) } as any;
  }

  function makeTimeEntriesRepo() {
    return {
      findUnreplacedAgencyEntries: jest.fn().mockResolvedValue([]),
      findUnreplacedTaggedEntries: jest.fn().mockResolvedValue([]),
    } as any;
  }

  function makeRatesRepo() {
    return {
      findAll: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 }),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn().mockResolvedValue(null),
    } as any;
  }

  function makeTagAssigneeRepo() {
    return {
      findAll: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  function makeTasksRepo() {
    return { findAllIds: jest.fn().mockResolvedValue([]), countActive: jest.fn().mockResolvedValue(0) } as any;
  }

  function makeRatesService() {
    return {
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  function makeWebhookEvents() {
    return {
      findFailed: jest.fn().mockResolvedValue([]),
      markRequeued: jest.fn().mockResolvedValue({}),
    } as any;
  }

  function makeWebhookParser() {
    return { parse: jest.fn((raw: unknown) => ({ eventType: 'taskUpdated', taskId: 'task-x', loggedUserId: null, fingerprint: 'fp-x', payload: raw })) } as any;
  }

  function makePrisma() {
    return {
      clickupTask: { findMany: jest.fn().mockResolvedValue([]) },
      syncJobLog: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
  }

  function makeAuditLog() {
    return { findMany: jest.fn().mockResolvedValue({ items: [], total: 0 }) } as any;
  }

  // App-global settings only — per-connection ClickUp settings (teamId, token,
  // spaces, backfill cap) moved to WorkspaceService (see makeWorkspaces).
  function makeSettings(excludedAssignees: any[] = []) {
    return {
      getGlobal: jest.fn().mockReturnValue({
        preferences: { cost: { autoRecalcOnRateChange: true, excludedAssignees } },
        updatedAt: null,
        updatedBy: null,
      }),
      update: jest.fn().mockResolvedValue({ cost: { excludedAssignees } }),
      getPreferences: () => ({ sync: { backfillOnConnect: false }, cost: { autoRecalcOnRateChange: true, excludedAssignees } }),
    } as any;
  }

  // Three seed spaces (Digital Marketing / R&D Apps / Projects), 30-day lookback.
  const SPACES = [
    { spaceId: '3577824', name: 'Digital Marketing', backfillLookbackDays: 30, enabled: true },
    { spaceId: '3589129', name: 'R&D Apps', backfillLookbackDays: 30, enabled: true },
    { spaceId: '3525433', name: 'Projects', backfillLookbackDays: 30, enabled: true },
  ];

  function makeWorkspaces(overrides: Partial<{ maxBackfillLookbackDays: number; spaces: any[] }> = {}) {
    const spaces = overrides.spaces ?? SPACES;
    return {
      resolveWorkspaceId: jest.fn((id?: string) => id ?? 'ws1'),
      getTeamId: () => '123',
      getApiToken: () => 'tok',
      getWebhookSecret: () => 'sec',
      getSpikeHoursCap: () => 12,
      getBackfillMaxLookbackDays: () => overrides.maxBackfillLookbackDays ?? 1095,
      getSpaces: jest.fn(() => spaces),
      getSpace: jest.fn((_ws: string, id: string) => spaces.find((s) => s.spaceId === id)),
      getSyncPreferences: () => ({ reconcileLookbackDays: 365, realtimeWebhooks: true, backfillOnConnect: true, maxBackfillLookbackDays: 1095 }),
      hasWorkspace: () => true,
      listActiveWorkspaceIds: () => ['ws1'],
      getMasked: jest.fn().mockReturnValue({ id: 'ws1', name: 'Default', teamId: '123', apiTokenSet: true }),
      listMasked: jest.fn().mockReturnValue([{ id: 'ws1', name: 'Default', teamId: '123', apiTokenSet: true }]),
      createWorkspace: jest.fn().mockResolvedValue({ id: 'ws2' }),
      updateWorkspace: jest.fn().mockResolvedValue({ id: 'ws1' }),
      deleteWorkspace: jest.fn().mockResolvedValue(undefined),
      setWebhook: jest.fn().mockResolvedValue(undefined),
      upsertSpace: jest.fn().mockResolvedValue({ id: 'ws1' }),
      deleteSpace: jest.fn().mockResolvedValue({ id: 'ws1' }),
      encryptionEnabled: jest.fn().mockReturnValue(true),
    } as any;
  }

  function makeBudgetsRepo() {
    return {
      findAll: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 }),
      findAllRows: jest.fn().mockResolvedValue([]),
      findById: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    } as any;
  }

  function makeSpikeNotifications() {
    return {
      preview: jest.fn().mockResolvedValue({ date: '2026-06-10', recipientEmail: null, userName: null, totalHours: 0, tasks: [], alreadyNotified: false }),
      notify: jest.fn().mockResolvedValue({ sent: true }),
    } as any;
  }

  function makeSpikeResolutions() {
    return {
      resolve: jest.fn().mockResolvedValue({ resolved: true, date: '2026-06-10' }),
      unresolve: jest.fn().mockResolvedValue({ resolved: false, date: '2026-06-10' }),
    } as any;
  }

  function makeCtrl(queues?: any, deadLetters?: any, webhooks?: any, timeEntriesRepo?: any, webhookEvents?: any, webhookParser?: any, prisma?: any, workspaces?: any, settings?: any) {
    return new AdminController(
      queues ?? makeQueues(),
      deadLetters ?? makeDeadLetters(),
      makeClickup(),
      webhooks ?? makeWebhooks(),
      timeEntriesRepo ?? makeTimeEntriesRepo(),
      makeRatesRepo(),
      makeBudgetsRepo(),
      makeTagAssigneeRepo(),
      makeTasksRepo(),
      makeRatesService(),
      webhookEvents ?? makeWebhookEvents(),
      webhookParser ?? makeWebhookParser(),
      prisma ?? makePrisma(),
      makeAuditLog(),
      settings ?? makeSettings(),
      workspaces ?? makeWorkspaces(),
      makeSpikeNotifications(),
      makeSpikeResolutions(),
      { search: jest.fn() } as any,
      { forTask: jest.fn() } as any,
    );
  }

  function makeQueuesWithAdd() {
    const add = jest.fn().mockResolvedValue({});
    const queues = { get: jest.fn().mockReturnValue({ add, getJobs: jest.fn().mockResolvedValue([]) }), defaultJobOptions: jest.fn().mockReturnValue({}), webhookJobOptions: jest.fn().mockReturnValue({}) } as any;
    return { queues, add };
  }

  describe('syncTask', () => {
    it('queues SYNC_CLICKUP_TASK on clickup-tasks queue and returns taskId', () => {
      const queues = makeQueues();
      const ctrl = makeCtrl(queues);
      const result = ctrl.syncTask({ taskId: '86abc' });
      expect(result).toEqual({ queued: true, taskId: '86abc' });
      expect(queues.get).toHaveBeenCalledWith('clickup-tasks');
    });
  });

  describe('backfill', () => {
    it('uses configured lookback when lookbackDays is not provided', () => {
      const result = makeCtrl().backfill({ spaceId: '3577824' });
      expect(result).toEqual({ queued: true, spaceId: '3577824', lookbackDays: 30 });
    });

    it('uses provided lookbackDays over configured default', () => {
      const result = makeCtrl().backfill({ spaceId: '3589129', lookbackDays: 7 });
      expect(result).toEqual({ queued: true, spaceId: '3589129', lookbackDays: 7 });
    });

    it('throws BadRequestException for unknown spaceId', () => {
      expect(() => makeCtrl().backfill({ spaceId: 'bad-id' })).toThrow(BadRequestException);
    });

    it('queues on clickup-backfills queue', () => {
      const queues = makeQueues();
      makeCtrl(queues).backfill({ spaceId: '3525433' });
      expect(queues.get).toHaveBeenCalledWith('clickup-backfills');
    });

    it('allows unknown spaceId when allowUnknownSpaces is true', () => {
      const result = makeCtrl().backfill({ spaceId: 'test-space-999', allowUnknownSpaces: true });
      expect(result).toEqual({ queued: true, spaceId: 'test-space-999', lookbackDays: 30 });
    });

    it('uses provided lookbackDays for unknown space instead of default 30', () => {
      const result = makeCtrl().backfill({ spaceId: 'test-space-999', allowUnknownSpaces: true, lookbackDays: 7 });
      expect(result).toEqual({ queued: true, spaceId: 'test-space-999', lookbackDays: 7 });
    });

    it('rejects lookbackDays above the configured cap', () => {
      const ctrl = makeCtrl(undefined, undefined, undefined, undefined, undefined, undefined, undefined, makeWorkspaces({ maxBackfillLookbackDays: 1095 }));
      expect(() => ctrl.backfill({ spaceId: '3589129', lookbackDays: 2000 })).toThrow(BadRequestException);
    });

    it('accepts lookbackDays at or below the configured cap', () => {
      const ctrl = makeCtrl(undefined, undefined, undefined, undefined, undefined, undefined, undefined, makeWorkspaces({ maxBackfillLookbackDays: 3650 }));
      const result = ctrl.backfill({ spaceId: '3589129', lookbackDays: 2000 });
      expect(result).toEqual({ queued: true, spaceId: '3589129', lookbackDays: 2000 });
    });
  });

  describe('backfillActive', () => {
    function makeQueuesWithJobs(jobsByQueue: Record<string, any[]>) {
      const getJobs = jest.fn((_states: string[]) => Promise.resolve([])); // default
      const queueMocks = new Map<string, any>();
      for (const [name, jobs] of Object.entries(jobsByQueue)) {
        queueMocks.set(name, { getJobs: jest.fn().mockResolvedValue(jobs), add: jest.fn() });
      }
      const get = jest.fn((name: string) => queueMocks.get(name) ?? { getJobs, add: jest.fn() });
      return { get, defaultJobOptions: jest.fn().mockReturnValue({}), webhookJobOptions: jest.fn().mockReturnValue({}) } as any;
    }

    it('returns empty list when no jobs are active', async () => {
      const ctrl = makeCtrl(makeQueuesWithJobs({ 'clickup-backfills': [], 'clickup-time-entries': [] }));
      await expect(ctrl.backfillActive()).resolves.toEqual({ spaces: [] });
    });

    it('reports backfill phase as "fetching" with no total', async () => {
      const queues = makeQueuesWithJobs({
        'clickup-backfills': [{ data: { workspaceId: 'ws1', spaceId: '3589129' } }],
        'clickup-time-entries': [],
      });
      const result = await makeCtrl(queues).backfillActive();
      expect(result.spaces).toEqual([
        { spaceId: '3589129', phase: 'fetching', total: null, done: null, remaining: 0 },
      ]);
    });

    it('attributes time-entry queue depth to spaces via clickup_tasks', async () => {
      const prisma = makePrisma();
      prisma.clickupTask.findMany.mockResolvedValue([
        { taskId: 't1', spaceId: '3589129' },
        { taskId: 't2', spaceId: '3589129' },
        { taskId: 't3', spaceId: '3577824' },
      ]);
      prisma.syncJobLog.findMany.mockResolvedValue([
        { entityId: '3589129', tasksSynced: 100, finishedAt: new Date() },
        { entityId: '3577824', tasksSynced: 50, finishedAt: new Date() },
      ]);
      const queues = makeQueuesWithJobs({
        'clickup-backfills': [],
        'clickup-time-entries': [
          { data: { workspaceId: 'ws1', taskId: 't1' } },
          { data: { workspaceId: 'ws1', taskId: 't2' } },
          { data: { workspaceId: 'ws1', taskId: 't3' } },
        ],
      });
      const result = await makeCtrl(queues, undefined, undefined, undefined, undefined, undefined, prisma).backfillActive();
      const byId = Object.fromEntries(result.spaces.map((s) => [s.spaceId, s]));
      expect(byId['3589129']).toEqual({ spaceId: '3589129', phase: 'time-entries', total: 100, done: 98, remaining: 2 });
      expect(byId['3577824']).toEqual({ spaceId: '3577824', phase: 'time-entries', total: 50, done: 49, remaining: 1 });
    });

    it('clamps done to >= 0 when webhook drains outrun the last backfill', async () => {
      const prisma = makePrisma();
      prisma.clickupTask.findMany.mockResolvedValue([{ taskId: 't1', spaceId: 'X' }]);
      prisma.syncJobLog.findMany.mockResolvedValue([{ entityId: 'X', tasksSynced: 0, finishedAt: new Date() }]);
      const queues = makeQueuesWithJobs({
        'clickup-backfills': [],
        'clickup-time-entries': [{ data: { workspaceId: 'ws1', taskId: 't1' } }],
      });
      const result = await makeCtrl(queues, undefined, undefined, undefined, undefined, undefined, prisma).backfillActive();
      // total=0, remaining=1 → would compute done=-1 if not clamped; we fall back to total=remaining=1.
      expect(result.spaces[0]).toMatchObject({ phase: 'time-entries', done: 0, total: 1, remaining: 1 });
    });

    it('backfill-phase entry takes precedence over time-entries entry for the same space', async () => {
      const prisma = makePrisma();
      prisma.clickupTask.findMany.mockResolvedValue([{ taskId: 't1', spaceId: '3589129' }]);
      const queues = makeQueuesWithJobs({
        'clickup-backfills': [{ data: { workspaceId: 'ws1', spaceId: '3589129' } }],
        'clickup-time-entries': [{ data: { workspaceId: 'ws1', taskId: 't1' } }],
      });
      const result = await makeCtrl(queues, undefined, undefined, undefined, undefined, undefined, prisma).backfillActive();
      expect(result.spaces).toHaveLength(1);
      expect(result.spaces[0]).toEqual({
        spaceId: '3589129',
        phase: 'fetching',
        total: null,
        done: null,
        remaining: 1,
      });
    });
  });

  describe('registerWebhook', () => {
    it('delegates to ClickupWebhooksService.register', async () => {
      const webhooks = makeWebhooks({ action: 'existing', webhookId: 'w1', endpoint: 'https://x.com' });
      const ctrl = makeCtrl(undefined, undefined, webhooks);
      const result = await ctrl.registerWebhook({ email: 'owner@test.com', isMachine: false } as any);
      expect(result).toEqual({ action: 'existing', webhookId: 'w1', endpoint: 'https://x.com' });
    });
  });

  describe('listDeadLetters', () => {
    it('clamps limit to 200 and returns repository result', async () => {
      const dl = makeDeadLetters();
      await makeCtrl(undefined, dl).listDeadLetters(999, 0);
      expect(dl.findPending).toHaveBeenCalledWith(200, 0);
    });
  });

  describe('retryDeadLetter', () => {
    it('throws NotFoundException when record does not exist', async () => {
      await expect(makeCtrl(undefined, makeDeadLetters(null)).retryDeadLetter('99')).rejects.toThrow(NotFoundException);
    });

    it('re-queues using record queueName+jobName+payload and marks retried', async () => {
      const queues = makeQueues();
      const record = { id: BigInt(1), queueName: 'clickup-tasks', jobName: 'sync-clickup-task', payload: { taskId: 'abc' } };
      const dl = makeDeadLetters(record);
      const result = await makeCtrl(queues, dl).retryDeadLetter('1');
      expect(result).toEqual({ requeued: true, id: '1', queueName: 'clickup-tasks', jobName: 'sync-clickup-task' });
      expect(dl.markRetried).toHaveBeenCalledWith(BigInt(1));
    });
  });

  describe('retryFailedWebhooks', () => {
    it('re-enqueues each failed event after re-parsing its raw payload, and clears the failed marker', async () => {
      const queues = makeQueues();
      const rawA = { event: 'taskUpdated', task_id: 'A' };
      const rawB = { event: 'taskDeleted', task_id: 'B' };
      const webhookEvents = {
        findFailed: jest.fn().mockResolvedValue([
          { id: BigInt(10), fingerprint: 'fp-a', rawPayload: rawA },
          { id: BigInt(11), fingerprint: 'fp-b', rawPayload: rawB },
        ]),
        markRequeued: jest.fn().mockResolvedValue({}),
      } as any;
      const parser = makeWebhookParser();
      const result = await makeCtrl(queues, undefined, undefined, undefined, webhookEvents, parser).retryFailedWebhooks();

      expect(result).toEqual({ requeued: 2, scanned: 2, limit: 500 });
      expect(parser.parse).toHaveBeenCalledTimes(2);
      expect(parser.parse).toHaveBeenCalledWith(rawA);
      expect(parser.parse).toHaveBeenCalledWith(rawB);
      expect(webhookEvents.markRequeued).toHaveBeenCalledWith('fp-a');
      expect(webhookEvents.markRequeued).toHaveBeenCalledWith('fp-b');
      // Both jobs went onto clickup-webhooks
      const add = (queues.get as jest.Mock).mock.results[0].value.add as jest.Mock;
      expect(add).toHaveBeenCalledTimes(2);
    });

    it('clamps limit to 2000', async () => {
      const webhookEvents = { findFailed: jest.fn().mockResolvedValue([]), markRequeued: jest.fn() } as any;
      const result = await makeCtrl(undefined, undefined, undefined, undefined, webhookEvents).retryFailedWebhooks('9999');
      expect(webhookEvents.findFailed).toHaveBeenCalledWith(2000);
      expect(result.limit).toBe(2000);
    });
  });

  describe('backfillReplacement', () => {
    it('enqueues tagged-entry payloads carrying tags + original logger', async () => {
      const repo = {
        findUnreplacedTaggedEntries: jest.fn().mockResolvedValue([
          {
            time_entry_id: 'e1',
            task_id: 't1',
            user_id: '54569564',
            start_time: new Date(1700000000000),
            end_time: new Date(1700003600000),
            duration_hours: 1,
            billable: true,
            description: 'Internal meeting',
            tag_names: ['ahmad'],
          },
        ]),
      } as any;
      const queues = makeQueues();
      const result = await makeCtrl(queues, undefined, undefined, repo).backfillReplacement({ limit: 10 });

      expect(result).toEqual({ queued: 1, scanned: 1, limit: 10 });
      expect(repo.findUnreplacedTaggedEntries).toHaveBeenCalledWith('ws1', 10);
      // The job must carry tags + the actual logger so the worker can route
      // without re-fetching anything from ClickUp.
      const add = (queues.get as jest.Mock).mock.results[0].value.add as jest.Mock;
      expect(add).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          timeEntryId: 'e1',
          taskId: 't1',
          originalUserId: '54569564',
          tags: ['ahmad'],
          durationHours: 1,
          billable: true,
        }),
        expect.any(Object),
      );
    });

    it('skips rows that came back without any tag names', async () => {
      const repo = {
        findUnreplacedTaggedEntries: jest.fn().mockResolvedValue([
          { time_entry_id: 'e1', task_id: 't1', user_id: 'u1', start_time: null, end_time: null, duration_hours: 0, billable: false, description: null, tag_names: [] },
        ]),
      } as any;
      const queues = makeQueues();
      const result = await makeCtrl(queues, undefined, undefined, repo).backfillReplacement({});
      expect(result).toEqual({ queued: 0, scanned: 1, limit: 500 });
    });

    it('clamps limit to 2000', async () => {
      const repo = { findUnreplacedTaggedEntries: jest.fn().mockResolvedValue([]) } as any;
      const result = await makeCtrl(makeQueues(), undefined, undefined, repo).backfillReplacement({ limit: 9999 });
      expect(repo.findUnreplacedTaggedEntries).toHaveBeenCalledWith('ws1', 2000);
      expect(result.limit).toBe(2000);
    });
  });

  // Builds a controller where one specific collaborator is the supplied test
  // double, all others are stock fakes. Keeps the call sites short and
  // resilient to constructor signature changes (e.g. adding webhookEvents).
  function makeCtrlWithOverride(overrides: Partial<{
    ratesRepo: any; ratesService: any; tagAssigneeRepo: any; tasksRepo: any; queues: any; resolutions: any;
  }>) {
    return new AdminController(
      overrides.queues ?? makeQueues(),
      makeDeadLetters(),
      makeClickup(),
      makeWebhooks(),
      makeTimeEntriesRepo(),
      overrides.ratesRepo ?? makeRatesRepo(),
      makeBudgetsRepo(),
      overrides.tagAssigneeRepo ?? makeTagAssigneeRepo(),
      overrides.tasksRepo ?? makeTasksRepo(),
      overrides.ratesService ?? makeRatesService(),
      makeWebhookEvents(),
      makeWebhookParser(),
      makePrisma(),
      makeAuditLog(),
      makeSettings(),
      makeWorkspaces(),
      makeSpikeNotifications(),
      overrides.resolutions ?? makeSpikeResolutions(),
      { search: jest.fn() } as any,
      { forTask: jest.fn() } as any,
    );
  }

  describe('reconcileTasks', () => {
    it('enqueues a reconcile job per stored task on clickup-tasks with a 365-day window by default', async () => {
      const tasksRepo = { findAllIds: jest.fn().mockResolvedValue([
        { taskId: 't1', spaceId: 's1' },
        { taskId: 't2', spaceId: 's1' },
      ]) } as any;
      const queues = makeQueues();
      const result = await makeCtrlWithOverride({ tasksRepo, queues }).reconcileTasks();

      expect(result).toEqual({ queued: 2 });
      expect(queues.get).toHaveBeenCalledWith('clickup-tasks');
      const add = (queues.get as jest.Mock).mock.results[0].value.add as jest.Mock;
      expect(add).toHaveBeenCalledTimes(2);
      const [jobName, payload] = add.mock.calls[0];
      expect(jobName).toBe('reconcile-clickup-task');
      expect(payload.taskId).toBe('t1');
      expect(typeof payload.startDate).toBe('number');
      expect(typeof payload.endDate).toBe('number');
      // default lookback 365 days → ~ a year of window
      expect(payload.endDate - payload.startDate).toBeGreaterThan(360 * 24 * 60 * 60 * 1000);
    });

    it('respects an explicit lookbackDays override', async () => {
      const tasksRepo = { findAllIds: jest.fn().mockResolvedValue([{ taskId: 't1', spaceId: 's1' }]), countActive: jest.fn() } as any;
      const queues = makeQueues();
      await makeCtrlWithOverride({ tasksRepo, queues }).reconcileTasks('10');
      const add = (queues.get as jest.Mock).mock.results[0].value.add as jest.Mock;
      const [, payload] = add.mock.calls[0];
      const days = (payload.endDate - payload.startDate) / (24 * 60 * 60 * 1000);
      expect(Math.round(days)).toBe(10);
    });

    it('refuses to start a second sweep while a reconcile is in flight (no enqueue)', async () => {
      const add = jest.fn();
      const getJobs = jest.fn().mockResolvedValue([{ name: 'reconcile-clickup-task', data: { workspaceId: 'ws1' } }]);
      const queues = { get: jest.fn().mockReturnValue({ add, getJobs }), defaultJobOptions: jest.fn().mockReturnValue({}), webhookJobOptions: jest.fn().mockReturnValue({}) } as any;
      const tasksRepo = { findAllIds: jest.fn() } as any;

      const result = await makeCtrlWithOverride({ tasksRepo, queues }).reconcileTasks();

      expect(result).toEqual({ queued: 0, alreadyRunning: true });
      expect(add).not.toHaveBeenCalled();
      expect(tasksRepo.findAllIds).not.toHaveBeenCalled(); // short-circuits before scanning tasks
    });
  });

  describe('reconcileActive', () => {
    // clickup-tasks queue carrying a mix of job names; only reconcile jobs count.
    function makeQueuesWithTaskJobs(jobs: Array<{ name: string; data?: any }>) {
      const getJobs = jest.fn().mockResolvedValue(jobs);
      const get = jest.fn((name: string) => (name === 'clickup-tasks' ? { getJobs, add: jest.fn() } : { getJobs: jest.fn().mockResolvedValue([]), add: jest.fn() }));
      return { get, defaultJobOptions: jest.fn().mockReturnValue({}), webhookJobOptions: jest.fn().mockReturnValue({}) } as any;
    }

    it('reports remaining reconcile jobs (ignoring other clickup-tasks jobs) with total from stored task count', async () => {
      const queues = makeQueuesWithTaskJobs([
        { name: 'reconcile-clickup-task', data: { workspaceId: 'ws1' } },
        { name: 'reconcile-clickup-task', data: { workspaceId: 'ws1' } },
        { name: 'sync-clickup-task' }, // must be ignored
        { name: 'reconcile-clickup-task', data: { workspaceId: 'ws1' } },
      ]);
      const tasksRepo = { findAllIds: jest.fn(), countActive: jest.fn().mockResolvedValue(10) } as any;
      const result = await makeCtrlWithOverride({ queues, tasksRepo }).reconcileActive();
      expect(result).toEqual({ active: true, total: 10, done: 7, remaining: 3 });
    });

    it('is idle (no count query) when no reconcile jobs are queued', async () => {
      const queues = makeQueuesWithTaskJobs([{ name: 'sync-clickup-task' }]);
      const tasksRepo = { findAllIds: jest.fn(), countActive: jest.fn() } as any;
      const result = await makeCtrlWithOverride({ queues, tasksRepo }).reconcileActive();
      expect(result).toEqual({ active: false, total: 0, done: 0, remaining: 0 });
      expect(tasksRepo.countActive).not.toHaveBeenCalled();
    });

    it('clamps done to >= 0 when tasks were deleted mid-run (remaining > current total)', async () => {
      const queues = makeQueuesWithTaskJobs([
        { name: 'reconcile-clickup-task', data: { workspaceId: 'ws1' } },
        { name: 'reconcile-clickup-task', data: { workspaceId: 'ws1' } },
      ]);
      const tasksRepo = { findAllIds: jest.fn(), countActive: jest.fn().mockResolvedValue(1) } as any;
      const result = await makeCtrlWithOverride({ queues, tasksRepo }).reconcileActive();
      expect(result).toEqual({ active: true, total: 1, done: 0, remaining: 2 });
    });
  });

  function ctrlWithSettings(settings: any, workspaces?: any) {
    return new AdminController(
      makeQueues(),
      makeDeadLetters(),
      makeClickup(),
      makeWebhooks(),
      makeTimeEntriesRepo(),
      makeRatesRepo(),
      makeBudgetsRepo(),
      makeTagAssigneeRepo(),
      makeTasksRepo(),
      makeRatesService(),
      makeWebhookEvents(),
      makeWebhookParser(),
      makePrisma(),
      makeAuditLog(),
      settings,
      workspaces ?? makeWorkspaces(),
      makeSpikeNotifications(),
      makeSpikeResolutions(),
      { search: jest.fn() } as any,
      { forTask: jest.fn() } as any,
    );
  }

  describe('settings', () => {
    it('getSettings merges app-global prefs with encryption flag + masked workspaces', () => {
      const global = { preferences: { cost: { excludedAssignees: [] } }, updatedAt: null, updatedBy: null };
      const settings = { getGlobal: jest.fn().mockReturnValue(global) } as any;
      const ws = [{ id: 'ws1', name: 'Default', teamId: '123', apiTokenSet: true }];
      const workspaces = makeWorkspaces();
      workspaces.listMasked.mockReturnValue(ws);
      workspaces.encryptionEnabled.mockReturnValue(true);
      expect(ctrlWithSettings(settings, workspaces).getSettings()).toEqual({
        ...global,
        encryptionEnabled: true,
        workspaces: ws,
      });
    });

    // The encryption guard moved off this endpoint: app-global settings no longer
    // carry secrets, so updateSettings just persists preferences. The secret-write
    // guard now lives on the workspace CRUD endpoints (createWorkspace /
    // updateWorkspace), so we assert that delegation here instead.
    it('createWorkspace delegates dto + session actor to WorkspaceService', async () => {
      const workspaces = makeWorkspaces();
      const ctrl = ctrlWithSettings(makeSettings(), workspaces);
      const dto = { name: 'New', teamId: '999', apiToken: 'pk_x' } as any;
      await ctrl.createWorkspace(dto, { email: 'me@test.com', isMachine: false } as any);
      expect(workspaces.createWorkspace).toHaveBeenCalledWith(dto, 'me@test.com');
    });

    it('updateWorkspace delegates id + dto + session actor to WorkspaceService', async () => {
      const workspaces = makeWorkspaces();
      const ctrl = ctrlWithSettings(makeSettings(), workspaces);
      const dto = { apiToken: 'pk_x' } as any;
      await ctrl.updateWorkspace('ws1', dto, { email: 'me@test.com', isMachine: false } as any);
      expect(workspaces.updateWorkspace).toHaveBeenCalledWith('ws1', dto, 'me@test.com');
    });

    it('updateSettings delegates preferences with the session actor (not a spoofable header)', async () => {
      const settings = { update: jest.fn().mockResolvedValue({}) } as any;
      const dto = { preferences: { cost: { nonBillableZero: true } } } as any;
      await ctrlWithSettings(settings).updateSettings(dto, { email: 'me@test.com', isMachine: false } as any);
      expect(settings.update).toHaveBeenCalledWith(dto, 'me@test.com');
    });
  });

  describe('rates CRUD', () => {
    it('listRates delegates to ratesRepo.findAll (read path stays on the repo)', async () => {
      const ratesRepo = makeRatesRepo();
      await makeCtrlWithOverride({ ratesRepo }).listRates(1, 50);
      expect(ratesRepo.findAll).toHaveBeenCalledWith(1, 50);
    });

    it('createRate calls ratesService.create (mutation seam) with parsed dates', async () => {
      const ratesService = makeRatesService();
      await makeCtrlWithOverride({ ratesService }).createRate({
        assigneeId: 'u1', currency: 'AUD', hourlyRateCents: 15000, validFrom: '2024-01-01',
      });
      expect(ratesService.create).toHaveBeenCalledWith(expect.objectContaining({ assigneeId: 'u1', hourlyRateCents: 15000 }));
    });

    it('deleteRate calls ratesService.remove with parsed BigInt id', async () => {
      const ratesService = makeRatesService();
      await makeCtrlWithOverride({ ratesService }).deleteRate('42');
      expect(ratesService.remove).toHaveBeenCalledWith(BigInt(42));
    });
  });

  describe('tag-assignee map CRUD', () => {
    it('listTagAssignee delegates to tagAssigneeRepo.findAll', async () => {
      const tagAssigneeRepo = makeTagAssigneeRepo();
      await makeCtrlWithOverride({ tagAssigneeRepo }).listTagAssignee();
      expect(tagAssigneeRepo.findAll).toHaveBeenCalled();
    });

    it('deleteTagAssignee calls tagAssigneeRepo.remove with parsed BigInt id', async () => {
      const tagAssigneeRepo = makeTagAssigneeRepo();
      await makeCtrlWithOverride({ tagAssigneeRepo }).deleteTagAssignee('7');
      expect(tagAssigneeRepo.remove).toHaveBeenCalledWith(BigInt(7));
    });
  });

  describe('excluded-assignees', () => {
    const user = { email: 'admin@x.com' } as any;

    it('GET returns the stored list', () => {
      const ctrl = makeCtrl(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, makeSettings([{ id: 'u1', name: 'A', email: null }]));
      expect(ctrl.listExcludedAssignees()).toEqual({ assignees: [{ id: 'u1', name: 'A', email: null }] });
    });

    it('PUT add-only enqueues the added id', async () => {
      const { queues, add } = makeQueuesWithAdd();
      const ctrl = makeCtrl(queues, undefined, undefined, undefined, undefined, undefined, undefined, undefined, makeSettings([]));
      const result = await ctrl.updateExcludedAssignees({ assignees: [{ id: 'u1' }] } as any, user);
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(expect.any(String), { assigneeId: 'u1' }, expect.any(Object));
      expect(result.recalculated).toContain('u1');
    });

    it('PUT remove-only enqueues the removed id', async () => {
      const { queues, add } = makeQueuesWithAdd();
      const ctrl = makeCtrl(queues, undefined, undefined, undefined, undefined, undefined, undefined, undefined, makeSettings([{ id: 'u1', name: 'A', email: null }]));
      const result = await ctrl.updateExcludedAssignees({ assignees: [] } as any, user);
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(expect.any(String), { assigneeId: 'u1' }, expect.any(Object));
      expect(result.recalculated).toContain('u1');
      expect(result.assignees).toEqual([]);
    });

    it('PUT mixed enqueues only the added + removed ids, not the unchanged one', async () => {
      const { queues, add } = makeQueuesWithAdd();
      const ctrl = makeCtrl(queues, undefined, undefined, undefined, undefined, undefined, undefined, undefined, makeSettings([{ id: 'u1' }, { id: 'u2' }]));
      await ctrl.updateExcludedAssignees({ assignees: [{ id: 'u2' }, { id: 'u3' }] } as any, user);
      expect(add).toHaveBeenCalledTimes(2);
      const enqueuedIds = new Set(add.mock.calls.map((c) => c[1].assigneeId));
      expect(enqueuedIds).toEqual(new Set(['u1', 'u3']));
    });

    it('PUT no-op (unchanged list) enqueues nothing', async () => {
      const { queues, add } = makeQueuesWithAdd();
      const ctrl = makeCtrl(queues, undefined, undefined, undefined, undefined, undefined, undefined, undefined, makeSettings([{ id: 'u1', name: 'A', email: null }]));
      const result = await ctrl.updateExcludedAssignees({ assignees: [{ id: 'u1', name: 'A', email: null }] } as any, user);
      expect(add).not.toHaveBeenCalled();
      expect(result.recalculated).toEqual([]);
    });
  });

  describe('hour-spike resolutions', () => {
    it('resolveSpike delegates to the service with the actor', async () => {
      const resolutions = { resolve: jest.fn().mockResolvedValue({ resolved: true, date: '2026-06-10' }), unresolve: jest.fn() } as any;
      const ctrl = makeCtrlWithOverride({ resolutions });
      const user = { id: 'admin@x', email: 'admin@x', role: 'OWNER' } as any;
      await ctrl.resolveSpike({ userId: 'u1', date: '2026-06-10', userName: 'Ann', note: 'ok' } as any, user);
      expect(resolutions.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', date: '2026-06-10', userName: 'Ann', note: 'ok', resolvedBy: 'admin@x' }),
      );
    });

    it('unresolveSpike delegates to the service', async () => {
      const resolutions = { resolve: jest.fn(), unresolve: jest.fn().mockResolvedValue({ resolved: false, date: '2026-06-10' }) } as any;
      const ctrl = makeCtrlWithOverride({ resolutions });
      await ctrl.unresolveSpike({ userId: 'u1', date: '2026-06-10' } as any);
      expect(resolutions.unresolve).toHaveBeenCalledWith({ workspaceId: 'ws1', userId: 'u1', date: '2026-06-10' });
    });
  });
});
