import { TimeEntriesRepository } from './time-entries.repository';

function makeRepo(deleteCount = 0) {
  const deleteMany = jest.fn().mockResolvedValue({ count: deleteCount });
  const prisma = { clickupTimeEntry: { deleteMany } } as any;
  return { repo: new TimeEntriesRepository(prisma), deleteMany };
}

describe('TimeEntriesRepository', () => {
  describe('deleteByTaskId', () => {
    it('deletes every time entry for the task (used when the task itself is deleted)', async () => {
      const { repo, deleteMany } = makeRepo();
      await repo.deleteByTaskId('t1');
      expect(deleteMany).toHaveBeenCalledWith({ where: { taskId: 't1' } });
    });
  });

  describe('pruneTaskEntriesOutsideSet', () => {
    it('deletes only rows in-scope (task, fetched users, within window) that ClickUp did not return', async () => {
      const { repo, deleteMany } = makeRepo(2);
      const deleted = await repo.pruneTaskEntriesOutsideSet({
        workspaceId: 'ws1',
        taskId: 't1',
        userIds: ['u9'],
        startMs: 1000,
        endMs: 2000,
        keepIds: ['te-A', 'te-B'],
      });

      expect(deleted).toBe(2);
      expect(deleteMany).toHaveBeenCalledWith({
        where: {
          workspaceId: 'ws1',
          taskId: 't1',
          userId: { in: ['u9'] },
          startTime: { gte: new Date(1000), lte: new Date(2000) },
          timeEntryId: { notIn: ['te-A', 'te-B'] },
        },
      });
    });
  });
});
