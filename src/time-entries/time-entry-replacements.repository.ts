import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class TimeEntryReplacementsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByOriginalEntryId(originalEntryId: string) {
    return this.prisma.timeEntryReplacement.findUnique({ where: { originalEntryId } });
  }

  create(data: {
    workspaceId: string;
    originalEntryId: string;
    replacementEntryId?: string;
    taskId?: string;
    originalUserId?: string;
    replacedUserId?: string;
    tagName?: string;
    status?: string;
    errorMessage?: string;
  }) {
    return this.prisma.timeEntryReplacement.create({ data });
  }

  findPendingForUser(originalUserId: string, limit = 100) {
    return this.prisma.timeEntryReplacement.findMany({
      where: { originalUserId, status: 'pending' },
      take: limit,
      orderBy: { replacedAt: 'asc' },
    });
  }
}
