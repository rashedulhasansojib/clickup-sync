import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export type WorkspaceWithSpaces = Prisma.WorkspaceGetPayload<{ include: { spaces: true } }>;

@Injectable()
export class WorkspaceRepository {
  constructor(private readonly prisma: PrismaService) {}

  listAll(): Promise<WorkspaceWithSpaces[]> {
    return this.prisma.workspace.findMany({
      include: { spaces: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  findById(id: string): Promise<WorkspaceWithSpaces | null> {
    return this.prisma.workspace.findUnique({ where: { id }, include: { spaces: true } });
  }

  create(data: Prisma.WorkspaceCreateInput): Promise<WorkspaceWithSpaces> {
    return this.prisma.workspace.create({ data, include: { spaces: true } });
  }

  update(id: string, data: Prisma.WorkspaceUpdateInput): Promise<WorkspaceWithSpaces> {
    return this.prisma.workspace.update({ where: { id }, data, include: { spaces: true } });
  }

  delete(id: string): Promise<unknown> {
    return this.prisma.workspace.delete({ where: { id } });
  }

  /** Count workspace-scoped ClickUp data so a delete can refuse to orphan rows. */
  async countData(id: string): Promise<number> {
    const [tasks, entries] = await Promise.all([
      this.prisma.clickupTask.count({ where: { workspaceId: id } }),
      this.prisma.clickupTimeEntry.count({ where: { workspaceId: id } }),
    ]);
    return tasks + entries;
  }

  upsertSpace(
    workspaceId: string,
    spaceId: string,
    data: { name: string; backfillLookbackDays?: number; enabled?: boolean },
  ): Promise<unknown> {
    return this.prisma.workspaceSpace.upsert({
      where: { workspaceId_spaceId: { workspaceId, spaceId } },
      create: { workspaceId, spaceId, ...data },
      update: data,
    });
  }

  deleteSpace(workspaceId: string, spaceId: string): Promise<unknown> {
    return this.prisma.workspaceSpace.delete({
      where: { workspaceId_spaceId: { workspaceId, spaceId } },
    });
  }
}
