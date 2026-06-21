import { ReportsService } from '../src/reports/reports.service';

describe('ReportsService', () => {
  function makePrisma(overrides: Partial<Record<string, any>> = {}) {
    const base = {
      clickupTask: {
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      clickupTimeEntry: {
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      syncCheckpoint: { findMany: jest.fn().mockResolvedValue([]) },
      clickupWebhookEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      syncJobLog: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      deadLetterJob: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn().mockImplementation((arr: Promise<unknown>[]) => Promise.all(arr)),
      $queryRaw: jest.fn().mockResolvedValue([]),
      spikeNotification: { findMany: jest.fn().mockResolvedValue([]) },
      spikeResolution: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return { ...base, ...overrides } as any;
  }

  // Minimal WorkspaceService stub. resolveWorkspaceId echoes the id (defaulting
  // to 'ws1'); getSpaces returns the three default spaces in production shape so
  // syncHealth can resolve scopeId -> space name.
  function makeWorkspaces() {
    return {
      resolveWorkspaceId: (id?: string) => id ?? 'ws1',
      getTeamId: () => '123',
      getSpikeHoursCap: () => 12,
      hasWorkspace: () => true,
      listActiveWorkspaceIds: () => ['ws1'],
      getSpaces: () => [
        { spaceId: '3577824', name: 'Digital Marketing', backfillLookbackDays: 30, enabled: true },
        { spaceId: '3589129', name: 'R&D Apps', backfillLookbackDays: 30, enabled: true },
        { spaceId: '3525433', name: 'Projects', backfillLookbackDays: 30, enabled: true },
      ],
    } as any;
  }

  function makeService(prisma: any) {
    return new ReportsService(prisma, makeWorkspaces());
  }

  describe('tasksSummary', () => {
    it('returns bySpace (collapsed by space_id via raw SQL), byStatus, byStatusType and total', async () => {
      const prisma = makePrisma();
      // bySpace now comes from $queryRaw so old tasks with NULL space_name
      // don't split into a second row; MAX(space_name) resolves the name.
      prisma.$queryRaw.mockResolvedValueOnce([
        { space_id: '3577824', space_name: 'Digital Marketing', count: BigInt(5) },
      ]);
      prisma.clickupTask.groupBy
        .mockResolvedValueOnce([{ status: 'in progress', _count: { taskId: 3 } }])
        .mockResolvedValueOnce([{ statusType: 'open', _count: { taskId: 4 } }]);
      prisma.clickupTask.count.mockResolvedValue(10);
      const result = await makeService(prisma).tasksSummary('ws1');
      expect(result.total).toBe(10);
      expect(result.bySpace[0]).toEqual({ spaceId: '3577824', spaceName: 'Digital Marketing', count: 5 });
      expect(result.byStatus[0]).toEqual({ status: 'in progress', count: 3 });
      expect(result.byStatusType[0]).toEqual({ statusType: 'open', count: 4 });
    });
  });

  describe('tasksBySpaceStatus', () => {
    it('maps groupBy rows to spaceName, status, count', async () => {
      const prisma = makePrisma();
      prisma.clickupTask.groupBy.mockResolvedValue([
        { spaceName: 'Projects', status: 'complete', _count: { taskId: 12 } },
      ]);
      const result = await makeService(prisma).tasksBySpaceStatus('ws1');
      expect(result[0]).toEqual({ spaceName: 'Projects', status: 'complete', count: 12 });
    });
  });

  describe('tasksClients', () => {
    it('maps distinct client rows to { client, taskCount }', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([
        { client: 'Acme Corp', task_count: BigInt(12) },
        { client: 'Globex', task_count: BigInt(3) },
      ]);
      const result = await makeService(prisma).tasksClients('ws1');
      expect(result).toEqual([
        { client: 'Acme Corp', taskCount: 12 },
        { client: 'Globex', taskCount: 3 },
      ]);
    });

    it('excludes soft-deleted tasks and empty clients in the SQL', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      await makeService(prisma).tasksClients('ws1');
      const call = prisma.$queryRaw.mock.calls[0][0];
      const sqlText: string = call.sql ?? call.text ?? String(call);
      expect(sqlText).toMatch(/is_deleted\s*=\s*false/);
      expect(sqlText).toMatch(/client\s*<>\s*''/);
    });
  });

  describe('tasksLists', () => {
    it('maps distinct list rows to { listId, listName, spaceName, taskCount }', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([
        { list_id: 'L1', list_name: 'Backlog', space_name: 'Projects', task_count: BigInt(7) },
        { list_id: 'L2', list_name: 'Sprint 12', space_name: 'R&D Apps', task_count: BigInt(3) },
      ]);
      const result = await makeService(prisma).tasksLists('ws1');
      expect(result).toEqual([
        { listId: 'L1', listName: 'Backlog', spaceName: 'Projects', taskCount: 7 },
        { listId: 'L2', listName: 'Sprint 12', spaceName: 'R&D Apps', taskCount: 3 },
      ]);
    });

    it('scopes by space_id when spaceId is given', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      await makeService(prisma).tasksLists('ws1', '3577824');
      const call = prisma.$queryRaw.mock.calls[0][0];
      const sqlText: string = call.sql ?? call.text ?? String(call);
      expect(sqlText).toMatch(/space_id\s*=/);
    });

    it('excludes soft-deleted tasks and empty lists in the SQL', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      await makeService(prisma).tasksLists('ws1');
      const call = prisma.$queryRaw.mock.calls[0][0];
      const sqlText: string = call.sql ?? call.text ?? String(call);
      expect(sqlText).toMatch(/is_deleted\s*=\s*false/);
      expect(sqlText).toMatch(/list_name\s*<>\s*''/);
    });
  });

  describe('tasksFolders', () => {
    it('maps distinct folder rows to { folderId, folderName, spaceName, taskCount }', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([
        { folder_id: 'F1', folder_name: 'Q3 Campaigns', space_name: 'Digital Marketing', task_count: BigInt(9) },
        { folder_id: 'F2', folder_name: 'Internal', space_name: 'R&D Apps', task_count: BigInt(4) },
      ]);
      const result = await makeService(prisma).tasksFolders('ws1');
      expect(result).toEqual([
        { folderId: 'F1', folderName: 'Q3 Campaigns', spaceName: 'Digital Marketing', taskCount: 9 },
        { folderId: 'F2', folderName: 'Internal', spaceName: 'R&D Apps', taskCount: 4 },
      ]);
    });

    it('scopes by space_id when spaceId is given', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      await makeService(prisma).tasksFolders('ws1', '3577824');
      const call = prisma.$queryRaw.mock.calls[0][0];
      const sqlText: string = call.sql ?? call.text ?? String(call);
      expect(sqlText).toMatch(/space_id\s*=/);
    });

    it('excludes soft-deleted tasks, null folders, and empty folder names in the SQL', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      await makeService(prisma).tasksFolders('ws1');
      const call = prisma.$queryRaw.mock.calls[0][0];
      const sqlText: string = call.sql ?? call.text ?? String(call);
      expect(sqlText).toMatch(/is_deleted\s*=\s*false/);
      expect(sqlText).toMatch(/folder_id\s+IS\s+NOT\s+NULL/i);
      expect(sqlText).toMatch(/folder_name\s*<>\s*''/);
    });
  });

  describe('tasks (client filter)', () => {
    it('adds an exact client equality to the where clause when client is given', async () => {
      const prisma = makePrisma();
      await makeService(prisma).tasks('ws1', 
        undefined, undefined, undefined, undefined, undefined, 50, 0,
        undefined, undefined, undefined, undefined, 'Acme Corp',
      );
      const arg = prisma.clickupTask.findMany.mock.calls[0][0];
      expect(arg.where.client).toBe('Acme Corp');
    });

    it('omits the client clause when client is undefined', async () => {
      const prisma = makePrisma();
      await makeService(prisma).tasks('ws1');
      const arg = prisma.clickupTask.findMany.mock.calls[0][0];
      expect(arg.where.client).toBeUndefined();
    });
  });

  describe('tasks (list filter)', () => {
    it('adds an exact listId equality to the where clause when listId is given', async () => {
      const prisma = makePrisma();
      await makeService(prisma).tasks('ws1', 
        undefined, undefined, undefined, undefined, undefined, 50, 0,
        undefined, undefined, undefined, undefined, undefined, undefined, 'L1',
      );
      const arg = prisma.clickupTask.findMany.mock.calls[0][0];
      expect(arg.where.listId).toBe('L1');
    });

    it('omits the listId clause when listId is undefined', async () => {
      const prisma = makePrisma();
      await makeService(prisma).tasks('ws1');
      const arg = prisma.clickupTask.findMany.mock.calls[0][0];
      expect(arg.where.listId).toBeUndefined();
    });
  });

  describe('tasks (folder filter)', () => {
    it('adds an exact folderId equality to the where clause when folderId is given', async () => {
      const prisma = makePrisma();
      await makeService(prisma).tasks('ws1', 
        undefined, undefined, undefined, undefined, undefined, 50, 0,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'F1',
      );
      const arg = prisma.clickupTask.findMany.mock.calls[0][0];
      expect(arg.where.folderId).toBe('F1');
    });

    it('omits the folderId clause when folderId is undefined', async () => {
      const prisma = makePrisma();
      await makeService(prisma).tasks('ws1');
      const arg = prisma.clickupTask.findMany.mock.calls[0][0];
      expect(arg.where.folderId).toBeUndefined();
    });
  });

  describe('tasks (taskIds filter)', () => {
    it('parses comma-separated taskIds into where.taskId.in', async () => {
      const prisma = makePrisma();
      await makeService(prisma).tasks('ws1', 
        undefined, undefined, undefined, undefined, undefined, 50, 0,
        undefined, undefined, undefined, undefined, undefined, 't1,t2 , ,t3',
      );
      const arg = prisma.clickupTask.findMany.mock.calls[0][0];
      expect(arg.where.taskId).toEqual({ in: ['t1', 't2', 't3'] });
    });

    it('omits the taskId clause when taskIds resolves to an empty list', async () => {
      const prisma = makePrisma();
      await makeService(prisma).tasks('ws1', 
        undefined, undefined, undefined, undefined, undefined, 50, 0,
        undefined, undefined, undefined, undefined, undefined, ' , , ',
      );
      const arg = prisma.clickupTask.findMany.mock.calls[0][0];
      expect(arg.where.taskId).toBeUndefined();
    });
  });

  describe('timeEntriesByUser', () => {
    it('converts durationHours.toNumber() and costCents BigInt to totalCostAud', async () => {
      const prisma = makePrisma();
      prisma.clickupTimeEntry.groupBy.mockResolvedValue([{
        userId: 'u1', userName: 'Alice', userEmail: 'alice@x.com',
        _sum: { durationHours: { toNumber: () => 8 }, costCents: BigInt(120000) },
      }]);
      const result = await makeService(prisma).timeEntriesByUser('ws1');
      expect(result[0].totalHours).toBe(8);
      expect(result[0].totalCostAud).toBe(1200);
    });

    it('handles null sums gracefully', async () => {
      const prisma = makePrisma();
      prisma.clickupTimeEntry.groupBy.mockResolvedValue([{
        userId: 'u2', userName: null, userEmail: null,
        _sum: { durationHours: null, costCents: null },
      }]);
      const result = await makeService(prisma).timeEntriesByUser('ws1');
      expect(result[0].totalHours).toBe(0);
      expect(result[0].totalCostAud).toBe(0);
    });
  });

  describe('timeEntriesBillableSummary', () => {
    it('separates billable and non-billable rows', async () => {
      const prisma = makePrisma();
      prisma.clickupTimeEntry.groupBy.mockResolvedValue([
        { billable: true, _sum: { durationHours: { toNumber: () => 10 }, costCents: BigInt(150000) } },
        { billable: false, _sum: { durationHours: { toNumber: () => 5 }, costCents: BigInt(0) } },
      ]);
      const result = await makeService(prisma).timeEntriesBillableSummary('ws1');
      expect(result.billableHours).toBe(10);
      expect(result.billableCostAud).toBe(1500);
      expect(result.nonBillableHours).toBe(5);
      expect(result.nonBillableCostAud).toBe(0);
    });

    it('returns zeros when no entries exist', async () => {
      const prisma = makePrisma();
      prisma.clickupTimeEntry.groupBy.mockResolvedValue([]);
      const result = await makeService(prisma).timeEntriesBillableSummary('ws1');
      expect(result).toEqual({ billableHours: 0, nonBillableHours: 0, billableCostAud: 0, nonBillableCostAud: 0 });
    });
  });

  describe('timeEntriesByClient', () => {
    it('maps raw SQL result to client, totalHours, totalCostAud', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([{ client: 'Acme Corp', total_hours: 5.5, total_cost_cents: 82500 }]);
      const result = await makeService(prisma).timeEntriesByClient('ws1');
      expect(result[0]).toEqual({ client: 'Acme Corp', totalHours: 5.5, totalCostAud: 825 });
    });

    it('excludes soft-deleted tasks from the SQL', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      await makeService(prisma).timeEntriesByClient('ws1');
      const call = prisma.$queryRaw.mock.calls[0][0];
      const sqlText: string = call.sql ?? call.text ?? String(call);
      expect(sqlText).toMatch(/t\.is_deleted\s*=\s*false/);
    });
  });

  describe('timeEntriesByDepartment', () => {
    it('maps raw SQL result to department, totalHours, totalCostAud', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([{ department: 'Engineering', total_hours: 20, total_cost_cents: 300000 }]);
      const result = await makeService(prisma).timeEntriesByDepartment('ws1');
      expect(result[0]).toEqual({ department: 'Engineering', totalHours: 20, totalCostAud: 3000 });
    });
  });

  describe('sprintPoints', () => {
    it('maps groupBy to spaceName, status, totalPoints', async () => {
      const prisma = makePrisma();
      prisma.clickupTask.groupBy.mockResolvedValue([
        { spaceName: 'R&D Apps', status: 'complete', _sum: { sprintPoints: 21 } },
      ]);
      const result = await makeService(prisma).sprintPoints('ws1');
      expect(result[0]).toEqual({ spaceName: 'R&D Apps', status: 'complete', totalPoints: 21 });
    });

    it('defaults totalPoints to 0 when sum is null', async () => {
      const prisma = makePrisma();
      prisma.clickupTask.groupBy.mockResolvedValue([{ spaceName: 'X', status: 'open', _sum: { sprintPoints: null } }]);
      const result = await makeService(prisma).sprintPoints('ws1');
      expect(result[0].totalPoints).toBe(0);
    });
  });

  describe('syncHealth', () => {
    it('marks Stale when lastSuccessfulSyncAt is older than 12h', async () => {
      const prisma = makePrisma();
      prisma.syncCheckpoint.findMany.mockResolvedValue([
        { scopeId: '3577824', lastSuccessfulSyncAt: new Date(Date.now() - 13 * 60 * 60_000) },
      ]);
      const result = await makeService(prisma).syncHealth('ws1');
      expect(result[0].spaceName).toBe('Digital Marketing');
      expect(result[0].status).toBe('Stale');
    });

    it('marks Fresh when lastSuccessfulSyncAt is within 12h (90 min, previously Stale)', async () => {
      const prisma = makePrisma();
      prisma.syncCheckpoint.findMany.mockResolvedValue([
        { scopeId: '3589129', lastSuccessfulSyncAt: new Date(Date.now() - 90 * 60_000) },
      ]);
      const result = await makeService(prisma).syncHealth('ws1');
      expect(result[0].spaceName).toBe('R&D Apps');
      expect(result[0].status).toBe('Fresh');
    });

    it('marks Unknown when lastSuccessfulSyncAt is null', async () => {
      const prisma = makePrisma();
      prisma.syncCheckpoint.findMany.mockResolvedValue([
        { scopeId: '3525433', lastSuccessfulSyncAt: null },
      ]);
      const result = await makeService(prisma).syncHealth('ws1');
      expect(result[0].spaceName).toBe('Projects');
      expect(result[0].status).toBe('Unknown');
      expect(result[0].ageMinutes).toBeNull();
    });

    it('uses scopeId as spaceName when not in CLICKUP_SPACES', async () => {
      const prisma = makePrisma();
      prisma.syncCheckpoint.findMany.mockResolvedValue([
        { scopeId: 'unknown-space', lastSuccessfulSyncAt: null },
      ]);
      const result = await makeService(prisma).syncHealth('ws1');
      expect(result[0].spaceName).toBe('unknown-space');
    });
  });

  describe('webhookEvents', () => {
    it('serializes BigInt id to string and respects limit cap', async () => {
      const prisma = makePrisma();
      prisma.clickupWebhookEvent.findMany.mockResolvedValue([{ id: BigInt(42), eventType: 'taskCreated', taskId: 'abc', status: 'received', receivedAt: new Date(), processedAt: null }]);
      prisma.clickupWebhookEvent.count.mockResolvedValue(1);
      const result = await makeService(prisma).webhookEvents('ws1', 999);
      expect(result.items[0].id).toBe('42');
      expect(result.total).toBe(1);
    });

    it('builds a filtered where clause and returns distinct event types', async () => {
      const prisma = makePrisma();
      // First findMany = page items; second findMany = distinct event types.
      prisma.clickupWebhookEvent.findMany
        .mockResolvedValueOnce([{ id: BigInt(7), eventType: 'taskUpdated', taskId: 't1', status: 'failed', receivedAt: new Date(), processedAt: null }])
        .mockResolvedValueOnce([{ eventType: 'taskCreated' }, { eventType: 'taskUpdated' }]);
      prisma.clickupWebhookEvent.count.mockResolvedValue(1);

      const result = await makeService(prisma).webhookEvents('ws1', 50, 0, 'failed', 'taskUpdated', '123');

      // The page query (first findMany call) gets the composed where clause.
      const pageWhere = prisma.clickupWebhookEvent.findMany.mock.calls[0][0].where;
      expect(pageWhere.status).toBe('failed');
      expect(pageWhere.eventType).toBe('taskUpdated');
      // All-digit search also matches the numeric primary key exactly.
      expect(pageWhere.OR).toEqual(
        expect.arrayContaining([
          { taskId: { contains: '123', mode: 'insensitive' } },
          { eventType: { contains: '123', mode: 'insensitive' } },
          { id: BigInt(123) },
        ]),
      );
      // count() is scoped to the same filter.
      expect(prisma.clickupWebhookEvent.count).toHaveBeenCalledWith({ where: pageWhere });
      // Distinct list is surfaced for the filter dropdown.
      expect(result.eventTypes).toEqual(['taskCreated', 'taskUpdated']);
    });

    it('omits the id OR-term when the search is not all digits', async () => {
      const prisma = makePrisma();
      prisma.clickupWebhookEvent.findMany.mockResolvedValue([]);
      prisma.clickupWebhookEvent.count.mockResolvedValue(0);

      await makeService(prisma).webhookEvents('ws1', 50, 0, undefined, undefined, 'task');

      const pageWhere = prisma.clickupWebhookEvent.findMany.mock.calls[0][0].where;
      expect(pageWhere.OR).toEqual([
        { taskId: { contains: 'task', mode: 'insensitive' } },
        { eventType: { contains: 'task', mode: 'insensitive' } },
      ]);
      expect(pageWhere.status).toBeUndefined();
    });
  });

  describe('jobLogs', () => {
    it('serializes BigInt id to string and exposes the recovered flag from raw SQL', async () => {
      const prisma = makePrisma();
      // jobLogs now uses $queryRaw twice: once for items (with `recovered` per
      // row), once for total. Stub both in order.
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: BigInt(7),
            queue_name: 'clickup-tasks',
            job_name: 'sync',
            status: 'failed',
            entity_id: 'e1',
            error_message: 'boom',
            started_at: new Date(1700000000000),
            finished_at: new Date(1700000005000),
            tasks_synced: null,
            time_entries_synced: null,
            recovered: true,
          },
        ])
        .mockResolvedValueOnce([{ count: BigInt(1) }]);
      const result = await makeService(prisma).jobLogs('ws1');
      expect(result.items[0].id).toBe('7');
      expect(result.items[0].status).toBe('failed');
      expect(result.items[0].recovered).toBe(true);
      expect(result.items[0].durationMs).toBe(5000);
      expect(result.total).toBe(1);
    });
  });

  describe('deadLetters', () => {
    it('serializes BigInt id to string', async () => {
      const prisma = makePrisma();
      prisma.deadLetterJob.findMany.mockResolvedValue([{ id: BigInt(3), queueName: 'clickup-tasks', jobName: 'sync', entityId: null, errorMessage: 'boom', failedAt: new Date() }]);
      prisma.deadLetterJob.count.mockResolvedValue(1);
      const result = await makeService(prisma).deadLetters('ws1');
      expect(result.items[0].id).toBe('3');
    });
  });

  describe('stats', () => {
    it('returns all four dashboard stats', async () => {
      const prisma = makePrisma();
      prisma.syncJobLog.count.mockResolvedValue(3);
      prisma.deadLetterJob.count.mockResolvedValue(2);
      prisma.clickupWebhookEvent.count.mockResolvedValue(150);
      prisma.clickupTimeEntry.count.mockResolvedValue(7);
      const result = await makeService(prisma).stats('ws1');
      expect(result).toEqual({ failedJobsLast24h: 3, deadLetterPending: 2, webhooksLast24h: 150, missingRateEntries: 7, lastWebhookEventAt: null });
    });
  });

  describe('missingRates', () => {
    it('queries NO_RATE_FOUND entries grouped by user and maps fields', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([
        {
          user_id: 'u1',
          user_name: 'Alice',
          user_email: 'a@x.com',
          missing_count: BigInt(3),
          affected_hours: 5.5,
          first_date: new Date('2025-01-01'),
          latest_date: new Date('2025-01-15'),
          affected_task_count: BigInt(2),
          affected_tasks: [
            { taskId: 't1', taskName: 'Task one' },
            { taskId: 't2', taskName: 'Task two' },
          ],
        },
      ]);
      const result = await makeService(prisma).missingRates('ws1');
      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe('u1');
      expect(result[0].missingCount).toBe(3);
      expect(result[0].affectedHours).toBe(5.5);
      expect(result[0].affectedTaskCount).toBe(2);
      expect(result[0].affectedTasks).toEqual([
        { taskId: 't1', taskName: 'Task one' },
        { taskId: 't2', taskName: 'Task two' },
      ]);
    });

    it('defaults affectedTasks to empty array when DB returns null', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([
        {
          user_id: 'u2',
          user_name: 'Bob',
          user_email: 'b@x.com',
          missing_count: BigInt(1),
          affected_hours: 0.5,
          first_date: new Date('2025-02-01'),
          latest_date: new Date('2025-02-01'),
          affected_task_count: BigInt(0),
          affected_tasks: null,
        },
      ]);
      const result = await makeService(prisma).missingRates('ws1');
      expect(result[0].affectedTasks).toEqual([]);
      expect(result[0].affectedTaskCount).toBe(0);
    });

    it('returns empty array when no missing-rate entries exist', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      const result = await makeService(prisma).missingRates('ws1');
      expect(result).toEqual([]);
    });
  });

  describe('spaces', () => {
    it('returns per-space aggregated stats', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([
        { space_id: '3577824', space_name: 'Digital Marketing', task_count: BigInt(10), open_count: BigInt(5), hours_logged: 20.5, cost_cents: 5000 },
      ]);
      const result = await makeService(prisma).spaces('ws1');
      expect(result).toHaveLength(1);
      expect(result[0].spaceId).toBe('3577824');
      expect(result[0].spaceName).toBe('Digital Marketing');
      expect(result[0].taskCount).toBe(10);
      expect(result[0].openCount).toBe(5);
      expect(result[0].hoursLogged).toBe(20.5);
      expect(result[0].costAud).toBe(50);
    });

    it('returns empty array when no spaces exist', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      const result = await makeService(prisma).spaces('ws1');
      expect(result).toEqual([]);
    });
  });

  describe('overviewDeltas', () => {
    it('returns current + prior totals mapped to dollars', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw
        .mockResolvedValueOnce([{ total_hours: 124.5, total_cost_cents: BigInt(1843250) }])
        .mockResolvedValueOnce([{ total_hours: 105.0, total_cost_cents: BigInt(1560000) }]);
      const result = await makeService(prisma).overviewDeltas('ws1', 
        '2026-05-01T00:00:00.000Z',
        '2026-05-31T23:59:59.999Z',
      );
      expect(result).toEqual({
        current: { totalHours: 124.5, totalCostAud: 18432.5 },
        prior:   { totalHours: 105,   totalCostAud: 15600 },
      });
    });

    it('computes the prior window as [from - (to - from), from)', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([{ total_hours: 0, total_cost_cents: BigInt(0) }]);
      await makeService(prisma).overviewDeltas('ws1', 
        '2026-05-15T00:00:00.000Z',
        '2026-05-20T00:00:00.000Z',
      );
      const priorCall = prisma.$queryRaw.mock.calls[1][0];
      const sqlText: string = priorCall.sql ?? priorCall.text ?? String(priorCall);
      expect(sqlText).toMatch(/SUM\(e\.cost_cents\)/);
      const values: unknown[] = priorCall.values ?? [];
      const isoStrings = values
        .map(v => (v instanceof Date ? v.toISOString() : String(v)))
        .join(' ');
      expect(isoStrings).toMatch(/2026-05-10T00:00:00\.000Z/);
      expect(isoStrings).toMatch(/2026-05-15T00:00:00\.000Z/);
    });

    it('excludes soft-deleted tasks in both windows', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([{ total_hours: 0, total_cost_cents: BigInt(0) }]);
      await makeService(prisma).overviewDeltas('ws1');
      const call0: string = prisma.$queryRaw.mock.calls[0][0].sql ?? String(prisma.$queryRaw.mock.calls[0][0]);
      const call1: string = prisma.$queryRaw.mock.calls[1][0].sql ?? String(prisma.$queryRaw.mock.calls[1][0]);
      expect(call0).toMatch(/t\.is_deleted\s*=\s*false/);
      expect(call1).toMatch(/t\.is_deleted\s*=\s*false/);
    });

    it('handles null sums (no rows in window)', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([{ total_hours: null, total_cost_cents: null }]);
      const result = await makeService(prisma).overviewDeltas('ws1');
      expect(result.current).toEqual({ totalHours: 0, totalCostAud: 0 });
      expect(result.prior).toEqual({ totalHours: 0, totalCostAud: 0 });
    });
  });

  describe('costTrend', () => {
    it('maps raw rows to { bucket, totalCostAud, totalHours, entryCount } and sorts ascending', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([
        { bucket: '2026-05-18', total_cost_cents: BigInt(120000), total_hours: 8,   entry_count: 4 },
        { bucket: '2026-05-19', total_cost_cents: BigInt(0),      total_hours: 0,   entry_count: 0 },
        { bucket: '2026-05-20', total_cost_cents: BigInt(45000),  total_hours: 3.5, entry_count: 2 },
      ]);
      const result = await makeService(prisma).costTrend('ws1', 'day');
      expect(result).toEqual([
        { bucket: '2026-05-18', totalCostAud: 1200, totalHours: 8,   entryCount: 4 },
        { bucket: '2026-05-19', totalCostAud: 0,    totalHours: 0,   entryCount: 0 },
        { bucket: '2026-05-20', totalCostAud: 450,  totalHours: 3.5, entryCount: 2 },
      ]);
    });

    it('throws on invalid bucket value', async () => {
      const prisma = makePrisma();
      await expect(makeService(prisma).costTrend('ws1', 'hour' as any))
        .rejects.toThrow(/bucket/i);
    });

    it("emits SQL containing date_trunc('day', ...) at Asia/Dhaka for bucket=day", async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      await makeService(prisma).costTrend('ws1', 'day');
      const call = prisma.$queryRaw.mock.calls[0][0];
      const sqlText: string = call.sql ?? call.text ?? String(call);
      expect(sqlText).toMatch(/date_trunc\('day'/);
      expect(sqlText).toMatch(/Asia\/Dhaka/);
      expect(sqlText).not.toMatch(/Australia\/Sydney/);
    });

    it('emits the Sunday-shift week expression for bucket=week', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      await makeService(prisma).costTrend('ws1', 'week');
      const call = prisma.$queryRaw.mock.calls[0][0];
      const sqlText: string = call.sql ?? call.text ?? String(call);
      // The Sunday-start trick: shift +1 day, truncate to ISO week (Monday),
      // shift back -1 day. We assert both halves of the shift are present.
      expect(sqlText).toMatch(/date_trunc\('week'/);
      expect(sqlText).toMatch(/\+ interval '1 day'/);
      expect(sqlText).toMatch(/- interval '1 day'/);
    });

    it("emits date_trunc('month', ...) for bucket=month", async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      await makeService(prisma).costTrend('ws1', 'month');
      const call = prisma.$queryRaw.mock.calls[0][0];
      const sqlText: string = call.sql ?? call.text ?? String(call);
      expect(sqlText).toMatch(/date_trunc\('month'/);
    });

    it('uses generate_series so empty buckets are returned with zeros', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      await makeService(prisma).costTrend('ws1', 'day');
      const call = prisma.$queryRaw.mock.calls[0][0];
      const sqlText: string = call.sql ?? call.text ?? String(call);
      expect(sqlText).toMatch(/generate_series/);
      expect(sqlText).toMatch(/LEFT JOIN/i);
    });

    it('filters out soft-deleted tasks', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      await makeService(prisma).costTrend('ws1', 'day');
      const call = prisma.$queryRaw.mock.calls[0][0];
      const sqlText: string = call.sql ?? call.text ?? String(call);
      expect(sqlText).toMatch(/t\.is_deleted\s*=\s*false/);
    });
  });

  describe('costTrendByAssignee', () => {
    // The method issues two $queryRaw calls in order: (1) the bucket axis via
    // generate_series, (2) the per-(bucket, assignee) cost aggregate.
    function mockTwoQueries(prisma: any, buckets: any[], agg: any[]) {
      prisma.$queryRaw
        .mockResolvedValueOnce(buckets)
        .mockResolvedValueOnce(agg);
    }

    it('builds a continuous bucket axis with per-assignee dollar values', async () => {
      const prisma = makePrisma();
      mockTwoQueries(
        prisma,
        [{ bucket: '2026-05-18' }, { bucket: '2026-05-19' }, { bucket: '2026-05-20' }],
        [
          { bucket: '2026-05-18', segment: 'Alice', cost_cents: BigInt(120000) },
          { bucket: '2026-05-18', segment: 'Bob',   cost_cents: BigInt(40000) },
          { bucket: '2026-05-20', segment: 'Alice', cost_cents: BigInt(60000) },
        ],
      );
      const result = await makeService(prisma).costTrendByAssignee('ws1', 'day');
      expect(result.buckets).toEqual(['2026-05-18', '2026-05-19', '2026-05-20']);
      // Alice (1800 total) ranks above Bob (400).
      expect(result.assignees).toEqual(['Alice', 'Bob']);
      expect(result.points).toEqual([
        { bucket: '2026-05-18', values: { Alice: 1200, Bob: 400 } },
        { bucket: '2026-05-19', values: { Alice: 0,    Bob: 0 } },
        { bucket: '2026-05-20', values: { Alice: 600,  Bob: 0 } },
      ]);
    });

    it('returns every assignee (no "Other") by default, ordered by total cost', async () => {
      const prisma = makePrisma();
      // 10 assignees — more than the old default cap of 8 — none should collapse.
      const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
      mockTwoQueries(
        prisma,
        [{ bucket: '2026-05-18' }],
        names.map((n, idx) => ({
          bucket: '2026-05-18',
          segment: n,
          // Descending cost so the expected order is the input order.
          cost_cents: BigInt((names.length - idx) * 10000),
        })),
      );
      const result = await makeService(prisma).costTrendByAssignee('ws1', 'day');
      expect(result.assignees).toEqual(names);
      expect(result.assignees).not.toContain('Other');
    });

    it('collapses assignees beyond topN into an "Other" segment', async () => {
      const prisma = makePrisma();
      mockTwoQueries(
        prisma,
        [{ bucket: '2026-05-18' }],
        [
          { bucket: '2026-05-18', segment: 'A', cost_cents: BigInt(50000) },
          { bucket: '2026-05-18', segment: 'B', cost_cents: BigInt(40000) },
          { bucket: '2026-05-18', segment: 'C', cost_cents: BigInt(30000) },
        ],
      );
      const result = await makeService(prisma).costTrendByAssignee('ws1', 'day', undefined, undefined, 2);
      expect(result.assignees).toEqual(['A', 'B', 'Other']);
      expect(result.points[0].values).toEqual({ A: 500, B: 400, Other: 300 });
    });

    it('throws on an invalid bucket value', async () => {
      const prisma = makePrisma();
      await expect(makeService(prisma).costTrendByAssignee('ws1', 'hour' as any))
        .rejects.toThrow(/bucket/i);
    });

    it('emits generate_series for the axis and groups by bucket + assignee at Asia/Dhaka', async () => {
      const prisma = makePrisma();
      mockTwoQueries(prisma, [], []);
      await makeService(prisma).costTrendByAssignee('ws1', 'day');
      const axisSql: string = prisma.$queryRaw.mock.calls[0][0].sql ?? String(prisma.$queryRaw.mock.calls[0][0]);
      const aggSql: string  = prisma.$queryRaw.mock.calls[1][0].sql ?? String(prisma.$queryRaw.mock.calls[1][0]);
      expect(axisSql).toMatch(/generate_series/);
      expect(aggSql).toMatch(/GROUP BY 1, 2/);
      expect(aggSql).toMatch(/Asia\/Dhaka/);
      expect(aggSql).toMatch(/t\.is_deleted\s*=\s*false/);
    });
  });

  describe('costTrendByClient', () => {
    function mockTwoQueries(prisma: any, buckets: any[], agg: any[]) {
      prisma.$queryRaw
        .mockResolvedValueOnce(buckets)
        .mockResolvedValueOnce(agg);
    }

    it('builds a continuous bucket axis with per-client dollar values, ordered by cost', async () => {
      const prisma = makePrisma();
      mockTwoQueries(
        prisma,
        [{ bucket: '2026-05-18' }, { bucket: '2026-05-19' }, { bucket: '2026-05-20' }],
        [
          { bucket: '2026-05-18', segment: 'Acme',  cost_cents: BigInt(120000) },
          { bucket: '2026-05-18', segment: 'Globex', cost_cents: BigInt(40000) },
          { bucket: '2026-05-20', segment: 'Acme',  cost_cents: BigInt(60000) },
        ],
      );
      const result = await makeService(prisma).costTrendByClient('ws1', 'day');
      expect(result.buckets).toEqual(['2026-05-18', '2026-05-19', '2026-05-20']);
      // Acme (1800 total) ranks above Globex (400); no "Other" by default.
      expect(result.clients).toEqual(['Acme', 'Globex']);
      expect(result.clients).not.toContain('Other');
      expect(result.points).toEqual([
        { bucket: '2026-05-18', values: { Acme: 1200, Globex: 400 } },
        { bucket: '2026-05-19', values: { Acme: 0,    Globex: 0 } },
        { bucket: '2026-05-20', values: { Acme: 600,  Globex: 0 } },
      ]);
    });

    it('groups by the task client and coalesces empty client to "No client"', async () => {
      const prisma = makePrisma();
      mockTwoQueries(prisma, [], []);
      await makeService(prisma).costTrendByClient('ws1', 'day');
      const aggSql: string = prisma.$queryRaw.mock.calls[1][0].sql ?? String(prisma.$queryRaw.mock.calls[1][0]);
      expect(aggSql).toMatch(/t\.client/);
      expect(aggSql).toMatch(/No client/);
      expect(aggSql).toMatch(/GROUP BY 1, 2/);
      expect(aggSql).toMatch(/Asia\/Dhaka/);
    });

    it('throws on an invalid bucket value', async () => {
      const prisma = makePrisma();
      await expect(makeService(prisma).costTrendByClient('ws1', 'year' as any))
        .rejects.toThrow(/bucket/i);
    });
  });

  describe('cycleTime', () => {
    it('maps weekly raw rows to { bucket, meanHours, medianHours, p90Hours, taskCount, meta.minOccurredAt }', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw
        // items
        .mockResolvedValueOnce([
          { bucket: '2026-05-04', mean_hours: 25.5, median_hours: 22.0, p90_hours: 48.0, task_count: BigInt(4) },
        ])
        // meta
        .mockResolvedValueOnce([{ min_occurred_at: new Date('2026-04-10T10:00:00Z') }]);
      const result = await makeService(prisma).cycleTime('ws1', {
        from: new Date('2026-05-01'), to: new Date('2026-05-31'), groupBy: 'week',
      });
      expect(result.items[0]).toEqual({
        bucket: '2026-05-04', meanHours: 25.5, medianHours: 22.0, p90Hours: 48.0, taskCount: 4,
      });
      expect(result.meta.minOccurredAt).toBe('2026-04-10T10:00:00.000Z');
    });

    it('returns empty items + null meta when no events exist', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ min_occurred_at: null }]);
      const result = await makeService(prisma).cycleTime('ws1', {
        from: new Date('2026-05-01'), to: new Date('2026-05-31'), groupBy: 'week',
      });
      expect(result.items).toEqual([]);
      expect(result.meta.minOccurredAt).toBeNull();
    });
  });

  describe('timeInStatus', () => {
    it('maps rows to { status, color, totalHours, taskCount }', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { status: 'in progress', color: '#3b82f6', total_hours: 124.5, task_count: BigInt(12) },
        ])
        .mockResolvedValueOnce([{ min_occurred_at: new Date('2026-04-10T10:00:00Z') }]);
      const result = await makeService(prisma).timeInStatus('ws1', {
        from: new Date('2026-05-01'), to: new Date('2026-05-31'),
      });
      expect(result.items[0]).toEqual({
        status: 'in progress', color: '#3b82f6', totalHours: 124.5, taskCount: 12,
      });
    });
  });

  describe('anomalies', () => {
    it('maps daily spike rows to { date, totalCostAud, medianAud, multiplier }', async () => {
      const prisma = makePrisma();
      // Two raw queries: daily, then client. Stub in order.
      prisma.$queryRaw
        .mockResolvedValueOnce([{
          date: '2026-05-04',
          total_cost_cents: BigInt(192000),
          median_cost_cents: 45600,
          multiplier: 4.21,
        }])
        .mockResolvedValueOnce([]);
      const result = await makeService(prisma).anomalies('ws1');
      expect(result.dailySpikes).toEqual([{
        date: '2026-05-04',
        totalCostAud: 1920,
        medianAud: 456,
        multiplier: 4.21,
      }]);
    });

    it('maps client spike rows to { client, lastWeekCostAud, baselineMedianAud, multiplier }', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          client: 'Acme',
          week_cost_cents: BigInt(210000),
          baseline_median_cents: 67000,
          multiplier: 3.13,
        }]);
      const result = await makeService(prisma).anomalies('ws1');
      expect(result.clientSpikes).toEqual([{
        client: 'Acme',
        lastWeekCostAud: 2100,
        baselineMedianAud: 670,
        multiplier: 3.13,
      }]);
    });

    it('returns empty arrays when no spikes', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      const result = await makeService(prisma).anomalies('ws1');
      expect(result).toEqual({ dailySpikes: [], clientSpikes: [] });
    });

    it("daily query uses Asia/Dhaka, percentile_cont(0.5), $50 floor, 2x median, soft-delete filter", async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      await makeService(prisma).anomalies('ws1');
      const dailyCall = prisma.$queryRaw.mock.calls[0][0];
      const sql: string = dailyCall.sql ?? dailyCall.text ?? String(dailyCall);
      expect(sql).toMatch(/Asia\/Dhaka/);
      expect(sql).toMatch(/percentile_cont\(0\.5\)/);
      expect(sql).toMatch(/5000/);              // $50 floor in cents
      expect(sql).toMatch(/2\s*\*\s*m\.median/i);
      expect(sql).toMatch(/t\.is_deleted\s*=\s*false/);
    });

    it('client query uses Sunday-start week shift and 90-day baseline excluding last 7 days', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([]);
      await makeService(prisma).anomalies('ws1');
      const clientCall = prisma.$queryRaw.mock.calls[1][0];
      const sql: string = clientCall.sql ?? clientCall.text ?? String(clientCall);
      expect(sql).toMatch(/date_trunc\('week'/);
      expect(sql).toMatch(/\+ interval '1 day'/);
      expect(sql).toMatch(/- interval '1 day'/);
      expect(sql).toMatch(/interval '90 days'/);
      expect(sql).toMatch(/interval '7 days'/);
      expect(sql).toMatch(/t\.is_deleted\s*=\s*false/);
    });
  });

  describe('timeEntriesList (client filter + column)', () => {
    it('filters by client via the task relation in where.AND', async () => {
      const prisma = makePrisma();
      await makeService(prisma).timeEntriesList('ws1', 
        undefined, undefined, undefined, undefined, 50, 0,
        undefined, undefined, undefined, undefined, 'Acme Corp',
      );
      const arg = prisma.clickupTimeEntry.findMany.mock.calls[0][0];
      const and = (arg.where.AND ?? []) as any[];
      expect(and).toContainEqual({ task: { client: 'Acme Corp' } });
    });

    it('selects the related task client and maps it onto each row', async () => {
      const prisma = makePrisma();
      prisma.clickupTimeEntry.findMany.mockResolvedValue([{
        timeEntryId: 't1', taskId: 'k1', userId: 'u1', userName: 'Alice', userEmail: 'a@x.com',
        startTime: new Date('2026-05-01T00:00:00Z'), endTime: null,
        durationHours: { toNumber: () => 2 }, hourlyRateCents: BigInt(15000),
        costCents: BigInt(30000), status: 'COST_CALCULATED', billable: true,
        description: null, syncedAt: new Date('2026-05-01T00:00:00Z'), rateId: null, currency: 'USD',
        task: { taskName: 'Build thing', client: 'Acme Corp' },
      }]);
      prisma.clickupTimeEntry.count.mockResolvedValue(1);
      const result = await makeService(prisma).timeEntriesList('ws1');
      const selectArg = prisma.clickupTimeEntry.findMany.mock.calls[0][0].select;
      expect(selectArg.task.select.client).toBe(true);
      expect(result.items[0].client).toBe('Acme Corp');
    });

    it('maps client to null when the entry has no task', async () => {
      const prisma = makePrisma();
      prisma.clickupTimeEntry.findMany.mockResolvedValue([{
        timeEntryId: 't2', taskId: null, userId: 'u1', userName: 'Bob', userEmail: null,
        startTime: new Date('2026-05-01T00:00:00Z'), endTime: null,
        durationHours: { toNumber: () => 1 }, hourlyRateCents: BigInt(0),
        costCents: BigInt(0), status: 'SYNCED', billable: false,
        description: null, syncedAt: new Date('2026-05-01T00:00:00Z'), rateId: null, currency: 'USD',
        task: null,
      }]);
      prisma.clickupTimeEntry.count.mockResolvedValue(1);
      const result = await makeService(prisma).timeEntriesList('ws1');
      expect(result.items[0].client).toBeNull();
    });
  });

  describe('timeEntriesList (list filter + column)', () => {
    it('filters by listId via the task relation in where.AND', async () => {
      const prisma = makePrisma();
      await makeService(prisma).timeEntriesList('ws1', 
        undefined, undefined, undefined, undefined, 50, 0,
        undefined, undefined, undefined, undefined, undefined, 'L1',
      );
      const arg = prisma.clickupTimeEntry.findMany.mock.calls[0][0];
      const and = (arg.where.AND ?? []) as any[];
      expect(and).toContainEqual({ task: { listId: 'L1' } });
    });

    it('selects the related task listName and maps it onto each row', async () => {
      const prisma = makePrisma();
      prisma.clickupTimeEntry.findMany.mockResolvedValue([{
        timeEntryId: 't1', taskId: 'k1', userId: 'u1', userName: 'Alice', userEmail: 'a@x.com',
        startTime: new Date('2026-05-01T00:00:00Z'), endTime: null,
        durationHours: { toNumber: () => 2 }, hourlyRateCents: BigInt(15000),
        costCents: BigInt(30000), status: 'COST_CALCULATED', billable: true,
        description: null, syncedAt: new Date('2026-05-01T00:00:00Z'), rateId: null, currency: 'USD',
        task: { taskName: 'Build thing', client: 'Acme Corp', listName: 'Backlog' },
      }]);
      prisma.clickupTimeEntry.count.mockResolvedValue(1);
      const result = await makeService(prisma).timeEntriesList('ws1');
      const selectArg = prisma.clickupTimeEntry.findMany.mock.calls[0][0].select;
      expect(selectArg.task.select.listName).toBe(true);
      expect(result.items[0].listName).toBe('Backlog');
    });

    it('maps listName to null when the entry has no task', async () => {
      const prisma = makePrisma();
      prisma.clickupTimeEntry.findMany.mockResolvedValue([{
        timeEntryId: 't2', taskId: null, userId: 'u1', userName: 'Bob', userEmail: null,
        startTime: new Date('2026-05-01T00:00:00Z'), endTime: null,
        durationHours: { toNumber: () => 1 }, hourlyRateCents: BigInt(0),
        costCents: BigInt(0), status: 'SYNCED', billable: false,
        description: null, syncedAt: new Date('2026-05-01T00:00:00Z'), rateId: null, currency: 'USD',
        task: null,
      }]);
      prisma.clickupTimeEntry.count.mockResolvedValue(1);
      const result = await makeService(prisma).timeEntriesList('ws1');
      expect(result.items[0].listName).toBeNull();
    });
  });

  describe('timeEntriesList (folder filter)', () => {
    it('filters by folderId via the task relation in where.AND', async () => {
      const prisma = makePrisma();
      await makeService(prisma).timeEntriesList('ws1', 
        undefined, undefined, undefined, undefined, 50, 0,
        undefined, undefined, undefined, undefined, undefined, undefined, 'F1',
      );
      const arg = prisma.clickupTimeEntry.findMany.mock.calls[0][0];
      const and = (arg.where.AND ?? []) as any[];
      expect(and).toContainEqual({ task: { folderId: 'F1' } });
    });
  });

  describe('timeEntriesAggregates (client filter)', () => {
    it('filters aggregates by client via the task relation', async () => {
      const prisma = makePrisma();
      await makeService(prisma).timeEntriesAggregates('ws1', 
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'Acme Corp',
      );
      const arg = prisma.clickupTimeEntry.groupBy.mock.calls[0][0];
      const and = (arg.where.AND ?? []) as any[];
      expect(and).toContainEqual({ task: { client: 'Acme Corp' } });
    });
  });

  describe('timeEntriesAggregates (list filter)', () => {
    it('filters aggregates by listId via the task relation', async () => {
      const prisma = makePrisma();
      await makeService(prisma).timeEntriesAggregates('ws1', 
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'L1',
      );
      const arg = prisma.clickupTimeEntry.groupBy.mock.calls[0][0];
      const and = (arg.where.AND ?? []) as any[];
      expect(and).toContainEqual({ task: { listId: 'L1' } });
    });
  });

  describe('timeEntriesAggregates (folder filter)', () => {
    it('filters aggregates by folderId via the task relation', async () => {
      const prisma = makePrisma();
      await makeService(prisma).timeEntriesAggregates('ws1', 
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'F1',
      );
      const arg = prisma.clickupTimeEntry.groupBy.mock.calls[0][0];
      const and = (arg.where.AND ?? []) as any[];
      expect(and).toContainEqual({ task: { folderId: 'F1' } });
    });
  });

  describe('hourSpikes', () => {
    // Helper: stub the 3 raw queries in the order hourSpikes calls them.
    function stub(prisma: any, baseline: any[], display: any[], axis: string[]) {
      prisma.$queryRaw
        .mockResolvedValueOnce(baseline)
        .mockResolvedValueOnce(display)
        .mockResolvedValueOnce(axis.map((bucket) => ({ bucket })));
    }

    it('flags an absolute-only spike (over cap, under 2x median)', async () => {
      const prisma = makePrisma();
      // median(8,8,8) = 8 → 2x = 16; 14h is > cap(12) but < 16 → absolute only.
      stub(
        prisma,
        [
          { user_id: 'u1', user_name: 'Ann', day: '2026-06-01', hours: 8 },
          { user_id: 'u1', user_name: 'Ann', day: '2026-06-02', hours: 8 },
          { user_id: 'u1', user_name: 'Ann', day: '2026-06-03', hours: 8 },
        ],
        [{ user_id: 'u1', user_name: 'Ann', day: '2026-06-10', hours: 14 }],
        ['2026-06-10'],
      );
      const r = await makeService(prisma).hourSpikes('ws1', 12, '2026-06-10', '2026-06-10');
      expect(r.cap).toBe(12);
      expect(r.watchlist).toHaveLength(1);
      expect(r.watchlist[0]).toMatchObject({ userId: 'u1', userName: 'Ann', date: '2026-06-10', hours: 14, rule: 'absolute' });
      expect(r.byUser.users[0].points[0]).toEqual({ date: '2026-06-10', hours: 14, isSpike: true });
    });

    it('flags a relative-only spike (over 2x median and >= 4h, under cap)', async () => {
      const prisma = makePrisma();
      // median(3,3,3) = 3 → 2x = 6; 7h > 6 and >= 4, and 7 < cap(12) → relative only.
      stub(
        prisma,
        [
          { user_id: 'u2', user_name: 'Bob', day: '2026-06-01', hours: 3 },
          { user_id: 'u2', user_name: 'Bob', day: '2026-06-02', hours: 3 },
          { user_id: 'u2', user_name: 'Bob', day: '2026-06-03', hours: 3 },
        ],
        [{ user_id: 'u2', user_name: 'Bob', day: '2026-06-10', hours: 7 }],
        ['2026-06-10'],
      );
      const r = await makeService(prisma).hourSpikes('ws1', 12, '2026-06-10', '2026-06-10');
      expect(r.watchlist[0]).toMatchObject({ rule: 'relative', hours: 7, median: 3 });
      expect(r.watchlist[0].multiplier).toBeCloseTo(7 / 3, 4);
    });

    it('does not flag when the 4h floor suppresses a small-median spike', async () => {
      const prisma = makePrisma();
      // median(1,1,1) = 1 → 2x = 2; 3h > 2 but 3 < 4 floor, and 3 < cap → no spike.
      stub(
        prisma,
        [
          { user_id: 'u3', user_name: 'Cy', day: '2026-06-01', hours: 1 },
          { user_id: 'u3', user_name: 'Cy', day: '2026-06-02', hours: 1 },
          { user_id: 'u3', user_name: 'Cy', day: '2026-06-03', hours: 1 },
        ],
        [{ user_id: 'u3', user_name: 'Cy', day: '2026-06-10', hours: 3 }],
        ['2026-06-10'],
      );
      const r = await makeService(prisma).hourSpikes('ws1', 12, '2026-06-10', '2026-06-10');
      expect(r.watchlist).toHaveLength(0);
      expect(r.byUser.users[0].points[0].isSpike).toBe(false);
    });

    it('does not flag a normal day (neither rule)', async () => {
      const prisma = makePrisma();
      // median 6 → 2x = 12; 6h is < cap(12) and < 12 → no spike.
      stub(
        prisma,
        [
          { user_id: 'u4', user_name: 'Di', day: '2026-06-01', hours: 6 },
          { user_id: 'u4', user_name: 'Di', day: '2026-06-02', hours: 6 },
        ],
        [{ user_id: 'u4', user_name: 'Di', day: '2026-06-10', hours: 6 }],
        ['2026-06-10'],
      );
      const r = await makeService(prisma).hourSpikes('ws1', 12, '2026-06-10', '2026-06-10');
      expect(r.watchlist).toHaveLength(0);
    });

    it("classifies a day as 'both' when over cap and over 2x median", async () => {
      const prisma = makePrisma();
      // median(5,5) = 5 → 2x = 10; 15h > cap(12) and > 10 → both.
      stub(
        prisma,
        [
          { user_id: 'u5', user_name: 'Ed', day: '2026-06-01', hours: 5 },
          { user_id: 'u5', user_name: 'Ed', day: '2026-06-02', hours: 5 },
        ],
        [{ user_id: 'u5', user_name: 'Ed', day: '2026-06-10', hours: 15 }],
        ['2026-06-10'],
      );
      const r = await makeService(prisma).hourSpikes('ws1', 12, '2026-06-10', '2026-06-10');
      expect(r.watchlist[0].rule).toBe('both');
    });

    it('ranks the watchlist by raw hours descending and caps at 20', async () => {
      const prisma = makePrisma();
      const baseline: any[] = [];
      const display: any[] = [];
      const axis: string[] = [];
      // 25 distinct users, each one spike day with hours 100..76 (all over cap).
      for (let i = 0; i < 25; i++) {
        const day = `2026-06-${String(i + 1).padStart(2, '0')}`;
        display.push({ user_id: `u${i}`, user_name: `U${i}`, day, hours: 100 - i });
        axis.push(day);
      }
      stub(prisma, baseline, display, axis);
      const r = await makeService(prisma).hourSpikes('ws1', 12, '2026-06-01', '2026-06-25');
      expect(r.watchlist).toHaveLength(20);
      expect(r.watchlist[0].hours).toBe(100);
      expect(r.watchlist[19].hours).toBe(81);
    });

    it('zero-fills days with no entries in each user series', async () => {
      const prisma = makePrisma();
      stub(
        prisma,
        [],
        [{ user_id: 'u6', user_name: 'Fi', day: '2026-06-02', hours: 5 }],
        ['2026-06-01', '2026-06-02', '2026-06-03'],
      );
      const r = await makeService(prisma).hourSpikes('ws1', 12, '2026-06-01', '2026-06-03');
      expect(r.byUser.buckets).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
      expect(r.byUser.users[0].points.map((p: any) => p.hours)).toEqual([0, 5, 0]);
    });

    it('computes an even-length median by averaging the two middle values', async () => {
      const prisma = makePrisma();
      // median(4,8) = 6 → 2x = 12; an 8h day is < cap(12) and < 12 → NOT a spike,
      // proving the median is 6 (not 4 or 8). A 13h day would be absolute via cap.
      stub(
        prisma,
        [
          { user_id: 'u7', user_name: 'Gwen', day: '2026-06-01', hours: 4 },
          { user_id: 'u7', user_name: 'Gwen', day: '2026-06-02', hours: 8 },
        ],
        [{ user_id: 'u7', user_name: 'Gwen', day: '2026-06-10', hours: 8 }],
        ['2026-06-10'],
      );
      const r = await makeService(prisma).hourSpikes('ws1', 12, '2026-06-10', '2026-06-10');
      expect(r.watchlist).toHaveLength(0);
    });

    it('reports multiplier null for a user with no baseline (median 0) flagged by the cap', async () => {
      const prisma = makePrisma();
      // No baseline rows → median 0 → relative rule cannot fire; 5h > cap(4) → absolute.
      stub(
        prisma,
        [],
        [{ user_id: 'u8', user_name: 'Hal', day: '2026-06-10', hours: 5 }],
        ['2026-06-10'],
      );
      const r = await makeService(prisma).hourSpikes('ws1', 4, '2026-06-10', '2026-06-10');
      expect(r.watchlist).toHaveLength(1);
      expect(r.watchlist[0]).toMatchObject({ rule: 'absolute', median: 0, multiplier: null });
    });

    it('returns watchlistTotal and respects the limit', async () => {
      const prisma = makePrisma();
      const display: any[] = [];
      const axis: string[] = [];
      for (let i = 0; i < 25; i++) {
        const day = `2026-06-${String(i + 1).padStart(2, '0')}`;
        display.push({ user_id: `u${i}`, user_name: `U${i}`, day, hours: 100 - i });
        axis.push(day);
      }
      stub(prisma, [], display, axis);
      const r = await makeService(prisma).hourSpikes('ws1', 12, '2026-06-01', '2026-06-25', 5);
      expect(r.watchlist).toHaveLength(5);
      expect(r.watchlistTotal).toBe(25);
      expect(r.watchlist[0].hours).toBe(100);
    });

    it('excludes resolved days by default and marks resolved=false on the rest', async () => {
      const prisma = makePrisma();
      stub(
        prisma,
        [],
        [
          { user_id: 'u1', user_name: 'Ann', day: '2026-06-10', hours: 20 },
          { user_id: 'u2', user_name: 'Bob', day: '2026-06-11', hours: 18 },
        ],
        ['2026-06-10', '2026-06-11'],
      );
      prisma.spikeResolution.findMany.mockResolvedValue([
        { clickupUserId: 'u1', spikeDate: new Date('2026-06-10T00:00:00.000Z') },
      ]);
      const r = await makeService(prisma).hourSpikes('ws1', 12, '2026-06-01', '2026-06-30');
      expect(r.watchlist).toHaveLength(1);
      expect(r.watchlist[0]).toMatchObject({ userId: 'u2', resolved: false });
      expect(r.watchlistTotal).toBe(1);
    });

    it('includes resolved days (resolved=true) when includeResolved is set', async () => {
      const prisma = makePrisma();
      stub(
        prisma,
        [],
        [
          { user_id: 'u1', user_name: 'Ann', day: '2026-06-10', hours: 20 },
          { user_id: 'u2', user_name: 'Bob', day: '2026-06-11', hours: 18 },
        ],
        ['2026-06-10', '2026-06-11'],
      );
      prisma.spikeResolution.findMany.mockResolvedValue([
        { clickupUserId: 'u1', spikeDate: new Date('2026-06-10T00:00:00.000Z') },
      ]);
      const r = await makeService(prisma).hourSpikes('ws1', 12, '2026-06-01', '2026-06-30', 20, true);
      expect(r.watchlist).toHaveLength(2);
      expect(r.watchlist.find((w: any) => w.userId === 'u1')!.resolved).toBe(true);
      expect(r.watchlist.find((w: any) => w.userId === 'u2')!.resolved).toBe(false);
      expect(r.watchlistTotal).toBe(2);
    });
  });

  describe('stats excludedIds filtering', () => {
    it('counts COST_EXCLUDED as not-missing and excludes excluded users while keeping NULL-userId rows', async () => {
      const prisma = makePrisma();
      await makeService(prisma).stats('ws1', ['u1']);
      // 4th count call (missingRateEntries) is on clickupTimeEntry.count
      const where = prisma.clickupTimeEntry.count.mock.calls[0][0].where;
      expect(where.status).toEqual({ notIn: ['COST_CALCULATED', 'COST_EXCLUDED'] });
      expect(where.OR).toEqual([{ userId: null }, { userId: { notIn: ['u1'] } }]);
    });

    it('omits the userId filter when no ids are excluded', async () => {
      const prisma = makePrisma();
      await makeService(prisma).stats('ws1');
      const where = prisma.clickupTimeEntry.count.mock.calls[0][0].where;
      expect(where.OR).toBeUndefined();
    });
  });

  describe('missingRates excludedIds SQL safety', () => {
    it('does not throw when the excluded list is empty (no Prisma.join on [])', async () => {
      const prisma = makePrisma();
      await expect(makeService(prisma).missingRates('ws1', [])).resolves.toBeDefined();
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('builds the query with excluded ids without throwing', async () => {
      const prisma = makePrisma();
      await expect(makeService(prisma).missingRates('ws1', ['u1'])).resolves.toBeDefined();
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });
  });

  describe('hourSpikes notified enrichment', () => {
    it('marks a watchlist row notified when a SpikeNotification exists for it', async () => {
      const prisma = makePrisma();
      const day = '2026-06-10';
      // baseline rows (median), display rows (the spike day), axis rows (day series)
      prisma.$queryRaw
        .mockResolvedValueOnce([{ user_id: '123', user_name: 'Rashedul', day, hours: 5 }])      // baseline
        .mockResolvedValueOnce([{ user_id: '123', user_name: 'Rashedul', day, hours: 20 }])     // display
        .mockResolvedValueOnce([{ bucket: day }]);                                              // axis
      prisma.spikeNotification.findMany.mockResolvedValue([
        { clickupUserId: '123', spikeDate: new Date('2026-06-10T00:00:00.000Z') },
      ]);

      const res = await makeService(prisma).hourSpikes('ws1', 12, day, day);
      expect(res.watchlist).toHaveLength(1);
      expect(res.watchlist[0]).toMatchObject({ userId: '123', date: day, notified: true });
    });

    it('leaves rows not-notified when no SpikeNotification matches', async () => {
      const prisma = makePrisma();
      const day = '2026-06-10';
      prisma.$queryRaw
        .mockResolvedValueOnce([{ user_id: '123', user_name: 'Rashedul', day, hours: 5 }])
        .mockResolvedValueOnce([{ user_id: '123', user_name: 'Rashedul', day, hours: 20 }])
        .mockResolvedValueOnce([{ bucket: day }]);
      // findMany defaults to [] from makePrisma
      const res = await makeService(prisma).hourSpikes('ws1', 12, day, day);
      expect(res.watchlist[0].notified).toBe(false);
    });

    it('skips the notification lookup when there are no spikes', async () => {
      const prisma = makePrisma();
      const day = '2026-06-10';
      // baseline + display both have only a normal (non-spike) day, axis one bucket
      prisma.$queryRaw
        .mockResolvedValueOnce([{ user_id: '123', user_name: 'Rashedul', day, hours: 5 }])  // baseline
        .mockResolvedValueOnce([{ user_id: '123', user_name: 'Rashedul', day, hours: 5 }])  // display (5h, under cap, not 2x median)
        .mockResolvedValueOnce([{ bucket: day }]);                                          // axis
      const res = await makeService(prisma).hourSpikes('ws1', 12, day, day);
      expect(res.watchlist).toHaveLength(0);
      expect(prisma.spikeNotification.findMany).not.toHaveBeenCalled();
    });
  });
});
