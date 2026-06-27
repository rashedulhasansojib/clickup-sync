import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AssignableMember } from "./clickup.types";
import { PutPushConfigDto } from "./clickup.dto";

export interface PushConfigView {
  workspaceId: string;
  targetListId: string;
  targetListName: string | null;
  assignableMembers: AssignableMember[];
  defaultStatus: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Get/set the per-workspace ClickUp write-back config (target list + assignable
 * members). Workspace-scoped; the caller resolves/authorizes the workspaceId.
 */
@Injectable()
export class PushConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async get(workspaceId: string): Promise<PushConfigView | null> {
    const row = await this.prisma.workspacePushConfig.findUnique({
      where: { workspaceId },
    });
    return row ? toView(row) : null;
  }

  async set(
    workspaceId: string,
    dto: PutPushConfigDto,
    updatedBy: string,
  ): Promise<PushConfigView> {
    const data = {
      targetListId: dto.targetListId,
      targetListName: dto.targetListName ?? null,
      assignableMembers: dto.assignableMembers as unknown as Prisma.InputJsonValue,
      defaultStatus: dto.defaultStatus ?? null,
      updatedBy,
    };
    const row = await this.prisma.workspacePushConfig.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
    return toView(row);
  }
}

function toView(row: {
  workspaceId: string;
  targetListId: string;
  targetListName: string | null;
  assignableMembers: Prisma.JsonValue;
  defaultStatus: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}): PushConfigView {
  return {
    workspaceId: row.workspaceId,
    targetListId: row.targetListId,
    targetListName: row.targetListName,
    assignableMembers: (row.assignableMembers as unknown as AssignableMember[]) ?? [],
    defaultStatus: row.defaultStatus,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}
