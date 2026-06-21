import { TaskReconciliationService } from './task-reconciliation.service';

function makeService() {
  const getTask = jest.fn();
  const clickup = { getTask } as any;
  const syncTasks = jest.fn().mockResolvedValue(1);
  const softDeleteTask = jest.fn().mockResolvedValue({});
  const tasksService = { syncTasks, softDeleteTask } as any;
  const syncTaskTimeEntries = jest.fn().mockResolvedValue(3);
  const timeEntriesService = { syncTaskTimeEntries } as any;
  const deleteByTaskId = jest.fn().mockResolvedValue(2);
  const timeEntriesRepo = { deleteByTaskId } as any;
  const svc = new TaskReconciliationService(clickup, tasksService, timeEntriesService, timeEntriesRepo);
  return { svc, getTask, syncTasks, softDeleteTask, syncTaskTimeEntries, deleteByTaskId };
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

describe('TaskReconciliationService.reconcileTask', () => {
  it('refreshes the task and reconciles its time entries when it still exists in ClickUp', async () => {
    const { svc, getTask, syncTasks, syncTaskTimeEntries, softDeleteTask, deleteByTaskId } = makeService();
    const task = { id: 't1', name: 'Still here' };
    getTask.mockResolvedValue(task);

    const res = await svc.reconcileTask('ws1', 't1', 1000, 2000);

    expect(syncTasks).toHaveBeenCalledWith('ws1', [task]); // reuses the fetched task — no second API call
    expect(syncTaskTimeEntries).toHaveBeenCalledWith('ws1', 't1', undefined, 1000, 2000);
    expect(softDeleteTask).not.toHaveBeenCalled();
    expect(deleteByTaskId).not.toHaveBeenCalled();
    expect(res).toEqual({ taskId: 't1', deleted: false, timeEntriesSynced: 3 });
  });

  it('soft-deletes the task and removes its time entries on a ClickUp 404', async () => {
    const { svc, getTask, deleteByTaskId, softDeleteTask, syncTaskTimeEntries, syncTasks } = makeService();
    getTask.mockRejectedValue(httpError(404));

    const res = await svc.reconcileTask('ws1', 'gone', 1000, 2000);

    expect(deleteByTaskId).toHaveBeenCalledWith('gone');
    expect(softDeleteTask).toHaveBeenCalledWith('gone', 'ws1');
    expect(syncTaskTimeEntries).not.toHaveBeenCalled();
    expect(syncTasks).not.toHaveBeenCalled();
    expect(res).toEqual({ taskId: 'gone', deleted: true });
  });

  it('rethrows and never deletes on a non-404 error (e.g. 401 cross-workspace, 5xx)', async () => {
    for (const status of [401, 403, 500]) {
      const { svc, getTask, deleteByTaskId, softDeleteTask } = makeService();
      getTask.mockRejectedValue(httpError(status));

      await expect(svc.reconcileTask('ws1', 't1', 1000, 2000)).rejects.toThrow(`HTTP ${status}`);
      expect(deleteByTaskId).not.toHaveBeenCalled();
      expect(softDeleteTask).not.toHaveBeenCalled();
    }
  });
});
