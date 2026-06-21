import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (date: string) => new Date(`${date}T00:00:00.000Z`);

@Injectable()
export class SpikeResolutionService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(args: { workspaceId: string; userId: string; date: string; userName?: string; note?: string; resolvedBy?: string }) {
    const { workspaceId, userId, date, userName, note, resolvedBy } = args;
    if (!DATE_RE.test(date)) throw new BadRequestException('date must be YYYY-MM-DD');
    await this.prisma.spikeResolution.upsert({
      where: { workspaceId_clickupUserId_spikeDate: { workspaceId, clickupUserId: userId, spikeDate: dayStart(date) } },
      create: { workspaceId, clickupUserId: userId, spikeDate: dayStart(date), userName: userName ?? null, note: note ?? null, resolvedBy: resolvedBy ?? null },
      update: { userName: userName ?? null, note: note ?? null, resolvedBy: resolvedBy ?? null },
    });
    return { resolved: true as const, date };
  }

  async unresolve(args: { workspaceId: string; userId: string; date: string }) {
    const { workspaceId, userId, date } = args;
    if (!DATE_RE.test(date)) throw new BadRequestException('date must be YYYY-MM-DD');
    await this.prisma.spikeResolution.deleteMany({
      where: { workspaceId, clickupUserId: userId, spikeDate: dayStart(date) },
    });
    return { resolved: false as const, date };
  }
}
