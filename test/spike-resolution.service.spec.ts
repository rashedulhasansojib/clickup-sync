import { BadRequestException } from '@nestjs/common';
import { SpikeResolutionService } from '../src/admin/spike-resolution.service';

function makePrisma() {
  return {
    spikeResolution: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  } as any;
}

describe('SpikeResolutionService', () => {
  it('resolve() upserts keyed by workspace+user+day (idempotent)', async () => {
    const prisma = makePrisma();
    const svc = new SpikeResolutionService(prisma);
    const res = await svc.resolve({ workspaceId: 'ws1', userId: 'u1', date: '2026-06-10', userName: 'Ann', note: 'ok', resolvedBy: 'admin@x' });
    expect(res).toEqual({ resolved: true, date: '2026-06-10' });
    expect(prisma.spikeResolution.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_clickupUserId_spikeDate: { workspaceId: 'ws1', clickupUserId: 'u1', spikeDate: new Date('2026-06-10T00:00:00.000Z') } },
        create: expect.objectContaining({ workspaceId: 'ws1', clickupUserId: 'u1', userName: 'Ann', note: 'ok', resolvedBy: 'admin@x' }),
        update: expect.objectContaining({ note: 'ok', resolvedBy: 'admin@x' }),
      }),
    );
  });

  it('unresolve() deletes by workspace+user+day and is a no-op when absent', async () => {
    const prisma = makePrisma();
    prisma.spikeResolution.deleteMany.mockResolvedValue({ count: 0 });
    const svc = new SpikeResolutionService(prisma);
    const res = await svc.unresolve({ workspaceId: 'ws1', userId: 'u1', date: '2026-06-10' });
    expect(res).toEqual({ resolved: false, date: '2026-06-10' });
    expect(prisma.spikeResolution.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws1', clickupUserId: 'u1', spikeDate: new Date('2026-06-10T00:00:00.000Z') },
    });
  });

  it('rejects a malformed date', async () => {
    const svc = new SpikeResolutionService(makePrisma());
    await expect(svc.resolve({ workspaceId: 'ws1', userId: 'u1', date: '06/10/2026' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
