import { TasksService } from '../src/tasks/tasks.service';

function makeDeps() {
  const getTask = jest.fn();
  const clickup = { getTask } as any;
  const normalizeTask = jest.fn((raw: any) => ({ taskId: raw.id, parentTaskId: raw.parent ?? null }));
  const normalizer = { normalizeTask } as any;
  const upsert = jest.fn().mockResolvedValue({});
  const softDelete = jest.fn().mockResolvedValue({});
  const findMissingParentIds = jest.fn();
  const repo = { upsert, softDelete, findMissingParentIds } as any;
  return { svc: new TasksService(clickup, normalizer, repo), getTask, normalizeTask, upsert, softDelete, findMissingParentIds };
}

describe('TasksService', () => {
  it('syncTask fetches from ClickUp, normalizes, and upserts', async () => {
    const { svc, getTask, upsert } = makeDeps();
    getTask.mockResolvedValue({ id: 't1' });
    const res = await svc.syncTask('ws1', 't1');
    expect(getTask).toHaveBeenCalledWith('ws1', 't1');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1' }), 'ws1');
    expect(res.taskId).toBe('t1');
  });

  it('syncTasks upserts every task and returns the count', async () => {
    const { svc, upsert } = makeDeps();
    const count = await svc.syncTasks('ws1', [{ id: 'a' }, { id: 'b' }]);
    expect(count).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'a' }), 'ws1');
  });

  it('softDeleteTask delegates to the repository', async () => {
    const { svc, softDelete } = makeDeps();
    await svc.softDeleteTask('t9', 'ws1');
    expect(softDelete).toHaveBeenCalledWith('t9', 'ws1');
  });

  describe('syncMissingParents', () => {
    it('fetches+upserts only the ids the repo reports missing', async () => {
      const { svc, getTask, findMissingParentIds, upsert } = makeDeps();
      findMissingParentIds.mockResolvedValue(['p2']); // p1 already stored
      getTask.mockResolvedValue({ id: 'p2' });

      const synced = await svc.syncMissingParents('ws1', ['p1', 'p2']);

      expect(findMissingParentIds).toHaveBeenCalledWith(['p1', 'p2']);
      expect(getTask).toHaveBeenCalledTimes(1);
      expect(getTask).toHaveBeenCalledWith('ws1', 'p2');
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(synced).toBe(1);
    });

    it('tolerates a 404/fetch failure on one parent and continues', async () => {
      const { svc, getTask, findMissingParentIds } = makeDeps();
      findMissingParentIds.mockResolvedValue(['gone', 'ok']);
      getTask.mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce({ id: 'ok' });

      const synced = await svc.syncMissingParents('ws1', ['gone', 'ok']);

      expect(synced).toBe(1); // only the reachable one
    });

    it('does nothing when no parents are missing', async () => {
      const { svc, getTask, findMissingParentIds } = makeDeps();
      findMissingParentIds.mockResolvedValue([]);
      const synced = await svc.syncMissingParents('ws1', ['p1']);
      expect(getTask).not.toHaveBeenCalled();
      expect(synced).toBe(0);
    });
  });
});
