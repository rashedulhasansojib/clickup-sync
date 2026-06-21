import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { WorkspaceService } from './workspace.service';

/**
 * Read-only workspace list for the dashboard switcher. NOT role-gated (no
 * @Roles) so every authenticated user — including read-only Members — can list
 * the workspaces they may view and switch between. Returns no secrets; the
 * OWNER/ADMIN-only connection management lives on /admin/workspaces.
 */
@ApiTags('workspaces')
@ApiSecurity('x-admin-key')
@Controller('workspaces')
export class WorkspaceController {
  constructor(private readonly workspaces: WorkspaceService) {}

  @Get()
  @ApiOperation({ summary: 'List connected workspaces (id, name, spaces) for the dashboard switcher.' })
  list() {
    return { workspaces: this.workspaces.listForSwitcher() };
  }
}
