import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { QueueService } from '../queues/queue.service';
import { JOBS, QUEUES } from '../queues/queue.constants';
import { WorkspaceService } from '../workspaces/workspace.service';

@Injectable()
export class SyncScheduler {
  private readonly logger = new Logger(SyncScheduler.name);
  constructor(
    private readonly queues: QueueService,
    private readonly workspaces: WorkspaceService,
  ) {}

  // Recurring reconciliation: every 12 hours, syncs tasks updated in the last
  // day and scans a bounded 7-day time-entry window (rather than re-draining the
  // full per-space window each run) — enough to recover time entries whose
  // webhook was missed within the last week. Manual backfills use the full
  // window. This is only a safety net for webhooks ClickUp never delivered;
  // real-time updates still arrive via webhooks.
  @Cron('0 0 */12 * * *')
  async reconcileRecentUpdates() {
    const queue = this.queues.get(QUEUES.CLICKUP_BACKFILLS);
    // Skip a space whose previous backfill hasn't drained yet — under ClickUp
    // slowness an hourly run that outpaces the drain would otherwise stack
    // duplicate per-space backfills (and their per-task time-entry fan-out).
    // jobId dedup can't help here: cron never re-adds an identical id, and a
    // stable id would be blocked forever by the kept completed job.
    const live = await queue.getJobs(['active', 'waiting', 'delayed', 'prioritized']);
    // Key by workspace+space so an in-flight backfill in one workspace doesn't
    // suppress a different workspace that happens to share a space id.
    const busy = new Set(
      live
        .map((j) => {
          const d = j.data as { workspaceId?: string; spaceId?: string } | undefined;
          return d?.workspaceId && d?.spaceId ? `${d.workspaceId}:${d.spaceId}` : undefined;
        })
        .filter((v): v is string => typeof v === 'string'),
    );
    for (const workspaceId of this.workspaces.listActiveWorkspaceIds()) {
      for (const space of this.workspaces.getSpaces(workspaceId)) {
        if (busy.has(`${workspaceId}:${space.spaceId}`)) {
          this.logger.warn(`Skipping recurring reconcile for ${workspaceId}/${space.spaceId}: a backfill is still in flight`);
          continue;
        }
        if (!space.enabled) {
          this.logger.log(`Skipping recurring reconcile for ${workspaceId}/${space.spaceId}: disabled in settings`);
          continue;
        }
        await queue.add(
          JOBS.BACKFILL_CLICKUP_SPACE,
          { workspaceId, spaceId: space.spaceId, lookbackDays: 1, timeEntryLookbackDays: 7 },
          this.queues.defaultJobOptions(),
        );
      }
    }
  }
}
