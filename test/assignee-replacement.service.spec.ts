import { AssigneeReplacementService, ReplacementJobData } from '../src/time-entries/assignee-replacement.service';

// The default fixture carries the `chisty` tag on the *time entry itself*
// (which is how ClickUp surfaces these in the live data) and a non-agency
// originalUserId, so that the service exercise mirrors real traffic shape.
const SAMPLE_JOB: ReplacementJobData = {
  workspaceId: 'ws1',
  timeEntryId: 'entry-123',
  taskId: 'task-456',
  startMs: 1700000000000,
  endMs: 1700003600000,
  durationHours: 1,
  billable: true,
  description: 'Work done',
  originalUserId: '54569564',
  tags: ['chisty'],
};

const ACTIVE_MAPPINGS = [
  {
    id: BigInt(1),
    tagName: 'chisty',
    clickupUserId: '242630708',
    clickupUserName: 'Chishty',
    clickupEmail: 'chishty@test.com',
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

function buildMocks(
  overrides: Partial<{
    findByOriginalEntryId: jest.Mock;
    createReplacement: jest.Mock;
    findAllActive: jest.Mock;
    createTimeEntry: jest.Mock;
    deleteTimeEntry: jest.Mock;
    costs: jest.Mock;
    upsert: jest.Mock;
    deleteLocal: jest.Mock;
  }> = {},
) {
  const findByOriginalEntryId =
    overrides.findByOriginalEntryId ?? jest.fn().mockResolvedValue(null);
  const createReplacement =
    overrides.createReplacement ?? jest.fn().mockResolvedValue({ id: BigInt(1) });
  const findAllActive =
    overrides.findAllActive ?? jest.fn().mockResolvedValue(ACTIVE_MAPPINGS);
  const createTimeEntry =
    overrides.createTimeEntry ??
    jest.fn().mockResolvedValue({ id: 'new-entry-789', task: { id: 'task-456' } });
  const deleteTimeEntry =
    overrides.deleteTimeEntry ?? jest.fn().mockResolvedValue(undefined);
  const costs =
    overrides.costs ??
    jest.fn().mockResolvedValue({
      rateId: null,
      currency: 'AUD',
      hourlyRateCents: 0n,
      costCents: 0n,
      status: 'NO_RATE_FOUND',
    });
  const upsert = overrides.upsert ?? jest.fn().mockResolvedValue({});
  const deleteByTimeEntryId =
    overrides.deleteLocal ?? jest.fn().mockResolvedValue({ count: 1 });

  // getTask is no longer called by the service — kept here only so a stray
  // reference would surface as `not toHaveBeenCalled` in the tests below.
  const getTask = jest.fn();

  const clickup = { getTask, createTimeEntry, deleteTimeEntry } as any;
  const tagAssigneeMap = { findAllActive, findByTagName: jest.fn() } as any;
  const replacements = { findByOriginalEntryId, create: createReplacement } as any;
  const costsService = { calculate: costs } as any;
  const timeEntriesRepo = { upsert, deleteByTimeEntryId } as any;

  const service = new AssigneeReplacementService(
    clickup,
    tagAssigneeMap,
    replacements,
    costsService,
    timeEntriesRepo,
    { getTeamId: () => '3450636', getPreferences: () => ({ cost: { rateMatching: 'start', nonBillableZero: false, autoRecalcOnRateChange: true } }) } as any,
    { clickupTask: { findUnique: jest.fn().mockResolvedValue(null) } } as any,
  );

  return {
    service,
    clickup,
    tagAssigneeMap,
    replacements,
    costsService,
    timeEntriesRepo,
    findByOriginalEntryId,
    createReplacement,
    findAllActive,
    getTask,
    createTimeEntry,
    deleteTimeEntry,
    costs,
    upsert,
    deleteByTimeEntryId,
  };
}

describe('AssigneeReplacementService.replaceEntry', () => {
  it('resume: when an audit row already exists, does NOT create again but RE-RUNS the delete + local cleanup', async () => {
    // The audit row proves the replacement was created on a prior run. The prior
    // run's delete may have failed (a ClickUp 5xx/timeout is routine), so resume
    // must retry the delete instead of skipping — otherwise the original lingers
    // alongside the replacement and reports double-count forever.
    const { service, getTask, createTimeEntry, createReplacement, deleteTimeEntry, deleteByTimeEntryId } = buildMocks({
      findByOriginalEntryId: jest.fn().mockResolvedValue({ id: BigInt(99), replacementEntryId: 'new-entry-789' }),
    });

    const result = await service.replaceEntry(SAMPLE_JOB);

    expect(result).toEqual({ status: 'skipped' });
    expect(getTask).not.toHaveBeenCalled();
    expect(createTimeEntry).not.toHaveBeenCalled(); // no second ClickUp entry
    expect(createReplacement).not.toHaveBeenCalled(); // no second audit row
    expect(deleteTimeEntry).toHaveBeenCalledWith(SAMPLE_JOB.workspaceId, SAMPLE_JOB.timeEntryId); // delete retried
    expect(deleteByTimeEntryId).toHaveBeenCalledWith(SAMPLE_JOB.timeEntryId); // local original removed
  });

  it('resume: a 404 from the retried delete is tolerated (already gone = done)', async () => {
    const { service } = buildMocks({
      findByOriginalEntryId: jest.fn().mockResolvedValue({ id: BigInt(99), replacementEntryId: 'new-entry-789' }),
      deleteTimeEntry: jest.fn().mockRejectedValue({ response: { status: 404 } }),
    });

    await expect(service.replaceEntry(SAMPLE_JOB)).resolves.toEqual({ status: 'skipped' });
  });

  it('resume: a non-404 delete failure propagates so BullMQ retries (does not silently skip)', async () => {
    const { service, deleteByTimeEntryId } = buildMocks({
      findByOriginalEntryId: jest.fn().mockResolvedValue({ id: BigInt(99), replacementEntryId: 'new-entry-789' }),
      deleteTimeEntry: jest.fn().mockRejectedValue({ response: { status: 503 } }),
    });

    await expect(service.replaceEntry(SAMPLE_JOB)).rejects.toMatchObject({ response: { status: 503 } });
    // Local cleanup must NOT run when the ClickUp delete didn't succeed.
    expect(deleteByTimeEntryId).not.toHaveBeenCalled();
  });

  it('returns no_mapping when entry tags do not match any active mapping', async () => {
    const { service, createTimeEntry, deleteTimeEntry } = buildMocks();

    const result = await service.replaceEntry({ ...SAMPLE_JOB, tags: ['design'] });

    expect(result).toEqual({ status: 'no_mapping' });
    expect(createTimeEntry).not.toHaveBeenCalled();
    expect(deleteTimeEntry).not.toHaveBeenCalled();
  });

  it('returns no_mapping when entry has no tags', async () => {
    const { service, createTimeEntry, deleteTimeEntry } = buildMocks();

    const result = await service.replaceEntry({ ...SAMPLE_JOB, tags: [] });

    expect(result).toEqual({ status: 'no_mapping' });
    expect(createTimeEntry).not.toHaveBeenCalled();
    expect(deleteTimeEntry).not.toHaveBeenCalled();
  });

  it('never calls clickup.getTask — task tags are not the routing source anymore', async () => {
    const { service, getTask } = buildMocks();

    await service.replaceEntry(SAMPLE_JOB);

    expect(getTask).not.toHaveBeenCalled();
  });

  it('performs successful replacement: creates entry, saves audit row, then deletes original', async () => {
    const callOrder: string[] = [];

    const createReplacement = jest.fn().mockImplementation(async () => {
      callOrder.push('create');
      return { id: BigInt(1) };
    });
    const deleteTimeEntry = jest.fn().mockImplementation(async () => {
      callOrder.push('delete');
    });

    const { service, createTimeEntry, upsert } = buildMocks({
      createReplacement,
      deleteTimeEntry,
    });

    const result = await service.replaceEntry(SAMPLE_JOB);

    expect(result).toEqual({ status: 'replaced' });
    expect(createTimeEntry).toHaveBeenCalled();
    expect(createReplacement).toHaveBeenCalled();
    expect(deleteTimeEntry).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalled();

    // Audit row MUST be created before original is deleted
    expect(callOrder[0]).toBe('create');
    expect(callOrder[1]).toBe('delete');
  });

  it('passes correct payload to createTimeEntry', async () => {
    const { service, createTimeEntry } = buildMocks();

    await service.replaceEntry(SAMPLE_JOB);

    expect(createTimeEntry).toHaveBeenCalledWith(SAMPLE_JOB.workspaceId, {
      start: SAMPLE_JOB.startMs,
      stop: SAMPLE_JOB.endMs,
      description: SAMPLE_JOB.description,
      billable: SAMPLE_JOB.billable,
      tid: SAMPLE_JOB.taskId,
      assignee: Number(ACTIVE_MAPPINGS[0].clickupUserId),
    });
  });

  it('audit row records the actual logger as originalUserId, not the agency account', async () => {
    const { service, createReplacement } = buildMocks();

    await service.replaceEntry(SAMPLE_JOB);

    expect(createReplacement).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: SAMPLE_JOB.workspaceId,
        originalEntryId: SAMPLE_JOB.timeEntryId,
        replacementEntryId: 'new-entry-789',
        taskId: SAMPLE_JOB.taskId,
        originalUserId: SAMPLE_JOB.originalUserId,
        replacedUserId: ACTIVE_MAPPINGS[0].clickupUserId,
        tagName: 'chisty',
        status: 'replaced',
      }),
    );
  });

  it('calls deleteTimeEntry with workspace id and original entry id', async () => {
    const { service, deleteTimeEntry } = buildMocks();

    await service.replaceEntry(SAMPLE_JOB);

    expect(deleteTimeEntry).toHaveBeenCalledWith(SAMPLE_JOB.workspaceId, SAMPLE_JOB.timeEntryId);
  });

  it('upserts replacement entry into local DB after deletion', async () => {
    const { service, upsert } = buildMocks();

    await service.replaceEntry(SAMPLE_JOB);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        timeEntryId: 'new-entry-789',
        taskId: SAMPLE_JOB.taskId,
        userId: ACTIVE_MAPPINGS[0].clickupUserId,
        userName: ACTIVE_MAPPINGS[0].clickupUserName,
        userEmail: ACTIVE_MAPPINGS[0].clickupEmail,
        durationHours: SAMPLE_JOB.durationHours,
        billable: SAMPLE_JOB.billable,
        description: SAMPLE_JOB.description,
      }),
      expect.objectContaining({ status: 'NO_RATE_FOUND' }),
      SAMPLE_JOB.workspaceId,
    );
  });

  it('deletes the local original row so reports do not double-count original + replacement', async () => {
    const { service, deleteByTimeEntryId, upsert } = buildMocks();

    await service.replaceEntry(SAMPLE_JOB);

    // The replacement entry is upserted under its NEW id...
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ timeEntryId: 'new-entry-789' }),
      expect.anything(),
      SAMPLE_JOB.workspaceId,
    );
    // ...and the ORIGINAL local row must be removed, otherwise SUM(hours)/SUM(cost)
    // in reports counts both the original and the replacement.
    expect(deleteByTimeEntryId).toHaveBeenCalledWith(SAMPLE_JOB.timeEntryId);
  });

  it('does not delete any local row when the entry has no mapping', async () => {
    const { service, deleteByTimeEntryId } = buildMocks();

    await service.replaceEntry({ ...SAMPLE_JOB, tags: ['design'] });

    expect(deleteByTimeEntryId).not.toHaveBeenCalled();
  });

  it('matches case-insensitively (e.g. "Chisty" -> "chisty" mapping)', async () => {
    const { service, createTimeEntry, createReplacement } = buildMocks();

    const result = await service.replaceEntry({ ...SAMPLE_JOB, tags: ['Chisty'] });

    expect(result).toEqual({ status: 'replaced' });
    expect(createTimeEntry).toHaveBeenCalled();
    expect(createReplacement).toHaveBeenCalledWith(
      expect.objectContaining({ tagName: 'chisty' }),
    );
  });
});
