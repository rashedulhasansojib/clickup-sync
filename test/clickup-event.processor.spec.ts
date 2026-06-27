import { ClickupEventProcessor } from '../src/workers/clickup-event.processor';
import { JOBS, QUEUES } from '../src/queues/queue.constants';

function makeQueues() {
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  return {
    get: jest.fn().mockReturnValue(queue),
    defaultJobOptions: jest.fn().mockReturnValue({}),
    _queue: queue,
  } as any;
}

function makeEvents() {
  return {
    markProcessed: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function makeDeadLetters(exhausted = false) {
  return { recordIfExhausted: jest.fn().mockResolvedValue(exhausted) } as any;
}

function makePrisma() {
  return {
    clickupTaskEvent: { upsert: jest.fn().mockResolvedValue(undefined) },
  } as any;
}

function makeParser(records: any[] = []) {
  return {
    extractFieldChanges: jest.fn().mockReturnValue(records),
    extractStatusChanges: jest.fn().mockReturnValue(records),
  } as any;
}

describe('ClickupEventProcessor — taskStatusUpdated', () => {
  it('upserts one row per status change with deterministic fingerprint', async () => {
    const prisma = makePrisma();
    const parser = makeParser([
      {
        occurredAt: new Date(1716470400000),
        changedByUserId: '12345',
        changedByUserName: 'Rashedul',
        before: { status: 'open' },
        after: { status: 'in progress' },
        raw: { id: 'hist_1' },
      },
    ]);
    const proc = new ClickupEventProcessor(makeQueues(), makeEvents(), parser, prisma, makeDeadLetters());
    await proc.process({
      data: { eventType: 'taskStatusUpdated', taskId: '86abcdef0', fingerprint: 'id:hist_1', loggedUserId: null, payload: { history_items: [{ field: 'status' }] } },
    } as any);
    expect(prisma.clickupTaskEvent.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.clickupTaskEvent.upsert.mock.calls[0][0];
    expect(call.where.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(call.create.taskId).toBe('86abcdef0');
    expect(call.create.eventType).toBe('taskStatusUpdated');
    expect(call.create.before).toEqual({ status: 'open' });
    expect(call.create.after).toEqual({ status: 'in progress' });
    expect(call.update).toEqual({});
  });

  it('survives a parser/upsert error on one item and continues with the rest', async () => {
    const prisma = makePrisma();
    prisma.clickupTaskEvent.upsert
      .mockRejectedValueOnce(new Error('one fails'))
      .mockResolvedValueOnce(undefined);
    const parser = makeParser([
      { occurredAt: new Date(1), changedByUserId: null, changedByUserName: null, before: {}, after: {}, raw: {} },
      { occurredAt: new Date(2), changedByUserId: null, changedByUserName: null, before: {}, after: {}, raw: {} },
    ]);
    const proc = new ClickupEventProcessor(makeQueues(), makeEvents(), parser, prisma, makeDeadLetters());
    await proc.process({
      data: { eventType: 'taskStatusUpdated', taskId: 't1', fingerprint: 'fp', loggedUserId: null, payload: {} },
    } as any);
    expect(prisma.clickupTaskEvent.upsert).toHaveBeenCalledTimes(2);
  });

  it('does not enqueue a task sync for taskStatusUpdated (separate concern)', async () => {
    const queues = makeQueues();
    const proc = new ClickupEventProcessor(queues, makeEvents(), makeParser([]), makePrisma(), makeDeadLetters());
    await proc.process({
      data: { eventType: 'taskStatusUpdated', taskId: 't1', fingerprint: 'fp', loggedUserId: null, payload: {} },
    } as any);
    expect(queues._queue.add).not.toHaveBeenCalled();
  });
});

describe('ClickupEventProcessor — event dispatch', () => {
  function run(data: any) {
    const queues = makeQueues();
    const events = makeEvents();
    const proc = new ClickupEventProcessor(queues, events, makeParser([]), makePrisma(), makeDeadLetters());
    return { queues, events, proc, done: proc.process({ data } as any) };
  }

  it('taskDeleted → enqueues a soft-delete job and marks processed', async () => {
    const { queues, events, done } = run({ eventType: 'taskDeleted', taskId: 't1', fingerprint: 'fp', loggedUserId: null });
    await done;
    expect(queues.get).toHaveBeenCalledWith(QUEUES.CLICKUP_TASKS);
    expect(queues._queue.add).toHaveBeenCalledWith(JOBS.DELETE_CLICKUP_TASK, { taskId: 't1' }, {});
    expect(events.markProcessed).toHaveBeenCalledWith('fp');
  });

  it('taskTimeTrackedUpdated → enqueues BOTH a task sync and a time-entry sync carrying the logger as assignee', async () => {
    const { queues, done } = run({ eventType: 'taskTimeTrackedUpdated', taskId: 't9', fingerprint: 'fp', loggedUserId: '4242' });
    await done;
    const calls = queues._queue.add.mock.calls;
    expect(calls).toContainEqual([JOBS.SYNC_CLICKUP_TASK, { taskId: 't9' }, {}]);
    expect(calls).toContainEqual([JOBS.SYNC_TASK_TIME_ENTRIES, { taskId: 't9', assigneeIds: ['4242'] }, {}]);
  });

  it('taskTimeTrackedUpdated with no logger → assigneeIds undefined (falls back to all members downstream)', async () => {
    const { queues, done } = run({ eventType: 'taskTimeTrackedUpdated', taskId: 't9', fingerprint: 'fp', loggedUserId: null });
    await done;
    expect(queues._queue.add).toHaveBeenCalledWith(JOBS.SYNC_TASK_TIME_ENTRIES, { taskId: 't9', assigneeIds: undefined }, {});
  });

  for (const eventType of ['taskCommentPosted', 'taskCommentUpdated']) {
    it(`${eventType} → enqueues SYNC_TASK_COMMENTS on the comments queue ONLY (no task re-sync) and marks processed`, async () => {
      const { queues, events, done } = run({ eventType, taskId: 'tc1', fingerprint: 'fp', loggedUserId: null });
      await done;
      expect(queues.get).toHaveBeenCalledWith(QUEUES.CLICKUP_COMMENTS);
      expect(queues._queue.add).toHaveBeenCalledTimes(1);
      expect(queues._queue.add).toHaveBeenCalledWith(JOBS.SYNC_TASK_COMMENTS, { taskId: 'tc1' }, {});
      expect(events.markProcessed).toHaveBeenCalledWith('fp');
    });
  }

  it('unknown event with a taskId → default task sync', async () => {
    const { queues, events, done } = run({ eventType: 'taskUpdated', taskId: 't5', fingerprint: 'fp', loggedUserId: null });
    await done;
    expect(queues._queue.add).toHaveBeenCalledWith(JOBS.SYNC_CLICKUP_TASK, { taskId: 't5' }, {});
    expect(events.markProcessed).toHaveBeenCalledWith('fp');
  });

  it('event with no taskId → no enqueue, but IS marked processed (so it cannot sit in `received` limbo)', async () => {
    const { queues, events, done } = run({ eventType: 'taskUpdated', taskId: null, fingerprint: 'fp', loggedUserId: null });
    await done;
    expect(queues._queue.add).not.toHaveBeenCalled();
    expect(events.markProcessed).toHaveBeenCalledWith('fp');
  });

  it('taskDeleted with no taskId → does NOT enqueue a null-id delete (which would dead-letter), marks processed', async () => {
    const { queues, events, done } = run({ eventType: 'taskDeleted', taskId: null, fingerprint: 'fp', loggedUserId: null });
    await done;
    expect(queues._queue.add).not.toHaveBeenCalled();
    expect(events.markProcessed).toHaveBeenCalledWith('fp');
  });
});

describe('ClickupEventProcessor — moved/assignee/priority capture history AND re-sync', () => {
  const oneRecord = [
    {
      field: 'priority',
      occurredAt: new Date(1716470500000),
      changedByUserId: '7',
      changedByUserName: 'Sam',
      before: null,
      after: { priority: 'high' },
      raw: { id: 'h_p' },
    },
  ];

  for (const eventType of ['taskMoved', 'taskAssigneeUpdated', 'taskPriorityUpdated']) {
    it(`${eventType} → persists a clickup_task_events row AND enqueues a task sync`, async () => {
      const prisma = makePrisma();
      const queues = makeQueues();
      const proc = new ClickupEventProcessor(queues, makeEvents(), makeParser(oneRecord), prisma, makeDeadLetters());
      await proc.process({
        data: { eventType, taskId: 't1', fingerprint: 'fp', loggedUserId: null, payload: {} },
      } as any);
      // history persisted
      expect(prisma.clickupTaskEvent.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.clickupTaskEvent.upsert.mock.calls[0][0].create.eventType).toBe(eventType);
      // task still re-synced
      expect(queues._queue.add).toHaveBeenCalledWith(JOBS.SYNC_CLICKUP_TASK, { taskId: 't1' }, {});
    });
  }

  it('taskAssigneeUpdated with add+rem at the same date → two distinct rows (field omitted from fp, before/after disambiguate)', async () => {
    const prisma = makePrisma();
    const sameDate = new Date(1716470500000);
    const proc = new ClickupEventProcessor(
      makeQueues(),
      makeEvents(),
      makeParser([
        { field: 'assignee_rem', occurredAt: sameDate, changedByUserId: '1', changedByUserName: null, before: { id: 9 }, after: null, raw: {} },
        { field: 'assignee_add', occurredAt: sameDate, changedByUserId: '1', changedByUserName: null, before: null, after: { id: 5 }, raw: {} },
      ]),
      prisma,
      makeDeadLetters(),
    );
    await proc.process({
      data: { eventType: 'taskAssigneeUpdated', taskId: 't1', fingerprint: 'fp', loggedUserId: null, payload: {} },
    } as any);
    expect(prisma.clickupTaskEvent.upsert).toHaveBeenCalledTimes(2);
    const fp0 = prisma.clickupTaskEvent.upsert.mock.calls[0][0].where.fingerprint;
    const fp1 = prisma.clickupTaskEvent.upsert.mock.calls[1][0].where.fingerprint;
    expect(fp0).not.toBe(fp1);
  });
});

describe('ClickupEventProcessor — failure handling', () => {
  it('marks the webhook event failed once retries are exhausted', async () => {
    const events = makeEvents();
    const deadLetters = makeDeadLetters(true); // exhausted
    const proc = new ClickupEventProcessor(makeQueues(), events, makeParser([]), makePrisma(), deadLetters);

    await proc.onFailed(
      { data: { fingerprint: 'fp-1' } } as any,
      new Error('downstream boom'),
    );

    expect(deadLetters.recordIfExhausted).toHaveBeenCalled();
    expect(events.markFailed).toHaveBeenCalledWith('fp-1', 'downstream boom');
  });

  it('does NOT mark failed while retries remain', async () => {
    const events = makeEvents();
    const deadLetters = makeDeadLetters(false); // still retrying
    const proc = new ClickupEventProcessor(makeQueues(), events, makeParser([]), makePrisma(), deadLetters);

    await proc.onFailed({ data: { fingerprint: 'fp-1' } } as any, new Error('transient'));

    expect(events.markFailed).not.toHaveBeenCalled();
  });
});
