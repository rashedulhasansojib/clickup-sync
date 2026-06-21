import { BadRequestException, ConflictException } from '@nestjs/common';
import { SpikeNotificationService } from './spike-notification.service';

function makeDeps(overrides: any = {}) {
  const sent: any[] = [];
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    spikeNotification: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    ...overrides.prisma,
  };
  const mailer = { sendSpikeNotice: jest.fn(async (a: any) => { sent.push(a); }) };
  const workspaces = { getSpikeHoursCap: () => 12 };
  const svc = new SpikeNotificationService(prisma as any, mailer as any, workspaces as any);
  return { svc, prisma, mailer, workspaces, sent };
}

const TASK_ROWS = [
  { task_id: '86a', task_name: 'Build', user_name: 'Rashedul', user_email: 'r@test.com', hours: 9 },
  { task_id: '86b', task_name: 'Backfill', user_name: 'Rashedul', user_email: 'r@test.com', hours: 5.5 },
];

describe('SpikeNotificationService', () => {
  it('breakdown() sums hours, picks the recipient email, and maps tasks', async () => {
    const { svc, prisma } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce(TASK_ROWS);
    const b = await svc.breakdown('ws1', '123', '2026-06-10');
    expect(b.recipientEmail).toBe('r@test.com');
    expect(b.userName).toBe('Rashedul');
    expect(b.totalHours).toBeCloseTo(14.5);
    expect(b.tasks).toHaveLength(2);
  });

  it('breakdown() rejects a malformed date', async () => {
    const { svc } = makeDeps();
    await expect(svc.breakdown('ws1', '123', '06/10/2026')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('notify() sends one email and records the notification', async () => {
    const { svc, prisma, mailer } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce(TASK_ROWS);
    const res = await svc.notify({ workspaceId: 'ws1', userId: '123', date: '2026-06-10', rule: 'absolute', note: 'check it', sentBy: 'admin@test' });
    expect(mailer.sendSpikeNotice).toHaveBeenCalledTimes(1);
    expect(mailer.sendSpikeNotice.mock.calls[0][0].reason).toBe('over the 12h/day cap');
    expect(prisma.spikeNotification.create).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ sent: true, recipientEmail: 'r@test.com', date: '2026-06-10' });
  });

  it('notify() 400s when the day has no entries', async () => {
    const { svc, prisma, mailer } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(svc.notify({ workspaceId: 'ws1', userId: '123', date: '2026-06-10' })).rejects.toBeInstanceOf(BadRequestException);
    expect(mailer.sendSpikeNotice).not.toHaveBeenCalled();
  });

  it('notify() 400s when no email is on file', async () => {
    const { svc, prisma, mailer } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce([{ ...TASK_ROWS[0], user_email: null }]);
    await expect(svc.notify({ workspaceId: 'ws1', userId: '123', date: '2026-06-10' })).rejects.toBeInstanceOf(BadRequestException);
    expect(mailer.sendSpikeNotice).not.toHaveBeenCalled();
  });

  it('notify() 409s without sending when already notified', async () => {
    const { svc, prisma, mailer } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce(TASK_ROWS);
    prisma.spikeNotification.findUnique.mockResolvedValueOnce({ id: 1n });
    await expect(svc.notify({ workspaceId: 'ws1', userId: '123', date: '2026-06-10' })).rejects.toBeInstanceOf(ConflictException);
    expect(mailer.sendSpikeNotice).not.toHaveBeenCalled();
  });

  it('notify() looks up the prior notification by workspace + user + day', async () => {
    const { svc, prisma } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce(TASK_ROWS);
    await svc.notify({ workspaceId: 'ws1', userId: '123', date: '2026-06-10' });
    expect(prisma.spikeNotification.findUnique).toHaveBeenCalledWith({
      where: {
        workspaceId_clickupUserId_spikeDate: {
          workspaceId: 'ws1',
          clickupUserId: '123',
          spikeDate: new Date('2026-06-10T00:00:00.000Z'),
        },
      },
    });
    expect(prisma.spikeNotification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceId: 'ws1', clickupUserId: '123' }),
      }),
    );
  });

  it('relative-rule reason uses the multiplier when median is provided', async () => {
    const { svc, prisma, mailer } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce(TASK_ROWS);
    await svc.notify({ workspaceId: 'ws1', userId: '123', date: '2026-06-10', rule: 'relative', median: 5 });
    expect(mailer.sendSpikeNotice.mock.calls[0][0].reason).toBe('2.9× your typical 5.0h');
  });
});
