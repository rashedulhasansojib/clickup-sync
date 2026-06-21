import { BadRequestException, Body, Controller, HttpCode, Logger, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { QueueService } from '../queues/queue.service';
import { JOBS, QUEUES } from '../queues/queue.constants';
import { WebhookParserService } from './webhook-parser.service';
import { WebhookEventsRepository } from './webhook-events.repository';
import { WebhookSignatureGuard } from './webhook-signature.guard';
import { Public } from '../auth/decorators';
import { WorkspaceService } from '../workspaces/workspace.service';

@ApiTags('webhooks')
@Controller('webhooks')
@UseGuards(WebhookSignatureGuard)
export class ClickupWebhookController {
  private readonly logger = new Logger(ClickupWebhookController.name);
  constructor(
    private readonly parser: WebhookParserService,
    private readonly repo: WebhookEventsRepository,
    private readonly queues: QueueService,
    private readonly workspaces: WorkspaceService,
  ) {}

  // Each connected workspace registers its ClickUp webhook at its OWN URL so the
  // signature guard can verify against that workspace's secret and every event
  // is attributed to the right workspace.
  @Public()
  @Post('clickup/:workspaceId')
  @HttpCode(200)
  async receive(@Param('workspaceId') workspaceId: string, @Body() payload: unknown) {
    if (!this.workspaces.hasWorkspace(workspaceId)) {
      throw new BadRequestException(`Unknown workspace: ${workspaceId}`);
    }
    if (!this.workspaces.getSyncPreferences(workspaceId).realtimeWebhooks) {
      return { success: true, skipped: true };
    }
    const parsed = this.parser.parse(payload);
    const saved = await this.repo.saveReceived(parsed, workspaceId);
    if (saved.duplicate) return { success: true, duplicate: true };

    // The event row + dedupe row are now committed. If enqueue fails here
    // (e.g. Redis blip), ClickUp's retry would be deduped → the event is lost
    // and never processed. Mark it `failed` instead so the admin
    // "retry failed webhooks" path can re-enqueue it from the stored payload.
    // We still return 200 to avoid a ClickUp retry storm that can't succeed.
    try {
      await this.queues
        .get(QUEUES.CLICKUP_WEBHOOKS)
        .add(JOBS.PROCESS_CLICKUP_EVENT, { ...parsed, workspaceId }, this.queues.webhookJobOptions());
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.logger.error(`Failed to enqueue ClickUp webhook ${parsed.fingerprint}: ${message}`);
      await this.repo
        .markFailed(parsed.fingerprint, `enqueue failed: ${message}`)
        .catch((e) => this.logger.error(`markFailed(${parsed.fingerprint}) also failed: ${e.message}`));
      return { success: true, queued: false };
    }

    this.logger.log(`Queued ClickUp webhook ${parsed.eventType || 'unknown'} ${parsed.taskId || ''}`);
    return { success: true, queued: true };
  }
}
