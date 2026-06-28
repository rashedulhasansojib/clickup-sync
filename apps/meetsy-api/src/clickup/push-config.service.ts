import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ClickUpClient } from "./clickup.client";
import { AssignableMember } from "./clickup.types";
import { PutPushConfigDto } from "./clickup.dto";

export interface ClientOption {
  optionId: string;
  name: string;
}
export interface SprintListOption {
  listId: string;
  name: string;
}

export interface PushConfigView {
  workspaceId: string;
  targetListId: string;
  targetListName: string | null;
  assignableMembers: AssignableMember[];
  defaultStatus: string | null;
  // Phase 2c.3 HITL fields.
  clientFieldId: string | null;
  clientFieldName: string | null;
  clientOptions: ClientOption[];
  sprintLists: SprintListOption[];
  pointsEnabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Get/set the per-workspace ClickUp write-back config (target list + assignable
 * members + the Phase-2c.3 client/sprint/points field options). Workspace-scoped;
 * the caller resolves/authorizes the workspaceId.
 */
@Injectable()
export class PushConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: ClickUpClient,
  ) {}

  async get(workspaceId: string): Promise<PushConfigView | null> {
    const row = await this.prisma.workspacePushConfig.findUnique({ where: { workspaceId } });
    return row ? toView(row) : null;
  }

  async set(workspaceId: string, dto: PutPushConfigDto, updatedBy: string): Promise<PushConfigView> {
    const data = {
      targetListId: dto.targetListId,
      targetListName: dto.targetListName ?? null,
      assignableMembers: dto.assignableMembers as unknown as Prisma.InputJsonValue,
      defaultStatus: dto.defaultStatus ?? null,
      ...(dto.pointsEnabled !== undefined ? { pointsEnabled: dto.pointsEnabled } : {}),
      updatedBy,
    };
    const row = await this.prisma.workspacePushConfig.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
    return toView(row);
  }

  /**
   * Phase 2c.3 — fetch the live ClickUp field options for the configured target
   * list: the client DROPDOWN custom field (id + its option UUIDs) and the
   * selectable sprint lists (the whole space tree's lists). Persists them on the
   * config so the review screen can offer them. Requires the target list set.
   */
  async refreshFields(workspaceId: string): Promise<PushConfigView> {
    const existing = await this.prisma.workspacePushConfig.findUnique({ where: { workspaceId } });
    if (!existing) throw new BadRequestException("Set a target list first (PUT /push-config).");

    const fields = await this.client.getListCustomFields(workspaceId, existing.targetListId);
    // Prefer a dropdown named like "client"; else the first dropdown field.
    const dropdowns = fields.filter((f) => f.type === "drop_down");
    const clientField = dropdowns.find((f) => /client/i.test(f.name)) ?? dropdowns[0] ?? null;

    const tree = await this.client.getSpaceTree(workspaceId);
    const sprintLists: SprintListOption[] = [];
    for (const space of tree) {
      for (const l of space.lists) sprintLists.push({ listId: l.id, name: l.name });
      for (const folder of space.folders) {
        for (const l of folder.lists) sprintLists.push({ listId: l.id, name: `${folder.name} / ${l.name}` });
      }
    }

    const row = await this.prisma.workspacePushConfig.update({
      where: { workspaceId },
      data: {
        clientFieldId: clientField?.id ?? null,
        clientFieldName: clientField?.name ?? null,
        clientOptions: (clientField?.options.map((o) => ({ optionId: o.id, name: o.name })) ??
          []) as unknown as Prisma.InputJsonValue,
        sprintLists: sprintLists as unknown as Prisma.InputJsonValue,
      },
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
  clientFieldId: string | null;
  clientFieldName: string | null;
  clientOptions: Prisma.JsonValue;
  sprintLists: Prisma.JsonValue;
  pointsEnabled: boolean;
  updatedAt: Date;
  updatedBy: string | null;
}): PushConfigView {
  return {
    workspaceId: row.workspaceId,
    targetListId: row.targetListId,
    targetListName: row.targetListName,
    assignableMembers: (row.assignableMembers as unknown as AssignableMember[]) ?? [],
    defaultStatus: row.defaultStatus,
    clientFieldId: row.clientFieldId,
    clientFieldName: row.clientFieldName,
    clientOptions: (row.clientOptions as unknown as ClientOption[]) ?? [],
    sprintLists: (row.sprintLists as unknown as SprintListOption[]) ?? [],
    pointsEnabled: row.pointsEnabled,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}
