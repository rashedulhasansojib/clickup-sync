import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { WorkspaceResolver } from "../../analysis/workspace.resolver";

export interface DeadLetterEntry {
  id: string;
  runId: string;
  meetsyTaskId: string;
  jobId: string;
  errorMessage: string | null;
  attemptsMade: number;
  failedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface DeadLetterList {
  items: DeadLetterEntry[];
  total: number;
}

/**
 * v2 Phase 2 (PR-I) — Owner/Admin-only surface for permanently-failed pushes.
 * List is filtered to unresolved rows by default (`includeResolved=true` opts
 * in). Resolve is a hand-marked ACK: no re-enqueue path yet (Phase 4 polish).
 */
@Injectable()
export class PushDeadLetterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  async list(
    orgId: string,
    workspaceIdParam: string,
    opts: { limit: number; offset: number; includeResolved?: boolean },
  ): Promise<DeadLetterList> {
    const workspaceId = await this.workspaces.resolve(orgId, workspaceIdParam);
    const where = {
      workspaceId,
      ...(opts.includeResolved ? {} : { resolvedAt: null }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.pushDeadLetter.findMany({
        where,
        orderBy: { failedAt: "desc" },
        take: opts.limit,
        skip: opts.offset,
      }),
      this.prisma.pushDeadLetter.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        runId: r.runId,
        meetsyTaskId: r.meetsyTaskId,
        jobId: r.jobId,
        errorMessage: r.errorMessage,
        attemptsMade: r.attemptsMade,
        failedAt: r.failedAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolvedBy: r.resolvedBy,
      })),
      total,
    };
  }

  async resolve(
    orgId: string,
    workspaceIdParam: string,
    deadLetterId: string,
    userId: string,
  ): Promise<{ id: string; resolvedAt: string }> {
    const workspaceId = await this.workspaces.resolve(orgId, workspaceIdParam);
    const row = await this.prisma.pushDeadLetter.findUnique({
      where: { id: deadLetterId },
    });
    if (!row || row.workspaceId !== workspaceId) {
      throw new NotFoundException(`Dead-letter row ${deadLetterId} not found`);
    }
    const updated = await this.prisma.pushDeadLetter.update({
      where: { id: deadLetterId },
      data: { resolvedAt: new Date(), resolvedBy: userId },
    });
    return { id: updated.id, resolvedAt: updated.resolvedAt!.toISOString() };
  }
}
