import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Logger, NotFoundException, Param, Patch, Post, Put, Query, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles, CurrentUser } from '../auth/decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { AuditLogInterceptor } from './audit-log.interceptor';
import { AuditLogRepository } from './audit-log.repository';
import { SyncTaskDto } from './dto/sync-task.dto';
import { BackfillDto } from './dto/backfill.dto';
import { CommentsBackfillDto } from './dto/comments-backfill.dto';
import { BackfillReplacementDto } from './dto/backfill-replacement.dto';
import { CreateRateDto } from './dto/create-rate.dto';
import { UpdateRateDto } from './dto/update-rate.dto';
import { UpdateExcludedAssigneesDto } from './dto/update-excluded-assignees.dto';
import { CreateTagAssigneeDto } from './dto/create-tag-assignee.dto';
import { UpdateTagAssigneeDto } from './dto/update-tag-assignee.dto';
import { CreateClientBudgetDto } from './dto/create-client-budget.dto';
import { UpdateClientBudgetDto } from './dto/update-client-budget.dto';
import { BudgetsRepository } from '../budgets/budgets.repository';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { NotifySpikeDto } from './dto/notify-spike.dto';
import { ResolveSpikeDto, UnresolveSpikeDto } from './dto/resolve-spike.dto';
import { SpikeNotificationService } from './spike-notification.service';
import { SpikeResolutionService } from './spike-resolution.service';
import { SearchRepository } from './search.repository';
import { TaskHistoryRepository } from './task-history.repository';
import { SettingsService } from '../settings/settings.service';
import { WorkspaceService } from '../workspaces/workspace.service';
import { CreateWorkspaceDto, UpdateWorkspaceDto, UpsertWorkspaceSpaceDto } from './dto/workspace.dto';
import { QueueService } from '../queues/queue.service';
import { JOBS, QUEUES } from '../queues/queue.constants';
import { replacementJobId } from '../time-entries/assignee-replacement.service';
import { PrismaService } from '../database/prisma.service';
import { DeadLetterRepository } from '../jobs/dead-letter.repository';
import { ClickupClient } from '../clickup/clickup.client';
import { ClickupWebhooksService } from '../clickup/clickup-webhooks.service';
import { WebhookEventsRepository } from '../webhooks/webhook-events.repository';
import { WebhookParserService } from '../webhooks/webhook-parser.service';
import { TimeEntriesRepository } from '../time-entries/time-entries.repository';
import { RatesRepository } from '../rates/rates.repository';
import { TagAssigneeMapRepository } from '../time-entries/tag-assignee-map.repository';
import { TasksRepository } from '../tasks/tasks.repository';
import { RatesService } from '../rates/rates.service';
import { subtractDays } from '../common/utils/date-utils';

function parseId(id: string): bigint {
  const n = BigInt(id);
  return n;
}

const COMMENT_BACKFILL_RECENT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * BullMQ priority for a comment-backfill job (lower = sooner). The KB gets the
 * comments that matter first: open/in-progress tasks (status not closed/done)
 * rank highest, then recently-updated tasks, then everything else.
 */
function commentBackfillPriority(task: { statusType: string | null; updatedDate: Date | null }): number {
  const st = (task.statusType ?? '').toLowerCase();
  const closed = st === 'closed' || st === 'done';
  if (!closed) return 1;
  const updatedMs = task.updatedDate?.getTime() ?? 0;
  if (Date.now() - updatedMs < COMMENT_BACKFILL_RECENT_MS) return 2;
  return 3;
}

/**
 * Attribution label for `updatedBy` derived from the authenticated session —
 * not the previously-spoofable `x-admin-user` header. Machine (admin-key)
 * principals have no email, so fall back to a stable machine label.
 */
function actorLabel(user: AuthPrincipal): string {
  return user?.email ?? (user?.isMachine ? 'machine-key' : user?.userId) ?? 'unknown';
}

