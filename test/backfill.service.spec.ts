import { BackfillService } from '../src/sync/backfill.service';
import { JOBS } from '../src/queues/queue.constants';

describe('BackfillService.backfillSpace — time-entry lookback window', () => {
  const RD_APPS_ID = '3589129'; // configured backfillLookbackDays = 30

  function makeDeps() {
    const queueAdd = jest.fn().mockResolvedValue({});
    const queues = {
      get: jest.fn().mockReturnValue({ add: queueAdd }),
      defaultJobOptions: jest.fn().mockReturnValue({}),
    } as any;
    const clickup = {
      getAllTasksBySpace: jest.fn().mockResolvedValue({ tasks: [{ id: 'task-1' }], truncated: false }),
    } as any;
    const tasks = {
      syncTasks: jest.fn().mockResolvedValue(undefined),
      patchSpaceNames: jest.fn().mockResolvedValue(undefined),
      syncMissingParents: jest.fn().mockResolvedValue(0),
    } as any;
    const checkpoints = {
      markAttempt: jest.fn().mockResolvedValue(undefined),
      markSuccess: jest.fn().mockResolvedValue(undefined),
    } as any;
    // Space config now comes from WorkspaceService.getSpace(wsId, spaceId).
    // R&D Apps has a configured backfillLookbackDays floor of 30; any other
    // (unknown) space resolves to undefined → no floor.
    const workspaces = {
      getTeamId: () => '3450636',
      getSpace: jest.fn((_wsId: string, spaceId: string) =>
        spaceId === RD_APPS_ID
          ? { spaceId, name: 'R&D Apps', backfillLookbackDays: 30, enabled: true }
          : undefined,
      ),
    } as any;
    return { queueAdd, queues, clickup, tasks, checkpoints, workspaces };
  }

  function timeEntryJobs(queueAdd: jest.Mock) {
    return queueAdd.mock.calls.filter(([jobName]) => jobName === JOBS.SYNC_TASK_TIME_ENTRIES);
  }

  function startDateOf(call: any[]) {
    return call[1].startDate as number;
  }

  // Explicit override > configured floor. This is the bug that was masking
  // Hello Ahmad's January time entries: a 140-day manual backfill was getting
  // silently capped to the R&D Apps 20-day configured lookback.
  it('expands the time-entry window when lookbackDays override exceeds the space floor', async () => {
    const { queueAdd, queues, clickup, tasks, checkpoints, workspaces } = makeDeps();
    const svc = new BackfillService(clickup, tasks, checkpoints, queues, workspaces);

    const beforeMs = Date.now();
    await svc.backfillSpace('ws1', RD_APPS_ID, 140);
    const afterMs = Date.now();

    const calls = timeEntryJobs(queueAdd);
    expect(calls).toHaveLength(1);
    const days140Ms = 140 * 24 * 60 * 60 * 1000;
    expect(startDateOf(calls[0])).toBeGreaterThanOrEqual(beforeMs - days140Ms);
    expect(startDateOf(calls[0])).toBeLessThanOrEqual(afterMs - days140Ms + 5);
  });

  // Configured floor protects against short overrides. A 1-day scheduled
  // reconciliation must NOT shrink the time-entry window to 1 day, or any
  // time logged earlier in the week is invisible until the next full backfill.
  it('keeps the space floor when the lookbackDays override is shorter', async () => {
    const { queueAdd, queues, clickup, tasks, checkpoints, workspaces } = makeDeps();
    const svc = new BackfillService(clickup, tasks, checkpoints, queues, workspaces);

    const beforeMs = Date.now();
    await svc.backfillSpace('ws1', RD_APPS_ID, 1);
    const afterMs = Date.now();

    const calls = timeEntryJobs(queueAdd);
    expect(calls).toHaveLength(1);
    const days30Ms = 30 * 24 * 60 * 60 * 1000;
    expect(startDateOf(calls[0])).toBeGreaterThanOrEqual(beforeMs - days30Ms);
    expect(startDateOf(calls[0])).toBeLessThanOrEqual(afterMs - days30Ms + 5);
  });

  // The recurring reconciliation sweep passes an explicit time-entry window so
  // it can scan a bounded 7 days instead of re-draining the full configured
  // floor every run. An explicit window wins even when it is *shorter* than the
  // space floor (here 7 < the R&D Apps 30-day floor).
  it('uses an explicit timeEntryLookbackDays even when shorter than the space floor', async () => {
    const { queueAdd, queues, clickup, tasks, checkpoints, workspaces } = makeDeps();
    const svc = new BackfillService(clickup, tasks, checkpoints, queues, workspaces);

    const beforeMs = Date.now();
    await svc.backfillSpace('ws1', RD_APPS_ID, 1, 7);
    const afterMs = Date.now();

    const calls = timeEntryJobs(queueAdd);
    expect(calls).toHaveLength(1);
    const days7Ms = 7 * 24 * 60 * 60 * 1000;
    expect(startDateOf(calls[0])).toBeGreaterThanOrEqual(beforeMs - days7Ms);
    expect(startDateOf(calls[0])).toBeLessThanOrEqual(afterMs - days7Ms + 5);
  });

  // A subtask whose parent was updated outside the lookback window won't be in
  // the fetched page; without fetching it, the subtask's parentTaskId points at
  // a non-existent row and parent/subtask report joins break.
  it('fetches parents referenced by subtasks but absent from the fetched page', async () => {
    const { queues, tasks, checkpoints, workspaces } = makeDeps();
    const clickup = {
      getAllTasksBySpace: jest.fn().mockResolvedValue({
        tasks: [
          { id: 'parent-A' },                      // present parent
          { id: 'sub-1', parent: 'parent-A' },     // parent present → not missing
          { id: 'sub-2', parent: 'parent-MISSING' }, // parent absent from page
        ],
        truncated: false,
      }),
    } as any;
    const svc = new BackfillService(clickup, tasks, checkpoints, queues, workspaces);

    await svc.backfillSpace('ws1', '99999999', 30);

    expect(tasks.syncMissingParents).toHaveBeenCalledTimes(1);
    // syncMissingParents(workspaceId, ids) — workspaceId is now arg 0, ids arg 1.
    expect(tasks.syncMissingParents.mock.calls[0][0]).toBe('ws1');
    const passedIds = tasks.syncMissingParents.mock.calls[0][1];
    expect(passedIds).toEqual(['parent-MISSING']);
  });

  // Unknown space → no configured floor → use the override as-is.
  it('uses the lookbackDays override directly when the space is not configured', async () => {
    const { queueAdd, queues, clickup, tasks, checkpoints, workspaces } = makeDeps();
    const svc = new BackfillService(clickup, tasks, checkpoints, queues, workspaces);

    const beforeMs = Date.now();
    await svc.backfillSpace('ws1', '99999999', 45);
    const afterMs = Date.now();

    const calls = timeEntryJobs(queueAdd);
    expect(calls).toHaveLength(1);
    const days45Ms = 45 * 24 * 60 * 60 * 1000;
    expect(startDateOf(calls[0])).toBeGreaterThanOrEqual(beforeMs - days45Ms);
    expect(startDateOf(calls[0])).toBeLessThanOrEqual(afterMs - days45Ms + 5);
  });
});
