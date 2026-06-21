import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { WorkspaceMembersService, type MemberDto } from './workspace-members.service';
import { WorkspaceService } from '../workspaces/workspace.service';

@ApiTags('clickup')
@ApiSecurity('x-admin-key')
@Controller('clickup')
export class ClickupMembersController {
  constructor(
    private readonly members: WorkspaceMembersService,
    private readonly workspaces: WorkspaceService,
  ) {}

  // Deliberately NOT role-gated: every authenticated user (including read-only
  // MEMBERs) renders ClickUp avatars across time entries, tasks, and rates, so
  // all roles need this. `email` is included on purpose — it is the join key for
  // task assignees, which are stored only as names+emails with no ClickUp id.
  // These same member emails are already visible to MEMBERs via the tasks and
  // time-entries endpoints, so this exposes nothing new in this internal app.
  @Get('members')
  @ApiOperation({ summary: 'Workspace member directory (id, name, email, profilePicture) for rendering avatars. Cached ~10 min.' })
  list(@Query('workspaceId') workspaceId?: string): Promise<MemberDto[]> {
    return this.members.getDirectory(this.workspaces.resolveWorkspaceId(workspaceId));
  }
}