@ApiTags('admin')
@ApiSecurity('x-admin-key')
@Roles(Role.OWNER, Role.ADMIN)
@UseInterceptors(AuditLogInterceptor)
@Controller('admin')
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly queues: QueueService,
    private readonly deadLetters: DeadLetterRepository,
    private readonly clickup: ClickupClient,
    private readonly webhooks: ClickupWebhooksService,
    private readonly timeEntriesRepo: TimeEntriesRepository,
    private readonly ratesRepo: RatesRepository,
    private readonly budgetsRepo: BudgetsRepository,
    private readonly tagAssigneeRepo: TagAssigneeMapRepository,
    private readonly tasksRepo: TasksRepository,
    private readonly ratesService: RatesService,
    private readonly webhookEvents: WebhookEventsRepository,
    private readonly webhookParser: WebhookParserService,
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogRepository,
    private readonly settings: SettingsService,
    private readonly workspaces: WorkspaceService,
    private readonly spikeNotifications: SpikeNotificationService,
    private readonly spikeResolutions: SpikeResolutionService,
    private readonly searchRepo: SearchRepository,
    private readonly taskHistoryRepo: TaskHistoryRepository,
  ) {}

  @Get('ping')
  @ApiOperation({ summary: 'Validate admin key' })
  ping() {
    return { ok: true };
  }

  @Get('search')
  @ApiOperation({ summary: 'Quick search across tasks and assignees (command palette).' })
  search(@Query('q') q = '') {
    return this.searchRepo.search(q);
  }

  @Get('workspace-members')
  @ApiOperation({ summary: 'List ClickUp workspace members' })
  async listWorkspaceMembers(@Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    const members = await this.clickup.getTeamMembers(wsId);
    return members.map((m) => ({
      id: String(m.user.id),
      name: m.user.username ?? null,
      email: m.user.email ?? null,
    }));
  }

  // ── Workspaces CRUD (multi-workspace connections) ───────────────────────────

  @Get('workspaces')
  @ApiOperation({ summary: 'List connected ClickUp workspaces (secrets masked)' })
  listWorkspaces() {
    return { workspaces: this.workspaces.listMasked(), encryptionEnabled: this.workspaces.encryptionEnabled() };
  }

  @Post('workspaces')
  @Roles(Role.OWNER)
  @HttpCode(201)
  @ApiOperation({ summary: 'Connect a new ClickUp workspace' })
  createWorkspace(@Body() dto: CreateWorkspaceDto, @CurrentUser() user: AuthPrincipal) {
    return this.workspaces.createWorkspace(dto, actorLabel(user));
  }

  @Patch('workspaces/:id')
  @Roles(Role.OWNER)
  @HttpCode(200)
  @ApiOperation({ summary: 'Update a workspace connection (token written only when supplied)' })
  updateWorkspace(@Param('id') id: string, @Body() dto: UpdateWorkspaceDto, @CurrentUser() user: AuthPrincipal) {
    return this.workspaces.updateWorkspace(id, dto, actorLabel(user));
  }

  @Delete('workspaces/:id')
  @Roles(Role.OWNER)
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove a workspace connection (refuses if it still owns synced data)' })
  async deleteWorkspace(@Param('id') id: string) {
    await this.workspaces.deleteWorkspace(id);
    return { deleted: true, id };
  }

  @Get('workspaces/:id/clickup-spaces')
  @ApiOperation({ summary: "Fetch the workspace's spaces from ClickUp (for the 'Discover spaces' picker). Flags which are already configured." })
  async listClickupSpaces(@Param('id') id: string) {
    if (!this.workspaces.hasWorkspace(id)) throw new BadRequestException(`Unknown workspace: ${id}`);
    const spaces = await this.clickup.listSpaces(id);
    const configured = new Set(this.workspaces.getSpaces(id).map((s) => s.spaceId));
    return { spaces: spaces.map((s) => ({ ...s, configured: configured.has(s.id) })) };
  }

  @Post('workspaces/:id/spaces')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add or update a ClickUp space scope on a workspace' })
  upsertWorkspaceSpace(@Param('id') id: string, @Body() dto: UpsertWorkspaceSpaceDto) {
    return this.workspaces.upsertSpace(id, dto.spaceId, { name: dto.name, backfillLookbackDays: dto.backfillLookbackDays, enabled: dto.enabled });
  }

  @Delete('workspaces/:id/spaces/:spaceId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove a ClickUp space scope from a workspace' })
  deleteWorkspaceSpace(@Param('id') id: string, @Param('spaceId') spaceId: string) {
    return this.workspaces.deleteSpace(id, spaceId);
  }

  @Get('hour-spikes/:userId/:date/preview')
  @ApiOperation({ summary: "Preview a spike notice: the member's per-task breakdown for that Dhaka-local day, recipient email, and whether they've already been notified." })
  previewSpikeNotice(@Param('userId') userId: string, @Param('date') date: string, @Query('workspaceId') workspaceId?: string) {
    return this.spikeNotifications.preview(this.workspaces.resolveWorkspaceId(workspaceId), userId, date);
  }

  // 200, not 201: this is an action endpoint (send the notice) like the other
  // action POSTs in this controller (sync/backfill/retry); the recorded row is
  // a side-effect, not the returned resource.
  @Post('hour-spikes/notify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email a flagged member their spike-day task breakdown (+ optional note) and record the send. 409 if already notified for that day.' })
  notifySpike(@Body() dto: NotifySpikeDto, @CurrentUser() user: AuthPrincipal, @Query('workspaceId') workspaceId?: string) {
    return this.spikeNotifications.notify({
      workspaceId: this.workspaces.resolveWorkspaceId(workspaceId),
      userId: dto.userId,
      date: dto.date,
      rule: dto.rule,
      median: dto.median,
      note: dto.note,
      sentBy: actorLabel(user),
    });
  }

  @Post('hour-spikes/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark a flagged spike day as resolved so it drops out of the watchlist. Idempotent.' })
  resolveSpike(@Body() dto: ResolveSpikeDto, @CurrentUser() user: AuthPrincipal, @Query('workspaceId') workspaceId?: string) {
    return this.spikeResolutions.resolve({
      workspaceId: this.workspaces.resolveWorkspaceId(workspaceId),
      userId: dto.userId,
      date: dto.date,
      userName: dto.userName,
      note: dto.note,
      resolvedBy: actorLabel(user),
    });
  }

  @Delete('hour-spikes/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Un-resolve a spike day so it reappears in the watchlist. No-op if not resolved.' })
  unresolveSpike(@Body() dto: UnresolveSpikeDto, @Query('workspaceId') workspaceId?: string) {
    return this.spikeResolutions.unresolve({ workspaceId: this.workspaces.resolveWorkspaceId(workspaceId), userId: dto.userId, date: dto.date });
  }

  @Post('tasks/sync')
  @HttpCode(200)
  @ApiOperation({ summary: 'Manually trigger a single ClickUp task sync' })
  syncTask(@Body() dto: SyncTaskDto, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    this.queues.get(QUEUES.CLICKUP_TASKS).add(JOBS.SYNC_CLICKUP_TASK, { workspaceId: wsId, taskId: dto.taskId }, this.queues.defaultJobOptions());
    return { queued: true, taskId: dto.taskId };
  }

  @Post('time-entries/sync-task')
  @HttpCode(200)
  @ApiOperation({ summary: 'Enqueue a time-entry sync for a single task. Useful for clearing stuck FK-failed jobs after the task row is present.' })
  syncTaskTimeEntries(@Body() dto: SyncTaskDto, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    this.queues.get(QUEUES.CLICKUP_TIME_ENTRIES).add(
      JOBS.SYNC_TASK_TIME_ENTRIES,
      { workspaceId: wsId, taskId: dto.taskId },
      this.queues.defaultJobOptions(),
    );
    return { queued: true, taskId: dto.taskId, queue: QUEUES.CLICKUP_TIME_ENTRIES };
  }

  // ── ClickUp comment sync (opt-in; NOT part of the hourly reconcile) ──────────

  @Post('comments/sync-task')
  @HttpCode(200)
  @ApiOperation({ summary: 'Enqueue a comment sync for a single task (re-fetch + idempotent upsert into clickup_task_comments).' })
  syncTaskComments(@Body() dto: SyncTaskDto, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    this.queues.get(QUEUES.CLICKUP_COMMENTS).add(
      JOBS.SYNC_TASK_COMMENTS,
      { workspaceId: wsId, taskId: dto.taskId },
      this.queues.defaultJobOptions(),
    );
    return { queued: true, taskId: dto.taskId, queue: QUEUES.CLICKUP_COMMENTS };
  }

  @Post('comments/backfill')
  @HttpCode(200)
  @ApiOperation({ summary: "Enqueue prioritized comment-sync jobs for every known task in a space (open/in-progress first). Opt-in history backfill — comments are NOT fetched by the hourly sweep." })
  async backfillComments(@Body() dto: CommentsBackfillDto, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    const space = this.workspaces.getSpace(wsId, dto.spaceId);
    if (!space && !dto.allowUnknownSpaces) {
      const valid = this.workspaces.getSpaces(wsId).map((s) => s.spaceId).join(', ');
      throw new BadRequestException(`Unknown spaceId: ${dto.spaceId} for this workspace. Valid: ${valid || '(none)'}. Pass allowUnknownSpaces: true to override.`);
    }
    // Enqueue one comment-sync job per known (non-deleted) task in the space,
    // prioritized by task value so the comments that matter drain first. The
    // jobs are idempotent (re-fetch + upsert), so re-running is safe.
    const tasks = await this.prisma.clickupTask.findMany({
      where: { workspaceId: wsId, spaceId: dto.spaceId, isDeleted: false },
      select: { taskId: true, statusType: true, updatedDate: true },
    });
    const queue = this.queues.get(QUEUES.CLICKUP_COMMENTS);
    const jobOpts = this.queues.defaultJobOptions();
    for (const task of tasks) {
      await queue.add(
        JOBS.SYNC_TASK_COMMENTS,
        { workspaceId: wsId, taskId: task.taskId },
        { ...jobOpts, priority: commentBackfillPriority(task) },
      );
    }
    return { queued: tasks.length, spaceId: dto.spaceId };
  }

  @Post('backfill')
  @HttpCode(200)
  @ApiOperation({ summary: 'Trigger a space backfill' })
  backfill(@Body() dto: BackfillDto, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    const space = this.workspaces.getSpace(wsId, dto.spaceId);
    if (!space && !dto.allowUnknownSpaces) {
      const valid = this.workspaces.getSpaces(wsId).map((s) => s.spaceId).join(', ');
      throw new BadRequestException(`Unknown spaceId: ${dto.spaceId} for this workspace. Valid: ${valid || '(none)'}. Pass allowUnknownSpaces: true to override.`);
    }
    // The DTO only enforces the absolute 3650-day backstop; the effective cap is
    // the configurable per-workspace Sync value, enforced here at request time.
    const cap = this.workspaces.getBackfillMaxLookbackDays(wsId);
    if (dto.lookbackDays != null && dto.lookbackDays > cap) {
      throw new BadRequestException(`lookbackDays ${dto.lookbackDays} exceeds the configured maximum ${cap}. Raise it in Settings → Sync.`);
    }
    const lookbackDays = dto.lookbackDays ?? space?.backfillLookbackDays ?? 30;
    this.queues.get(QUEUES.CLICKUP_BACKFILLS).add(JOBS.BACKFILL_CLICKUP_SPACE, { workspaceId: wsId, spaceId: dto.spaceId, lookbackDays }, this.queues.defaultJobOptions());
    return { queued: true, spaceId: dto.spaceId, lookbackDays };
  }

  /**
   * Live per-space sync status, driven by BullMQ queue depth (which survives
   * page reloads, unlike the client's `useState` that used to track this).
   *
   * `phase`:
   *   - `fetching`     → backfill worker is still scanning ClickUp tasks (no
   *                      `total` known yet, render as indeterminate).
   *   - `time-entries` → backfill done; time-entry workers are draining N
   *                      per-task jobs in parallel. `total` is the most-recent
   *                      completed backfill's `tasks_synced`. `done = total -
   *                      remaining` (clamped ≥ 0 so webhook-driven drains
   *                      that outrun the original backfill don't display
   *                      negative progress).
   *
   * Webhook-driven time-entry jobs that happen to land in the same window
   * get attributed to the most recent backfill on that space — acceptable
   * noise for an admin progress bar, and only inside a 1-hour lookback so a
   * long-quiescent space isn't misattributed.
   */
  @Get('backfill/active')
  @ApiOperation({ summary: 'Live per-space sync progress (queued + active jobs, with totals from the most recent backfill)' })
  async backfillActive(@Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    const wsOf = (data: unknown) => (data as { workspaceId?: string } | undefined)?.workspaceId;
    const [allBackfillJobs, allTimeEntryJobs] = await Promise.all([
      this.queues.get(QUEUES.CLICKUP_BACKFILLS).getJobs(['active', 'waiting', 'delayed', 'prioritized']),
      this.queues.get(QUEUES.CLICKUP_TIME_ENTRIES).getJobs(['active', 'waiting', 'delayed', 'prioritized']),
    ]);
    // Scope progress to the active workspace.
    const backfillJobs = allBackfillJobs.filter((j) => wsOf(j.data) === wsId);
    const timeEntryJobs = allTimeEntryJobs.filter((j) => wsOf(j.data) === wsId);

    const fetchingSpaceIds = new Set<string>();
    for (const job of backfillJobs) {
      const sid = (job.data as { spaceId?: string } | undefined)?.spaceId;
      if (sid) fetchingSpaceIds.add(sid);
    }

    const taskIds = [...new Set(
      timeEntryJobs
        .map((j) => (j.data as { taskId?: string } | undefined)?.taskId)
        .filter((v): v is string => typeof v === 'string'),
    )];
    const taskSpaceRows = taskIds.length > 0
      ? await this.prisma.clickupTask.findMany({
          where: { workspaceId: wsId, taskId: { in: taskIds } },
          select: { taskId: true, spaceId: true },
        })
      : [];
    const taskToSpace = new Map<string, string | null>(taskSpaceRows.map((r) => [r.taskId, r.spaceId]));
    const remainingBySpace = new Map<string, number>();
    for (const job of timeEntryJobs) {
      const taskId = (job.data as { taskId?: string } | undefined)?.taskId;
      if (!taskId) continue;
      const sid = taskToSpace.get(taskId);
      if (!sid) continue;
      remainingBySpace.set(sid, (remainingBySpace.get(sid) ?? 0) + 1);
    }

    const activeSpaceIds = new Set<string>([...fetchingSpaceIds, ...remainingBySpace.keys()]);
    if (activeSpaceIds.size === 0) return { spaces: [] };

    // Pull the most-recent completed backfill per active space — gives us the
    // `tasks_synced` total for the progress bar denominator.
    const recentBackfills = await this.prisma.syncJobLog.findMany({
      where: {
        workspaceId: wsId,
        queueName: QUEUES.CLICKUP_BACKFILLS,
        entityType: 'space',
        entityId: { in: [...activeSpaceIds] },
        status: 'completed',
        finishedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
      orderBy: { finishedAt: 'desc' },
      select: { entityId: true, tasksSynced: true, finishedAt: true },
    });
    const recentTotalBySpace = new Map<string, number>();
    for (const row of recentBackfills) {
      if (!row.entityId || recentTotalBySpace.has(row.entityId)) continue;
      if (row.tasksSynced != null) recentTotalBySpace.set(row.entityId, row.tasksSynced);
    }

    const spaces = [...activeSpaceIds].map((spaceId) => {
      const remaining = remainingBySpace.get(spaceId) ?? 0;
      if (fetchingSpaceIds.has(spaceId)) {
        return { spaceId, phase: 'fetching' as const, total: null, done: null, remaining };
      }
      // Fall back to `remaining` whenever the recent backfill is missing OR
      // recorded 0 tasks — otherwise progress would be 0/0 (NaN%) or done
      // would clamp to a permanent 0%.
      const recentTotal = recentTotalBySpace.get(spaceId) ?? 0;
      const total = recentTotal > 0 ? recentTotal : remaining;
      const done = Math.max(0, total - remaining);
      return { spaceId, phase: 'time-entries' as const, total, done, remaining };
    });

    return { spaces };
  }

  @Post('webhooks/register')
  @Roles(Role.OWNER)
  @HttpCode(200)
  @ApiOperation({ summary: 'Register the NestJS webhook with ClickUp for a workspace — idempotent; stores the signing secret encrypted on first creation' })
  async registerWebhook(@CurrentUser() user: AuthPrincipal, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    const result = await this.webhooks.register(wsId, actorLabel(user));
    if (this.workspaces.getSyncPreferences(wsId).backfillOnConnect) {
      try {
        const backfills = this.queues.get(QUEUES.CLICKUP_BACKFILLS);
        for (const space of this.workspaces.getSpaces(wsId)) {
          if (!space.enabled) continue;
          await backfills.add(
            JOBS.BACKFILL_CLICKUP_SPACE,
            { workspaceId: wsId, spaceId: space.spaceId, lookbackDays: space.backfillLookbackDays },
            this.queues.defaultJobOptions(),
          );
        }
      } catch (err) {
        this.logger.error(`backfill-on-connect enqueue failed (webhook still registered): ${(err as Error).message}`);
      }
    }
    return result;
  }

  // ── App-global settings (notifications / cost / failure) ────────────────────

  @Get('settings')
  @ApiOperation({ summary: 'Get app-global preferences + connected workspaces (secrets masked)' })
  getSettings() {
    return {
      ...this.settings.getGlobal(),
      encryptionEnabled: this.workspaces.encryptionEnabled(),
      workspaces: this.workspaces.listMasked(),
    };
  }

  @Patch('settings')
  @Roles(Role.OWNER)
  @HttpCode(200)
  @ApiOperation({ summary: 'Update app-global preferences (notifications / cost / failure).' })
  updateSettings(@Body() dto: UpdateSettingsDto, @CurrentUser() user: AuthPrincipal) {
    return this.settings.update(dto, actorLabel(user));
  }

  @Post('webhooks/retry-failed')
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-enqueue every webhook event with status=failed back onto the clickup-webhooks queue.' })
  async retryFailedWebhooks(@Query('limit') limitParam?: string) {
    const limit = Math.min(Number(limitParam) || 500, 2000);
    const failed = await this.webhookEvents.findFailed(limit);
    let requeued = 0;
    const queue = this.queues.get(QUEUES.CLICKUP_WEBHOOKS);
    for (const row of failed) {
      // Re-parse the raw payload so we pick up any parser improvements made
      // since the event was first received — and so we don't have to
      // shape-match what the worker expects in two places.
      const parsed = this.webhookParser.parse(row.rawPayload);
      await queue.add(JOBS.PROCESS_CLICKUP_EVENT, { ...parsed, workspaceId: row.workspaceId }, this.queues.webhookJobOptions());
      // Clear the failed marker so this attempt can be observed.
      await this.webhookEvents.markRequeued(row.fingerprint).catch(() => undefined);
      requeued += 1;
    }
    return { requeued, scanned: failed.length, limit };
  }

  @Get('dead-letters')
  @ApiOperation({ summary: 'List unresolved dead-letter jobs' })
  async listDeadLetters(@Query('limit') limit = 50, @Query('offset') offset = 0) {
    const safeLimit = Math.min(Number(limit) || 50, 200);
    const safeOffset = Number(offset) || 0;
    return this.deadLetters.findPending(safeLimit, safeOffset);
  }

  @Post('dead-letters/:id/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-queue a dead-letter job back onto its original queue' })
  async retryDeadLetter(@Param('id') id: string) {
    const record = await this.deadLetters.findById(BigInt(id));
    if (!record) throw new NotFoundException(`Dead-letter job ${id} not found`);
    await this.queues.get(record.queueName).add(record.jobName, record.payload, this.queues.defaultJobOptions());
    await this.deadLetters.markRetried(BigInt(id));
    return { requeued: true, id, queueName: record.queueName, jobName: record.jobName };
  }

  @Post('dead-letters/retry-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-queue every pending dead-letter job onto its original queue' })
  async retryAllDeadLetters() {
    // High limit so a single click clears the whole backlog, not just one page.
    const { items } = await this.deadLetters.findPending(1000, 0);
    let requeued = 0;
    for (const item of items) {
      // Per-item guard: one poison record (e.g. an unknown queue name) must not
      // abort the rest of the batch.
      try {
        const record = await this.deadLetters.findById(item.id);
        if (!record) continue;
        await this.queues.get(record.queueName).add(record.jobName, record.payload, this.queues.defaultJobOptions());
        await this.deadLetters.markRetried(record.id);
        requeued += 1;
      } catch {
        /* skip and continue */
      }
    }
    return { requeued, scanned: items.length };
  }

  @Post('dead-letters/:id/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark a dead-letter job resolved/won’t-fix (removes it from the pending list without re-queueing). For poison payloads that can never succeed.' })
  async resolveDeadLetter(@Param('id') id: string) {
    const record = await this.deadLetters.findById(BigInt(id));
    if (!record) throw new NotFoundException(`Dead-letter job ${id} not found`);
    await this.deadLetters.markResolved(BigInt(id));
    return { resolved: true, id };
  }

  @Post('time-entries/backfill-replacement')
  @HttpCode(200)
  @ApiOperation({ summary: 'Queue replacement jobs for all historical time entries that carry a mapped tag and have not been replaced yet.' })
  async backfillReplacement(@Body() dto: BackfillReplacementDto, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    const limit = Math.min(dto.limit ?? 500, 2000);
    const entries = await this.timeEntriesRepo.findUnreplacedTaggedEntries(wsId, limit);

    let queued = 0;
    for (const entry of entries) {
      // Empty `tags` rows are filtered at the SQL level, but the array could
      // still be all-null after lowercasing — guard just in case.
      if (!entry.tag_names || entry.tag_names.length === 0) continue;
      this.queues.get(QUEUES.CLICKUP_ASSIGNEE_REPLACEMENT).add(
        JOBS.REPLACE_TIME_ENTRY_ASSIGNEES,
        {
          workspaceId: wsId,
          timeEntryId: entry.time_entry_id,
          taskId: entry.task_id ?? '',
          startMs: entry.start_time?.getTime() ?? 0,
          endMs: entry.end_time?.getTime() ?? 0,
          durationHours: Number(entry.duration_hours),
          billable: entry.billable,
          description: entry.description ?? undefined,
          originalUserId: entry.user_id ?? '',
          tags: entry.tag_names,
        },
        // Same deterministic jobId as the webhook-driven enqueue so a backfill
        // and a live sync can't both spawn a replacement for the same entry.
        { ...this.queues.defaultJobOptions(), jobId: replacementJobId(entry.time_entry_id) },
      );
      queued += 1;
    }

    return { queued, scanned: entries.length, limit };
  }

  @Post('time-entries/sync-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Enqueue time-entry sync jobs for every task in the database' })
  async syncAllTimeEntries(@Query('lookbackDays') lookbackDaysParam?: string, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    const tasks = await this.tasksRepo.findAllIds(wsId);
    const endDate = Date.now();
    const queue = this.queues.get(QUEUES.CLICKUP_TIME_ENTRIES);
    const jobOpts = this.queues.defaultJobOptions();

    for (const { taskId, spaceId } of tasks) {
      const space = spaceId ? this.workspaces.getSpace(wsId, spaceId) : undefined;
      const days = lookbackDaysParam ? Number(lookbackDaysParam) : (space?.backfillLookbackDays ?? 90);
      const startDate = subtractDays(days).getTime();
      await queue.add(JOBS.SYNC_TASK_TIME_ENTRIES, { workspaceId: wsId, taskId, startDate, endDate }, jobOpts);
    }

    return { queued: tasks.length };
  }

  @Post('tasks/reconcile')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reconcile every stored task against ClickUp: detect whole-task deletes (soft-delete ghosts) and re-sync each task’s time entries' })
  async reconcileTasks(@Query('lookbackDays') lookbackDaysParam?: string, @Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    // Refuse to start a second sweep for this workspace while one is still
    // draining: re-triggering would enqueue another RECONCILE job per task (no
    // dedup) and double the queue depth. Poll /admin/tasks/reconcile/active.
    const inFlight = await this.queues.get(QUEUES.CLICKUP_TASKS).getJobs(['active', 'waiting', 'delayed', 'prioritized']);
    if (inFlight.some((j) => j.name === JOBS.RECONCILE_CLICKUP_TASK && (j.data as { workspaceId?: string })?.workspaceId === wsId)) {
      return { queued: 0, alreadyRunning: true };
    }
    const tasks = await this.tasksRepo.findAllIds(wsId);
    const endDate = Date.now();
    const days = lookbackDaysParam ? Number(lookbackDaysParam) : 365;
    const startDate = subtractDays(days).getTime();
    const queue = this.queues.get(QUEUES.CLICKUP_TASKS);
    const jobOpts = this.queues.defaultJobOptions();

    for (const { taskId } of tasks) {
      await queue.add(JOBS.RECONCILE_CLICKUP_TASK, { workspaceId: wsId, taskId, startDate, endDate }, jobOpts);
    }

    return { queued: tasks.length };
  }

  @Get('tasks/reconcile/active')
  @ApiOperation({ summary: 'Live progress for a running full-reconciliation sweep' })
  async reconcileActive(@Query('workspaceId') workspaceId?: string) {
    const wsId = this.workspaces.resolveWorkspaceId(workspaceId);
    const jobs = await this.queues.get(QUEUES.CLICKUP_TASKS).getJobs(['active', 'waiting', 'delayed', 'prioritized']);
    // The clickup-tasks queue is shared with sync/delete jobs and across
    // workspaces, so count only reconcile jobs for this workspace.
    const remaining = jobs.filter((j) => j.name === JOBS.RECONCILE_CLICKUP_TASK && (j.data as { workspaceId?: string })?.workspaceId === wsId).length;
    if (remaining === 0) return { active: false, total: 0, done: 0, remaining: 0 };
    // Denominator ≈ jobs enqueued (one per non-deleted task). It drifts down as
    // the sweep soft-deletes 404'd tasks, so clamp done at 0.
    const total = await this.tasksRepo.countActive(wsId);
    const done = Math.max(0, total - remaining);
    return { active: true, total, done, remaining };
  }

  // ── Rates CRUD ─────────────────────────────────────────────────────────────

  @Post('rates/recalculate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Recalculate time-entry costs from current rates (optionally scoped to one assignee)' })
  recalculateCosts(@Query('assigneeId') assigneeId?: string) {
    this.queues
      .get(QUEUES.MAINTENANCE)
      .add(JOBS.RECALCULATE_COSTS, assigneeId ? { assigneeId } : {}, this.queues.defaultJobOptions());
    return { queued: true, scope: assigneeId ?? 'all' };
  }

  @Get('rates')
  @ApiOperation({ summary: 'List all assignee rates (paginated)' })
  listRates(@Query('page') page = 1, @Query('limit') limit = 50) {
    return this.ratesRepo.findAll(Number(page) || 1, Number(limit) || 50);
  }

  @Post('rates')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an assignee rate' })
  createRate(@Body() dto: CreateRateDto) {
    const validFrom = new Date(`${dto.validFrom.slice(0, 10)}T00:00:00.000Z`);
    const validTo = dto.validTo ? new Date(`${dto.validTo.slice(0, 10)}T00:00:00.000Z`) : null;
    return this.ratesService.create({ assigneeId: dto.assigneeId, assigneeName: dto.assigneeName, assigneeEmail: dto.assigneeEmail, currency: dto.currency ?? 'USD', hourlyRateCents: dto.hourlyRateCents, validFrom, validTo });
  }

  @Patch('rates/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update an assignee rate' })
  updateRate(@Param('id') id: string, @Body() dto: UpdateRateDto) {
    const data: Parameters<RatesRepository['update']>[1] = {};
    if (dto.assigneeName !== undefined) data.assigneeName = dto.assigneeName;
    if (dto.assigneeEmail !== undefined) data.assigneeEmail = dto.assigneeEmail;
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.hourlyRateCents !== undefined) data.hourlyRateCents = dto.hourlyRateCents;
    if (dto.validFrom !== undefined) data.validFrom = new Date(`${dto.validFrom.slice(0, 10)}T00:00:00.000Z`);
    if ('validTo' in dto) data.validTo = dto.validTo ? new Date(`${dto.validTo!.slice(0, 10)}T00:00:00.000Z`) : null;
    return this.ratesService.update(parseId(id), data);
  }

  @Delete('rates/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an assignee rate' })
  deleteRate(@Param('id') id: string) {
    return this.ratesService.remove(parseId(id));
  }

  // ── Excluded-from-costing assignees ────────────────────────────────────────

  @Get('excluded-assignees')
  @ApiOperation({ summary: 'List assignees excluded from costing' })
  listExcludedAssignees() {
    return { assignees: this.settings.getPreferences().cost.excludedAssignees };
  }

  @Put('excluded-assignees')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace the whole excluded-from-costing assignee list; recalcs changed assignees' })
  async updateExcludedAssignees(@Body() dto: UpdateExcludedAssigneesDto, @CurrentUser() user: AuthPrincipal) {
    const prev = new Set(this.settings.getPreferences().cost.excludedAssignees.map((a) => a.id));
    const next = dto.assignees.map((a) => ({ id: a.id, name: a.name ?? null, email: a.email ?? null }));
    const nextIds = new Set(next.map((a) => a.id));

    await this.settings.update({ preferences: { cost: { excludedAssignees: next } } }, actorLabel(user));

    // Recalc anyone whose excluded-ness changed: added (now COST_EXCLUDED) and
    // removed (back to rate-based costing / NO_RATE_FOUND).
    const changed = new Set<string>();
    for (const id of nextIds) if (!prev.has(id)) changed.add(id);
    for (const id of prev) if (!nextIds.has(id)) changed.add(id);
    // Settings already persisted; a queue failure must not fail the request or
    // leave a floating rejection. Recalc can be re-run via the manual button.
    for (const id of changed) {
      try {
        await this.queues.get(QUEUES.MAINTENANCE).add(JOBS.RECALCULATE_COSTS, { assigneeId: id }, this.queues.defaultJobOptions());
      } catch (e) {
        this.logger.error(`Failed to enqueue cost recalculation for excluded-assignee change ${id}: ${(e as Error).message}`);
      }
    }

    return { assignees: next, recalculated: [...changed] };
  }

  // ── Client Budgets CRUD ─────────────────────────────────────────────────────

  @Get('budgets')
  @ApiOperation({ summary: 'List all client budgets (paginated)' })
  listBudgets(@Query('page') page = 1, @Query('limit') limit = 50) {
    return this.budgetsRepo.findAll(Number(page) || 1, Number(limit) || 50);
  }

  @Post('budgets')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a client budget' })
  createBudget(@Body() dto: CreateClientBudgetDto) {
    const validFrom = new Date(`${dto.validFrom.slice(0, 10)}T00:00:00.000Z`);
    const validTo = dto.validTo ? new Date(`${dto.validTo.slice(0, 10)}T00:00:00.000Z`) : null;
    return this.budgetsRepo.create({
      client: dto.client,
      monthlyAmountCents: dto.monthlyAmountCents,
      currency: dto.currency ?? 'USD',
      validFrom,
      validTo,
      notes: dto.notes ?? null,
    });
  }

  @Patch('budgets/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update a client budget' })
  updateBudget(@Param('id') id: string, @Body() dto: UpdateClientBudgetDto) {
    const data: Parameters<BudgetsRepository['update']>[1] = {};
    if (dto.client !== undefined) data.client = dto.client;
    if (dto.monthlyAmountCents !== undefined) data.monthlyAmountCents = dto.monthlyAmountCents;
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.validFrom !== undefined) data.validFrom = new Date(`${dto.validFrom.slice(0, 10)}T00:00:00.000Z`);
    if ('validTo' in dto) data.validTo = dto.validTo ? new Date(`${dto.validTo!.slice(0, 10)}T00:00:00.000Z`) : null;
    if ('notes' in dto) data.notes = dto.notes ?? null;
    return this.budgetsRepo.update(parseId(id), data);
  }

  @Delete('budgets/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a client budget' })
  deleteBudget(@Param('id') id: string) {
    return this.budgetsRepo.remove(parseId(id));
  }

  // ── Tag-Assignee Map CRUD ───────────────────────────────────────────────────

  @Get('tag-assignee-map')
  @ApiOperation({ summary: 'List all tag → assignee mappings' })
  listTagAssignee() {
    return this.tagAssigneeRepo.findAll();
  }

  @Post('tag-assignee-map')
  @HttpCode(201)
  @ApiOperation({ summary: 'Add a tag → assignee mapping' })
  createTagAssignee(@Body() dto: CreateTagAssigneeDto) {
    return this.tagAssigneeRepo.create({ tagName: dto.tagName, clickupUserId: dto.clickupUserId, clickupUserName: dto.clickupUserName, clickupEmail: dto.clickupEmail, active: dto.active });
  }

  @Patch('tag-assignee-map/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update a tag → assignee mapping' })
  async updateTagAssignee(@Param('id') id: string, @Body() dto: UpdateTagAssigneeDto) {
    try {
      return await this.tagAssigneeRepo.update(parseId(id), dto);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new ConflictException(`A tag named "${dto.tagName}" already exists.`);
      }
      throw e;
    }
  }

  @Delete('tag-assignee-map/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a tag → assignee mapping' })
  deleteTagAssignee(@Param('id') id: string) {
    return this.tagAssigneeRepo.remove(parseId(id));
  }

  // ── Task history ───────────────────────────────────────────────────────────

  @Get('tasks/:taskId/history')
  @ApiOperation({ summary: 'Merged sync-job + status-event history for one task.' })
  taskHistory(@Param('taskId') taskId: string) {
    return this.taskHistoryRepo.forTask(taskId);
  }

  // ── Audit log viewer ───────────────────────────────────────────────────────

  @Get('audit-log')
  @ApiOperation({ summary: 'Paginated admin audit log (write actions only).' })
  async listAuditLog(
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
    @Query('actor') actor?: string,
    @Query('routePattern') routePattern?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.auditLog.findMany({
      actor: actor?.trim() || undefined,
      routePattern: routePattern?.trim() || undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: Number(limit) || 50,
      offset: Number(offset) || 0,
    });
  }
}
