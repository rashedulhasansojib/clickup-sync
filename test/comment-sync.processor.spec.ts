import { CommentSyncProcessor } from '../src/workers/comment-sync.processor';
import { JOBS } from '../src/queues/queue.constants';

function makeDeps() {
  const syncTaskComments = jest.fn().mockResolvedValue(4);
  const comments = { syncTaskComments } as any;
  const started = jest.fn().mockResolvedValue({ id: 1n });
  const finished = jest.fn().mockResolvedValue({});
  const failed = jest.fn().mockResolvedValue({});
  const jobLogs = { started, finished, failed } as any;
  const recordIfExhausted = jest.fn().mockResolvedValue(false);
  const deadLetters = { recordIfExhausted } as any;
  return { proc: new CommentSyncProcessor(comments, jobLogs, deadLetters), syncTaskComments, finished, failed, recordIfExhausted };
}

describe('CommentSyncProcessor', () => {
  it('syncs a task’s comments and logs success', async () => {
    const { proc, syncTaskComments, finished } = makeDeps();
    const result = await proc.process({ id: '1', name: JOBS.SYNC_TASK_COMMENTS, data: { workspaceId: 'ws1', taskId: 't1' } } as any);
    expect(syncTaskComments).toHaveBeenCalledWith('ws1', 't1');
    expect(finished).toHaveBeenCalledWith(1n, {});
    expect(result).toBe(4);
  });

  it('logs failure and rethrows', async () => {
    const { proc, syncTaskComments, failed } = makeDeps();
    const err = new Error('boom');
    syncTaskComments.mockRejectedValueOnce(err);
    await expect(proc.process({ id: '1', name: JOBS.SYNC_TASK_COMMENTS, data: { workspaceId: 'ws1', taskId: 't1' } } as any)).rejects.toThrow('boom');
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
