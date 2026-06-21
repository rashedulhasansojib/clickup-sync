import { TimeEntriesService } from '../src/time-entries/time-entries.service';

// Bare-minimum collaborators for `syncTaskTimeEntries`. Each test patches
// what it needs to assert. The self-heal under test is the
// `tasksRepo.exists` → `tasksService.syncTask` branch that prevents the FK
// violation we observed in production (Foreign key constraint violated on
// clickup_time_entries_task_id_fkey).
function makeService(overrides: Partial<{
  exists: jest.Mock;
  syncTask: jest.Mock;
  getMemberIds: jest.Mock;
  getTimeEntries: jest.Mock;
  upsert: jest.Mock;
  costs: jest.Mock;
  findAllActive: jest.Mock;
}> = {}) {
  const exists = overrides.exists ?? jest.fn().mockResolvedValue(true);
  const syncTask = overrides.syncTask ?? jest.fn().mockResolvedValue({});
  const getMemberIds = overrides.getMemberIds ?? jest.fn().mockResolvedValue(['u1']);
  const getTimeEntries = overrides.getTimeEntries ?? jest.fn().mockResolvedValue([]);
  const upsert = overrides.upsert ?? jest.fn().mockResolvedValue({});
  const costs = overrides.costs ?? jest.fn().mockResolvedValue({
    rateId: null, currency: 'AUD', hourlyRateCents: 0n, costCents: 0n, status: 'NO_RATE_FOUND',
  });
  const findAllActive = overrides.findAllActive ?? jest.fn().mockResolvedValue([]);

  const clickup = { getTimeEntries } as any;
  const normalizer = {
    normalizeTimeEntry: (e: any) => ({
      timeEntryId: e.id, taskId: e.task?.id ?? null, taskName: null,
      userId: e.user?.id ?? null, userName: null, userEmail: null,
      startTime: new Date(0), endTime: new Date(0), durationHours: 1,
      billable: false, description: null, raw: e,
    }),
  } as any;
  const pruneTaskEntriesOutsideSet = jest.fn().mockResolvedValue(0);
  const repo = { upsert, pruneTaskEntriesOutsideSet } as any;
  const costsService = { calculate: costs } as any;
  const queues = { get: jest.fn().mockReturnValue({ add: jest.fn() }), defaultJobOptions: jest.fn().mockReturnValue({}) } as any;
  const members = { getMemberIds } as any;
  const tagAssigneeMap = { findAllActive } as any;
  const tasksRepo = { exists } as any;
  const tasksService = { syncTask } as any;

  const prisma = { clickupTask: { findMany: jest.fn().mockResolvedValue([]) } } as any;
  const service = new TimeEntriesService(
    clickup, normalizer, repo, costsService, queues, members, tagAssigneeMap, tasksRepo, tasksService,
    { getTeamId: () => '3450636', getPreferences: () => ({ cost: { rateMatching: 'start', nonBillableZero: false, autoRecalcOnRateChange: true } }) } as any,
    prisma,
  );

  return { service, exists, syncTask, getMemberIds, getTimeEntries, upsert, costs, findAllActive, pruneTaskEntriesOutsideSet };
}

