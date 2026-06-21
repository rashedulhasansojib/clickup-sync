import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NormalizedTask } from '../clickup/clickup-normalizer';

@Injectable()
export class TasksRepository {
  constructor(private readonly prisma: PrismaService) {}

  upsert(task: NormalizedTask, workspaceId: string) {
    return this.prisma.clickupTask.upsert({
      where: { taskId: task.taskId },
      create: { ...task, workspaceId, raw: task.raw as Prisma.InputJsonValue, isDeleted: false, syncCount: 1 },
      update: { ...task, raw: task.raw as Prisma.InputJsonValue, isDeleted: false, deletedAt: null, syncCount: { increment: 1 } },
    });
  }

  softDelete(taskId: string, workspaceId: string) {
    return this.prisma.clickupTask.upsert({
      where: { taskId },
      create: { taskId, workspaceId, taskName: 'Unknown Task', isDeleted: true, deletedAt: new Date() },
      update: { isDeleted: true, deletedAt: new Date(), syncedAt: new Date(), syncCount: { increment: 1 } },
    });
  }

  patchSpaceNames(workspaceId: string, spaceId: string, spaceName: string) {
    return this.prisma.clickupTask.updateMany({
      where: { workspaceId, spaceId, spaceName: null },
      data: { spaceName },
    });
  }

  async exists(taskId: string): Promise<boolean> {
    const row = await this.prisma.clickupTask.findUnique({ where: { taskId }, select: { taskId: true } });
    return row !== null;
  }

  findAllIds(workspaceId: string, spaceId?: string): Promise<{ taskId: string; spaceId: string | null }[]> {
    return this.prisma.clickupTask.findMany({
      where: { workspaceId, isDeleted: false, ...(spaceId ? { spaceId } : {}) },
      select: { taskId: true, spaceId: true },
    });
  }

  /** Count of non-deleted tasks — the reconciliation-progress denominator. */
  countActive(workspaceId: string): Promise<number> {
    return this.prisma.clickupTask.count({ where: { workspaceId, isDeleted: false } });
  }

  async findMissingParentIds(parentIds: string[]): Promise<string[]> {
    if (!parentIds.length) return [];
    const rows = await this.prisma.clickupTask.findMany({ where: { taskId: { in: parentIds } }, select: { taskId: true } });
    const existing = new Set(rows.map((r) => r.taskId));
    return parentIds.filter((id) => !existing.has(id));
  }
}
