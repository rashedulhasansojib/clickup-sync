import { SyncScheduler } from '../src/sync/sync.scheduler';
import { JOBS } from '../src/queues/queue.constants';

// The scheduler now derives its scope from WorkspaceService (per-workspace,
// per-space) rather than the static CLICKUP_SPACES config. We drive it with a
// mocked WorkspaceService that returns one active workspace with three spaces.
const WS = 'ws1';
const SPACES = [
  { spaceId: 's1', name: 'Space 1', backfillLookbackDays: 30, enabled: true },
  { spaceId: 's2', name: 'Space 2', backfillLookbackDays: 30, enabled: true },
  { spaceId: 's3', name: 'Space 3', backfillLookbackDays: 30, enabled: true },
];

function makeQueues(liveJobs: any[] = []) {
  const queue = { add: jest.fn().mockResolvedValue(undefined), getJobs: jest.fn().mockResolvedValue(liveJobs) };
  const queues = { get: jest.fn().mockReturnValue(queue), defaultJobOptions: jest.fn().mockReturnValue({}) };
  return { queues, queue };
}

function makeWorkspaces(spaces = SPACES) {
  return {
    listActiveWorkspaceIds: () => [WS],
    getSpaces: (_wsId: string) => spaces,
  } as any;
}

describe('SyncScheduler.reconcileRecentUpdates', () => {
  it('enqueues one bounded backfill per enabled space', async () => {
    const { queues, queue } = makeQueues([]);
    await new SyncScheduler(queues as any, makeWorkspaces()).reconcileRecentUpdates();
    expect(queue.add).toHaveBeenCalledTimes(SPACES.length);
    for (const space of SPACES) {
      expect(queue.add).toHaveBeenCalledWith(
        JOBS.BACKFILL_CLICKUP_SPACE,
        { workspaceId: WS, spaceId: space.spaceId, lookbackDays: 1, timeEntryLookbackDays: 7 },
        {},
      );
    }
  });

  it('skips a space whose backfill is still in flight (overlap guard)', async () => {
    const busy = SPACES[0].spaceId;
    // Busy key is workspace-scoped: `${workspaceId}:${spaceId}`.
    const { queues, queue } = makeQueues([{ data: { workspaceId: WS, spaceId: busy } }]);
    await new SyncScheduler(queues as any, makeWorkspaces()).reconcileRecentUpdates();
    expect(queue.add).toHaveBeenCalledTimes(SPACES.length - 1);
    const enqueued = queue.add.mock.calls.map((c: any[]) => c[1].spaceId);
    expect(enqueued).not.toContain(busy);
  });

  it('skips a space disabled in settings', async () => {
    const off = SPACES[0].spaceId;
    const spaces = SPACES.map((s) => (s.spaceId === off ? { ...s, enabled: false } : s));
    const { queues, queue } = makeQueues([]);
    await new SyncScheduler(queues as any, makeWorkspaces(spaces)).reconcileRecentUpdates();
    expect(queue.add).toHaveBeenCalledTimes(SPACES.length - 1);
    const enqueued = queue.add.mock.calls.map((c: any[]) => c[1].spaceId);
    expect(enqueued).not.toContain(off);
  });
});
