import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { BudgetsService } from '../budgets/budgets.service';
import { SettingsService } from '../settings/settings.service';
import { WorkspaceService } from '../workspaces/workspace.service';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@ApiSecurity('x-admin-key')
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly settings: SettingsService,
    private readonly budgets: BudgetsService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Get('tasks/summary')
  @ApiOperation({ summary: 'Task count summary by space and status' })
  tasksSummary(@Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.tasksSummary(wsId);
  }

  @Get('tasks/by-space-status')
  @ApiOperation({ summary: 'Task counts grouped by space+status for stacked bar chart' })
  tasksBySpaceStatus(@Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.tasksBySpaceStatus(wsId);
  }

  @Get('tasks/assignees')
  @ApiOperation({ summary: 'Distinct task assignees for the Tasks page filter dropdown. Drawn from clickup_tasks.assignees_names so assignees with zero time entries (e.g. expense-only tasks) still appear.' })
  tasksAssignees(@Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.tasksAssignees(wsId);
  }

  @Get('time-entries/assignees')
  @ApiOperation({ summary: 'Distinct assignees that have time entries. Feeds the exclude-from-costing picker.' })
  timeEntriesAssignees(@Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.timeEntriesAssignees(wsId);
  }

  @Get('clients')
  @ApiOperation({ summary: 'Distinct task clients for the Tasks and Time Entries page filter dropdowns. Drawn from clickup_tasks.client (non-empty, non-deleted), with per-client task counts.' })
  tasksClients(@Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.tasksClients(wsId);
  }

  @Get('lists')
  @ApiOperation({ summary: 'Distinct ClickUp lists for the Tasks and Time Entries page filter dropdowns. Drawn from clickup_tasks (list_id/list_name, non-empty, non-deleted) with per-list task counts. Pass spaceId to scope to one space.' })
  tasksLists(@Query('spaceId') spaceId?: string, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.tasksLists(wsId, spaceId);
  }

  @Get('folders')
  @ApiOperation({ summary: 'Distinct ClickUp folders for the Tasks and Time Entries page filter dropdowns. Drawn from clickup_tasks (folder_id/folder_name, non-empty, non-deleted) with per-folder task counts. Pass spaceId to scope to one space.' })
  tasksFolders(@Query('spaceId') spaceId?: string, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.tasksFolders(wsId, spaceId);
  }

  @Get('tasks')
  @ApiOperation({ summary: 'Paginated task list with filters. `archived`: exclude (default, hide archived) | include | only (archived tasks). Soft-deleted rows are always excluded.' })
  tasks(
    @Query('spaceId') spaceId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('priority') priority?: string,
    @Query('assigneeId') assigneeId?: string,
    @Query('type') type?: string,
    @Query('archived') archived?: string,
    @Query('client') client?: string,
    @Query('taskIds') taskIds?: string,
    @Query('listId') listId?: string,
    @Query('folderId') folderId?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.tasks(wsId, spaceId, status, search, from, to, Number(limit) || 50, Number(offset) || 0, priority, assigneeId, type, archived, client, taskIds, listId, folderId);
  }

  @Get('anomalies')
  @ApiOperation({ summary: 'Spend-spike anomalies for the Overview panel — daily totals and per-client weekly totals exceeding their median baselines.' })
  anomalies(@Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.anomalies(wsId);
  }

  @Get('time-entries/hour-spikes')
  @ApiOperation({ summary: "Per-user daily-hour spikes: a team watchlist of days exceeding the absolute cap or 2x the user's median over the selected window (min 14 days), plus per-user daily-hours series for the chart. Supports limit + includeResolved." })
  hourSpikes(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('includeResolved') includeResolved?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.hourSpikes(wsId, this.workspaces.getSpikeHoursCap(wsId), from, to, Number(limit) || 20, includeResolved === 'true');
  }

  @Get('time-entries/by-user')
  @ApiOperation({ summary: 'Total hours and cost per assignee' })
  timeEntriesByUser(@Query('from') from?: string, @Query('to') to?: string, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.timeEntriesByUser(wsId, from, to);
  }

  @Get('time-entries/by-client')
  @ApiOperation({ summary: 'Total hours and cost per client' })
  timeEntriesByClient(@Query('from') from?: string, @Query('to') to?: string, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.timeEntriesByClient(wsId, from, to);
  }

  @Get('time-entries/by-department')
  @ApiOperation({ summary: 'Total hours and cost per department' })
  timeEntriesByDepartment(@Query('from') from?: string, @Query('to') to?: string, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.timeEntriesByDepartment(wsId, from, to);
  }

  @Get('time-entries/billable-summary')
  @ApiOperation({ summary: 'Billable vs non-billable hours and cost' })
  timeEntriesBillableSummary(@Query('from') from?: string, @Query('to') to?: string, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.timeEntriesBillableSummary(wsId, from, to);
  }

  @Get('time-entries/aggregates')
  @ApiOperation({ summary: 'Server-side aggregates for the Time Entries page metric cards. Accepts the same filters as /time-entries.' })
  timeEntriesAggregates(
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('billable') billable?: string,
    @Query('search') search?: string,
    @Query('spaceId') spaceId?: string,
    @Query('missingOnly') missingOnly?: string,
    @Query('client') client?: string,
    @Query('listId') listId?: string,
    @Query('folderId') folderId?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.timeEntriesAggregates(wsId, userId, from, to, status, billable, search, spaceId, missingOnly, client, listId, folderId);
  }

  @Get('time-entries/cost-trend')
  @ApiOperation({ summary: 'Time-bucketed cost trend for the Overview chart. bucket=day|week|month; defaults vary by bucket if from/to are omitted.' })
  costTrend(
    @Query('bucket') bucket?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    if (bucket !== 'day' && bucket !== 'week' && bucket !== 'month') {
      throw new BadRequestException(`Invalid bucket "${bucket ?? ''}" (expected day|week|month)`);
    }
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.costTrend(wsId, bucket, from, to);
  }

  @Get('time-entries/cost-trend-by-assignee')
  @ApiOperation({ summary: 'Time-bucketed labor cost split by assignee for the stacked Assignee cost trend chart. bucket=day|week|month; every assignee is returned as its own segment, ordered by total cost (highest first).' })
  costTrendByAssignee(
    @Query('bucket') bucket?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    if (bucket !== 'day' && bucket !== 'week' && bucket !== 'month') {
      throw new BadRequestException(`Invalid bucket "${bucket ?? ''}" (expected day|week|month)`);
    }
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.costTrendByAssignee(wsId, bucket, from, to);
  }

  @Get('time-entries/cost-trend-by-client')
  @ApiOperation({ summary: 'Time-bucketed labor cost split by client for the stacked bar view of the Client cost trend chart. bucket=day|week|month; every client is returned as its own segment, ordered by total cost (highest first). Tasks with no client are grouped under "No client".' })
  costTrendByClient(
    @Query('bucket') bucket?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    if (bucket !== 'day' && bucket !== 'week' && bucket !== 'month') {
      throw new BadRequestException(`Invalid bucket "${bucket ?? ''}" (expected day|week|month)`);
    }
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.costTrendByClient(wsId, bucket, from, to);
  }

  @Get('budgets/status')
  @ApiOperation({ summary: 'Per-client monthly budget vs actual + month-end forecast. ?month=YYYY-MM (defaults to current Dhaka month).' })
  budgetStatus(@Query('month') month?: string) {
    return this.budgets.clientBudgetStatus({ month });
  }

  @Get('overview-deltas')
  @ApiOperation({ summary: 'Current-period totals (hours, cost) and equal-length prior-period totals for the Overview KPI deltas.' })
  overviewDeltas(@Query('from') from?: string, @Query('to') to?: string, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.overviewDeltas(wsId, from, to);
  }

  @Get('time-entries')
  @ApiOperation({ summary: 'Paginated time entry list (userId, from, to, status, billable, search, spaceId, missingOnly)' })
  timeEntriesList(
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('billable') billable?: string,
    @Query('search') search?: string,
    @Query('spaceId') spaceId?: string,
    @Query('missingOnly') missingOnly?: string,
    @Query('client') client?: string,
    @Query('listId') listId?: string,
    @Query('folderId') folderId?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.timeEntriesList(
      wsId, userId, from, to, status, Number(limit) || 50, Number(offset) || 0, billable, search, spaceId, missingOnly, client, listId, folderId,
    );
  }

  @Get('sprint-points')
  @ApiOperation({ summary: 'Sprint points by space and status' })
  sprintPoints(@Query('spaceId') spaceId?: string, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.sprintPoints(wsId, spaceId);
  }

  @Get('ops/sync-health')
  @ApiOperation({ summary: 'Sync checkpoint freshness per space (Fresh / Stale / Unknown)' })
  syncHealth(@Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.syncHealth(wsId);
  }

  @Get('ops/webhook-events')
  @ApiOperation({ summary: 'Recent webhook events with optional filters (status, eventType, search)' })
  webhookEvents(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('status') status?: string,
    @Query('eventType') eventType?: string,
    @Query('search') search?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.webhookEvents(wsId, Number(limit) || 50, Number(offset) || 0, status, eventType, search);
  }

  @Get('ops/job-logs')
  @ApiOperation({ summary: 'Sync job logs with optional filters (queueName, status)' })
  jobLogs(
    @Query('queueName') queueName?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.jobLogs(wsId, queueName, status, Number(limit) || 50, Number(offset) || 0);
  }

  @Get('ops/dead-letters')
  @ApiOperation({ summary: 'Pending dead-letter jobs' })
  deadLetters(@Query('limit') limit?: string, @Query('offset') offset?: string, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.deadLetters(wsId, Number(limit) || 50, Number(offset) || 0);
  }

  @Get('ops/stats')
  @ApiOperation({ summary: 'Dashboard overview stats (failures, dead-letters, webhooks, missing rates)' })
  stats(@Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.stats(wsId, [...this.settings.getExcludedAssigneeIds()]);
  }

  @Get('ops/missing-rates')
  @ApiOperation({ summary: 'Assignees with NO_RATE_FOUND time entries, grouped by user' })
  missingRates(@Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.missingRates(wsId, [...this.settings.getExcludedAssigneeIds()]);
  }

  @Get('spaces')
  @ApiOperation({ summary: 'Per-space task, hour, and cost aggregates' })
  spaces(@Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    return this.reports.spaces(wsId);
  }

  @Get('cycle-time')
  @ApiOperation({ summary: 'Cycle-time aggregates (first open → last done) bucketed by week, client, or department.' })
  cycleTime(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    const groupByVal = groupBy === 'client' || groupBy === 'department' ? groupBy : 'week';
    const fromDate = from ? new Date(from) : new Date(Date.now() - 90 * 86400000);
    const toDate = to ? new Date(to) : new Date();
    return this.reports.cycleTime(wsId, { from: fromDate, to: toDate, groupBy: groupByVal });
  }

  @Get('time-in-status')
  @ApiOperation({ summary: 'Total hours each task spent in each status, over the window.' })
  timeInStatus(@Query('from') from?: string, @Query('to') to?: string, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    const fromDate = from ? new Date(from) : new Date(Date.now() - 90 * 86400000);
    const toDate = to ? new Date(to) : new Date();
    return this.reports.timeInStatus(wsId, { from: fromDate, to: toDate });
  }
}
