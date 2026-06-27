import { Controller, Get } from "@nestjs/common";
import type { AuthPrincipal } from "@clicksy/shared";
import { CurrentUser } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";

export interface WorkspaceListItem {
  id: string;
  name: string;
  isDefault: boolean;
}

/**
 * Lists the org's workspaces (read-only mirror of `public.workspaces`) so the
 * Meetsy UI can pick which workspace to configure push for. Default workspace
 * first. Any authenticated user.
 */
@Controller("workspaces")
export class WorkspacesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() user: AuthPrincipal): Promise<WorkspaceListItem[]> {
    const rows = await this.prisma.workspace.findMany({
      where: user.orgId ? { orgId: user.orgId } : {},
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true, isDefault: true },
    });
    return rows.map((w) => ({ id: w.id, name: w.name, isDefault: w.isDefault }));
  }
}
