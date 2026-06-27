import { ClickupNormalizer } from '../src/clickup/clickup-normalizer';
import { CommentsRepository } from '../src/comments/comments.repository';
import { CommentsService } from '../src/comments/comments.service';

function makeNormalizer() {
  // normalizeComment doesn't touch the custom-field extractor; pass a stub.
  return new ClickupNormalizer({ extract: jest.fn() } as any);
}

describe('ClickupNormalizer.normalizeComment', () => {
  const n = makeNormalizer();

  it('maps the full comment shape (comment_text plaintext preferred)', () => {
    const out = n.normalizeComment(
      {
        id: 'cm1',
        comment_text: 'Looks good',
        comment: [{ text: 'Looks ' }, { text: 'good' }],
        user: { id: 42, username: 'Ada', email: 'ada@x.com' },
        resolved: true,
        assignee: { id: 7, username: 'Bo' },
        reactions: [{ reaction: '👍' }],
        reply_count: '3',
        date: '1716470400000',
      },
      'task1',
    );
    expect(out).toMatchObject({
      commentId: 'cm1',
      taskId: 'task1',
      parentCommentId: null,
      commentText: 'Looks good',
      userId: '42',
      userName: 'Ada',
      userEmail: 'ada@x.com',
      resolved: true,
      assigneeId: '7',
      assigneeName: 'Bo',
      replyCount: 3,
    });
    expect(out.reactions).toEqual([{ reaction: '👍' }]);
    expect(out.commentDate?.getTime()).toBe(1716470400000);
  });

  it('falls back to joining comment[].text when comment_text is absent', () => {
    const out = n.normalizeComment({ id: 'cm2', comment: [{ text: 'hel' }, { text: 'lo' }], date: 1 }, 't');
    expect(out.commentText).toBe('hello');
  });

  it('defaults missing optional fields safely', () => {
    const out = n.normalizeComment({ id: 'cm3' }, 't');
    expect(out).toMatchObject({ commentText: null, userId: null, resolved: false, assigneeId: null, replyCount: 0, commentDate: null });
    expect(out.reactions).toBeNull();
  });

  it('throws when the comment has no id', () => {
    expect(() => n.normalizeComment({} as any, 't')).toThrow(/missing id/);
  });
});

describe('CommentsRepository.upsert (idempotency by construction)', () => {
  function makeRepo() {
    const upsert = jest.fn().mockResolvedValue({});
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { clickupTaskComment: { upsert }, clickupTask: { updateMany } } as any;
    return { repo: new CommentsRepository(prisma), upsert, updateMany };
  }
  const comment = {
    commentId: 'cm1', taskId: 't1', parentCommentId: null, commentText: 'hi',
    userId: '1', userName: 'A', userEmail: null, resolved: false, assigneeId: null,
    assigneeName: null, replyCount: 0, reactions: null, commentDate: new Date(1), raw: { id: 'cm1' },
  };

  it('keys on commentId; sets syncCount:1 on create and increments on update (no duplicate)', () => {
    const { repo, upsert } = makeRepo();
    repo.upsert(comment as any, 'ws1');
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ commentId: 'cm1' });
    expect(arg.create.syncCount).toBe(1);
    expect(arg.create.workspaceId).toBe('ws1');
    expect(arg.update.syncCount).toEqual({ increment: 1 });
    // re-sync clears soft-delete + re-stamps, never inserts a second row.
    expect(arg.update.isDeleted).toBe(false);
    expect(arg.update.deletedAt).toBeNull();
  });

  it('markTaskCommentsSynced uses updateMany (no throw when task absent)', () => {
    const { repo, updateMany } = makeRepo();
    repo.markTaskCommentsSynced('t1', 5);
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ taskId: 't1' });
    expect(arg.data.commentCount).toBe(5);
    expect(arg.data.commentsSyncedAt).toBeInstanceOf(Date);
  });
});

describe('CommentsService.syncTaskComments', () => {
  it('fetches, upserts every comment, then stamps the completeness markers with the count', async () => {
    const clickup = { getTaskComments: jest.fn().mockResolvedValue([{ id: 'a', date: 1 }, { id: 'b', date: 2 }]) } as any;
    const normalizer = { normalizeComment: jest.fn((c: any, taskId: string) => ({ commentId: c.id, taskId })) } as any;
    const upsert = jest.fn().mockResolvedValue({});
    const markTaskCommentsSynced = jest.fn().mockResolvedValue({ count: 1 });
    const repo = { upsert, markTaskCommentsSynced } as any;
    const svc = new CommentsService(clickup, normalizer, repo);

    const count = await svc.syncTaskComments('ws1', 't1');

    expect(count).toBe(2);
    expect(clickup.getTaskComments).toHaveBeenCalledWith('ws1', 't1');
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith({ commentId: 'a', taskId: 't1' }, 'ws1');
    expect(markTaskCommentsSynced).toHaveBeenCalledWith('t1', 2);
  });
});