describe('TimeEntriesService.syncTaskTimeEntries — task self-heal', () => {
  it('does NOT pre-sync the task when it already exists locally', async () => {
    const { service, exists, syncTask } = makeService({
      exists: jest.fn().mockResolvedValue(true),
    });

    await service.syncTaskTimeEntries('ws1', '86exjakgc');

    expect(exists).toHaveBeenCalledWith('86exjakgc');
    expect(syncTask).not.toHaveBeenCalled();
  });

  it('pre-syncs the task BEFORE fetching time entries when missing locally', async () => {
    const callOrder: string[] = [];
    const syncTask = jest.fn().mockImplementation(async () => {
      callOrder.push('syncTask');
    });
    const getTimeEntries = jest.fn().mockImplementation(async () => {
      callOrder.push('getTimeEntries');
      return [];
    });
    // First exists() = gate into self-heal (false). Second exists() = the
    // post-pre-sync recheck — true means syncTask successfully populated the
    // row, so we continue with the normal flow.
    const exists = jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { service } = makeService({ exists, syncTask, getTimeEntries });

    await service.syncTaskTimeEntries('ws1', '86exjakgc');

    expect(syncTask).toHaveBeenCalledWith('ws1', '86exjakgc');
    expect(getTimeEntries).toHaveBeenCalled();
    // Order matters: task row must be inserted before any time-entry upsert
    // could FK against it.
    expect(callOrder).toEqual(['syncTask', 'getTimeEntries']);
  });

  it('skips time-entry sync entirely when the task is still unresolved after pre-sync (avoids FK violation)', async () => {
    // First exists() is the gate that enters the self-heal branch; the second
    // is the re-check after syncTask fails. Both false → bail before any
    // ClickUp/upsert work.
    const exists = jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    const { service, syncTask, getTimeEntries, upsert } = makeService({
      exists,
      syncTask: jest.fn().mockRejectedValue(new Error('ClickUp 404 task not found')),
    });

    // No throw — the job log row should land as completed, not failed,
    // because the failure here is "data not in our domain" not "we broke".
    await expect(service.syncTaskTimeEntries('ws1', '86exjakgc')).resolves.toBe(0);
    expect(syncTask).toHaveBeenCalled();
    expect(getTimeEntries).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('proceeds when pre-sync succeeds and the task is then present', async () => {
    // exists() returns false initially, then true after syncTask inserts the
    // row. Worker should continue with the normal time-entry sync flow.
    const exists = jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { service, syncTask, getTimeEntries } = makeService({
      exists,
      syncTask: jest.fn().mockResolvedValue({}),
    });

    await service.syncTaskTimeEntries('ws1', '86exjakgc');
    expect(syncTask).toHaveBeenCalled();
    expect(getTimeEntries).toHaveBeenCalled();
  });
});

describe('TimeEntriesService.syncTaskTimeEntries — subtask roll-up FK self-heal', () => {
  // ClickUp's team `time_entries?task_id=PARENT` rolls up subtask entries, each
  // carrying its OWN task.id (the subtask). We write entries under that own
  // task_id, so a subtask absent from clickup_tasks violates
  // clickup_time_entries_task_id_fkey — the production failure on 86exwj36d,
  // whose subtask 86exwj4e7 ("INT") was never synced. The queried-task guard
  // does NOT cover this because the queried parent DOES exist.
  function statefulDb(seed: string[]) {
    const present = new Set<string>(seed);
    return {
      present,
      exists: jest.fn(async (id: string) => present.has(id)),
    };
  }

  it('self-heals a foreign task referenced by a rolled-up subtask entry, then upserts both', async () => {
    const { present, exists } = statefulDb(['PARENT']);
    const syncTask = jest.fn(async (_ws: string, id: string) => { present.add(id); return {}; });
    const getTimeEntries = jest.fn().mockResolvedValue([
      { id: 'te-parent', user: { id: 'u1' }, task: { id: 'PARENT' } },
      { id: 'te-sub', user: { id: 'u1' }, task: { id: 'SUB' } }, // rolled-up subtask
    ]);
    const { service, upsert } = makeService({ exists, syncTask, getTimeEntries });

    const count = await service.syncTaskTimeEntries('ws1', 'PARENT');

    expect(syncTask).toHaveBeenCalledWith('ws1', 'SUB'); // healed the subtask, not the parent
    expect(upsert).toHaveBeenCalledTimes(2);      // both entries written, no FK skip
    expect(count).toBe(2);
  });

  it('skips only the unresolvable foreign entry and still writes the rest (no FK violation)', async () => {
    const { exists } = statefulDb(['PARENT']); // SUB never becomes present (404)
    const syncTask = jest.fn(async () => { throw new Error('ClickUp 404'); });
    const getTimeEntries = jest.fn().mockResolvedValue([
      { id: 'te-parent', user: { id: 'u1' }, task: { id: 'PARENT' } },
      { id: 'te-sub', user: { id: 'u1' }, task: { id: 'SUB' } },
    ]);
    const { service, upsert } = makeService({ exists, syncTask, getTimeEntries });

    const count = await service.syncTaskTimeEntries('ws1', 'PARENT');

    expect(syncTask).toHaveBeenCalledWith('ws1', 'SUB');
    expect(upsert).toHaveBeenCalledTimes(1); // only the resolvable PARENT entry
    expect(count).toBe(1);
  });

  it('self-heals each distinct foreign task only once even across multiple entries', async () => {
    const { present, exists } = statefulDb(['PARENT']);
    const syncTask = jest.fn(async (_ws: string, id: string) => { present.add(id); return {}; });
    const getTimeEntries = jest.fn().mockResolvedValue([
      { id: 'te-1', user: { id: 'u1' }, task: { id: 'SUB' } },
      { id: 'te-2', user: { id: 'u1' }, task: { id: 'SUB' } }, // same subtask again
    ]);
    const { service } = makeService({ exists, syncTask, getTimeEntries });

    await service.syncTaskTimeEntries('ws1', 'PARENT');

    expect(syncTask).toHaveBeenCalledTimes(1);
    expect(syncTask).toHaveBeenCalledWith('ws1', 'SUB');
  });
});

describe('TimeEntriesService.syncTaskTimeEntries — delete reconciliation', () => {
  it('prunes local rows scoped to exactly the assignees and window fetched, keeping the ids ClickUp returned', async () => {
    const getTimeEntries = jest.fn().mockResolvedValue([
      { id: 'te-A', user: { id: 'u9' }, task: { id: 't1' } },
    ]);
    const { service, pruneTaskEntriesOutsideSet } = makeService({ getTimeEntries });

    await service.syncTaskTimeEntries('ws1', 't1', ['u9'], 1000, 2000);

    expect(pruneTaskEntriesOutsideSet).toHaveBeenCalledWith({
      workspaceId: 'ws1', taskId: 't1', userIds: ['u9'], startMs: 1000, endMs: 2000, keepIds: ['te-A'],
    });
  });

  it('prunes with an empty keep-set when ClickUp returns nothing (the real all-deleted case)', async () => {
    const { service, pruneTaskEntriesOutsideSet, upsert } = makeService({
      getTimeEntries: jest.fn().mockResolvedValue([]),
    });

    await service.syncTaskTimeEntries('ws1', 't1', ['u9'], 1000, 2000);

    expect(upsert).not.toHaveBeenCalled();
    expect(pruneTaskEntriesOutsideSet).toHaveBeenCalledWith({
      workspaceId: 'ws1', taskId: 't1', userIds: ['u9'], startMs: 1000, endMs: 2000, keepIds: [],
    });
  });

  it('scopes the prune to all workspace members when no assignee ids are supplied', async () => {
    const { service, pruneTaskEntriesOutsideSet } = makeService({
      getMemberIds: jest.fn().mockResolvedValue(['m1', 'm2', 'm3']),
    });

    await service.syncTaskTimeEntries('ws1', 't1');

    expect(pruneTaskEntriesOutsideSet).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws1', taskId: 't1', userIds: ['m1', 'm2', 'm3'] }),
    );
  });

  it('does NOT prune when the task is unresolved (FK-skip path)', async () => {
    const exists = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const { service, pruneTaskEntriesOutsideSet } = makeService({
      exists,
      syncTask: jest.fn().mockRejectedValue(new Error('ClickUp 404')),
    });

    await expect(service.syncTaskTimeEntries('ws1', 'ghost')).resolves.toBe(0);
    expect(pruneTaskEntriesOutsideSet).not.toHaveBeenCalled();
  });
});

describe('TimeEntriesService.syncTaskTimeEntries — prune safety valve', () => {
  it('SKIPS the prune when a fetch returns >= 1000 entries (truncation-suspect → never delete live rows on a partial read)', async () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({ id: `te-${i}`, user: { id: 'u1' }, task: { id: 'PARENT' } }));
    const { service, pruneTaskEntriesOutsideSet } = makeService({
      getTimeEntries: jest.fn().mockResolvedValue(entries),
    });

    await service.syncTaskTimeEntries('ws1', 'PARENT');

    expect(pruneTaskEntriesOutsideSet).not.toHaveBeenCalled();
  });

  it('still prunes for a normal-sized fetch (below the threshold)', async () => {
    const { service, pruneTaskEntriesOutsideSet } = makeService({
      getTimeEntries: jest.fn().mockResolvedValue([{ id: 'te-1', user: { id: 'u1' }, task: { id: 'PARENT' } }]),
    });

    await service.syncTaskTimeEntries('ws1', 'PARENT');

    expect(pruneTaskEntriesOutsideSet).toHaveBeenCalled();
  });
});
