import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Resolves the workspace a request operates on, mirroring Clicksy's `?workspaceId=`
 * convention with a default-workspace fallback. Reads the `public.workspaces`
 * read-model (read-only). Phase 0 only needs this to satisfy the new non-null
 * `workspaceId` columns; the full per-endpoint wiring lands in a later sub-step.
 *
 * TODO(phase1): thread `?workspaceId=` through every analysis endpoint and scope
 * all reads/writes by it (+ orgId) for defense-in-depth, instead of only at
 * meeting creation.
 */
@Injectable()
export class WorkspaceResolver {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns a concrete workspaceId. If the caller passed one, it must exist (and,
   * when the principal carries an org, belong to it). Otherwise falls back to the
   * org's default workspace (`is_default = true`).
   */
  async resolve(orgId: string, requested?: string): Promise<string> {
    if (requested) {
      const ws = await this.prisma.workspace.findUnique({ where: { id: requested } });
      if (!ws) throw new NotFoundException(`Workspace ${requested} not found`);
      if (orgId && ws.orgId !== orgId) {
        throw new BadRequestException(`Workspace ${requested} is not in this org`);
      }
      return ws.id;
    }
    const def = await this.prisma.workspace.findFirst({
      where: { isDefault: true, ...(orgId ? { orgId } : {}) },
      orderBy: { id: "asc" },
    });
    if (!def) throw new NotFoundException("No default workspace configured");
    return def.id;
  }
}
