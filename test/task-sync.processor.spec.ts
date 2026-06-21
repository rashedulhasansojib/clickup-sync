import { TaskSyncProcessor } from '../src/workers/task-sync.processor';
import { JOBS } from '../src/queues/queue.constants';

function makeDeps() {
  const syncTask = jest.fn().mockResolvedValue({ taskId: 't1' });
  const softDeleteTask = jest.fn().mockResolvedValue({});
  const tasks = { syncTask, softDeleteTask } as any;
  const started = jest.fn().mockResolvedValue({ id: 1n });
  const finished = jest.fn().mockResolvedValue({});
  const failed = jest.fn().mockResolvedValue({});
  const jobLogs = { started, finished, failed } as any;
  const recordIfExhausted = jest.fn().mockResolvedValue(false);
  const deadLetters = { recordIfExhausted } as any;
  const deleteByTaskId = jest.fn().mockResolvedValue(0);
  const timeEntries = { deleteByTaskId } as any;
  const reconcileTask = jest.fn().mockResolvedValue({ taskId: 't1', deleted: false, timeEntriesSynced: 2 });
  const reconciliation = { reconcileTask } as any;
  return { proc: new TaskSyncProcessor(tasks, jobLogs, deadLetters, timeEntries, reconciliation), syncTask, softDeleteTask, finished, failed, recordIfExhausted, deleteByTaskId, reconcileTask };
}

describe('TaskSyncProcessor', () => {
  it('syncs a task and logs success', async () => {
    const { proc, syncTask, finished } = makeDeps();
    await proc.process({ id: '1', name: JOBS.SYNC_CLICKUP_TASK, data: { workspaceId: 'ws1', taskId: 't1' } } as any);
    expect(syncTask).toHaveBeenCalledWith('ws1', 't1');
    expect(finished).toHaveBeenCalledWith(1n, { tasksSynced: 1 });
  });

  it('soft-deletes on the delete job and removes the task’s time entries', async () => {
    const { proc, softDeleteTask, syncTask, deleteByTaskId } = makeDeps();
    await proc.process({ id: '1', name: JOBS.DELETE_CLICKUP_TASK, data: { workspaceId: 'ws1', taskId: 't1' } } as any);
    expect(deleteByTaskId).toHaveBeenCalledWith('t1');
    expect(softDeleteTask).toHaveBeenCalledWith('t1', 'ws1');
    expect(syncTask).not.toHaveBeenCalled();
  });

  it('does not touch time entries on a normal sync', async () => {
    const { proc, deleteByTaskId } = makeDeps();
    await proc.process({ id: '1', name: JOBS.SYNC_CLICKUP_TASK, data: { workspaceId: 'ws1', taskId: 't1' } } as any);
    expect(deleteByTaskId).not.toHaveBeenCalled();
  });

  it('routes the reconcile job to the reconciliation service with its window', async () => {
    const { proc, reconcileTask, syncTask, softDeleteTask } = makeDeps();
    await proc.process({ id: '1', name: JOBS.RECONCILE_CLICKUP_TASK, data: { workspaceId: 'ws1', taskId: 't1', startDate: 1000, endDate: 2000 } } as any);
    expect(reconcileTask).toHaveBeenCalledWith('ws1', 't1', 1000, 2000);
    expect(syncTask).not.toHaveBeenCalled();
    expect(softDeleteTask).not.toHaveBeenCalled();
  });

  it('logs failure and rethrows', async () => {
    const { proc, syncTask, failed } = makeDeps();
    const err = new Error('boom');
    syncTask.mockRejectedValueOnce(err);
    await expect(proc.process({ id: '1', name: JOBS.SYNC_CLICKUP_TASK, data: { workspaceId: 'ws1', taskId: 't1' } } as any)).rejects.toThrow('boom');
    expect(failed).toHaveBeenCalledWith(1n, err);
  });

  it('routes exhausted jobs to dead-letter storage via the failed hook', async () => {
    const { proc, recordIfExhausted } = makeDeps();
    const job = { data: { taskId: 't1' } } as any;
    const err = new Error('boom');
    await proc.onFailed(job, err);
    expect(recordIfExhausted).toHaveBeenCalledWith(job, err);
  });
});
