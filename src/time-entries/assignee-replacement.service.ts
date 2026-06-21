import { Injectable, Logger } from '@nestjs/common';
import { ClickupClient } from '../clickup/clickup.client';
import { NormalizedTimeEntry } from '../clickup/clickup-normalizer';
import { TagAssigneeMapRepository } from './tag-assignee-map.repository';
import { TimeEntryReplacementsRepository } from './time-entry-replacements.repository';
import { CostCalculatorService } from './cost-calculator.service';
import { TimeEntriesRepository } from './time-entries.repository';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../database/prisma.service';

export interface ReplacementJobData {
  workspaceId: string;
  timeEntryId: string;
  taskId: string;
  startMs: number;
  endMs: number;
  durationHours: number;
  billable: boolean;
  description?: string;
  /** ID of the user who originally logged the entry (for audit). */
  originalUserId: string;
  /** Lowercased tag names from the time entry's own `tags` array. */
  tags: string[];
}

/**
 * Deterministic BullMQ jobId for a time entry's replacement job (one per entry,
 * so the same entry can't be processed by two concurrent jobs = duplicate
 * ClickUp entries). MUST NOT contain ':' — BullMQ uses ':' as its Redis key
 * separator and rejects custom job ids that contain it with the (misleading)
 * error "Custom Id cannot contain :". Use '-' as the separator.
 */
export function replacementJobId(timeEntryId: string): string {
  return `replace-${timeEntryId}`;
}

@Injectable()
export class AssigneeReplacementService {
  private readonly logger = new Logger(AssigneeReplacementService.name);

  constructor(
    private readonly clickup: ClickupClient,
    private readonly tagAssigneeMap: TagAssigneeMapRepository,
    private readonly replacements: TimeEntryReplacementsRepository,
    private readonly costs: CostCalculatorService,
    private readonly timeEntries: TimeEntriesRepository,
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
  ) {}

  async replaceEntry(data: ReplacementJobData): Promise<{ status: 'replaced' | 'skipped' | 'no_mapping' }> {
    const workspaceId = data.workspaceId;

    // 1. Idempotency / resume. An audit row is written ONLY after the ClickUp
    //    replacement entry is created (step 5), so its existence proves the
    //    replacement already happened. But the original-delete (step 6) and
    //    local cleanup (steps 7-8) may NOT have completed if the first run was
    //    interrupted (a ClickUp 5xx/timeout on delete is routine). So instead
    //    of blindly skipping, RESUME: re-run the delete + local cleanup
    //    idempotently. The delete tolerates 404 (already gone = success) and
    //    rethrows anything else so BullMQ retries until the original is really
    //    deleted — otherwise the original + replacement both survive and report
    //    double-counted hours forever.
    const existing = await this.replacements.findByOriginalEntryId(data.timeEntryId);
    if (existing) {
      await this.deleteOriginal(workspaceId, data.timeEntryId);
      await this.timeEntries.deleteByTimeEntryId(data.timeEntryId);
      this.logger.log(
        `Time entry ${data.timeEntryId} already replaced → ${existing.replacementEntryId ?? '(unknown)'} — ensured original removed`,
      );
      return { status: 'skipped' };
    }

    // 2. Resolve the mapping from the time entry's own tags. The active map is
    //    re-read at process time (not at enqueue time) so admin edits to
    //    enable/disable mappings take effect on the next worker run.
    const activeMap = await this.tagAssigneeMap.findAllActive();
    const activeTagNames = new Set(activeMap.map((m) => m.tagName.toLowerCase()));
    const tags = (data.tags ?? []).map((t) => t.toLowerCase()).filter(Boolean);
    const tagName = tags.find((t) => activeTagNames.has(t)) ?? null;

    // 3. No mapping found — skip
    if (!tagName) {
      this.logger.warn(`No tag→assignee mapping for time entry ${data.timeEntryId} (tags=[${tags.join(',')}]) — leaving as-is`);
      return { status: 'no_mapping' };
    }

    const mapping = activeMap.find((m) => m.tagName.toLowerCase() === tagName);
    if (!mapping) return { status: 'no_mapping' };

    const realUserId = mapping.clickupUserId;

    // 4. Create replacement entry in ClickUp
    const created = await this.clickup.createTimeEntry(workspaceId, {
      start: data.startMs,
      stop: data.endMs,
      description: data.description,
      billable: data.billable,
      tid: data.taskId,
      assignee: Number(realUserId),
    });

    // 5. Persist audit row immediately (before deleting original).
    //    originalUserId records who actually logged the time, not the agency
    //    account — so the audit trail correctly attributes provenance even
    //    when the tag-routing is invoked outside the agency-user flow.
    await this.replacements.create({
      workspaceId,
      originalEntryId: data.timeEntryId,
      replacementEntryId: created.id,
      taskId: data.taskId,
      originalUserId: data.originalUserId,
      replacedUserId: realUserId,
      tagName,
      status: 'replaced',
    });

    // 6. Delete original entry only after audit row committed (404-tolerant;
    //    any other failure throws so the job retries — the resume branch above
    //    will then re-attempt the delete on the next run).
    await this.deleteOriginal(workspaceId, data.timeEntryId);

    // 7. Upsert replacement entry into local DB with recalculated cost
    const startTime = new Date(data.startMs);
    const dueDate =
      this.settings.getPreferences().cost.rateMatching === 'due'
        ? (await this.prisma.clickupTask.findUnique({ where: { taskId: data.taskId }, select: { dueDate: true } }))?.dueDate ?? null
        : null;
    const cost = await this.costs.calculate(realUserId, startTime, data.durationHours, undefined, { billable: data.billable, dueDate });
    const normalized: NormalizedTimeEntry = {
      timeEntryId: created.id,
      taskId: data.taskId,
      taskName: null,
      userId: realUserId,
      userName: mapping.clickupUserName ?? null,
      userEmail: mapping.clickupEmail ?? null,
      startTime: new Date(data.startMs),
      endTime: new Date(data.endMs),
      durationHours: data.durationHours,
      billable: data.billable,
      description: data.description ?? null,
      raw: created,
    };
    await this.timeEntries.upsert(normalized, cost, workspaceId);

    // 8. Remove the local original row. The original was already deleted in
    //    ClickUp (step 6) and re-inserted under the replacement's new id (step
    //    7); leaving the old row would make reports SUM both the original and
    //    the replacement → double-counted hours and cost. Idempotent.
    await this.timeEntries.deleteByTimeEntryId(data.timeEntryId);

    if (cost.status === 'NO_RATE_FOUND') {
      this.logger.warn(`No rate found for replaced user ${realUserId} on entry ${created.id}`);
    }

    this.logger.log(`Replaced time entry ${data.timeEntryId} → ${created.id} for user ${realUserId} (tag: ${tagName})`);
    return { status: 'replaced' };
  }

  /**
   * Delete the original ClickUp time entry, tolerating a 404 (already deleted =
   * the desired end state, e.g. on a retry where the prior run's delete already
   * landed). Every other error is rethrown so the job fails and BullMQ retries —
   * we must NOT treat a transient delete failure as success, or the original
   * lingers alongside the replacement and reports double-count.
   */
  private async deleteOriginal(workspaceId: string, entryId: string): Promise<void> {
    try {
      await this.clickup.deleteTimeEntry(workspaceId, entryId);
    } catch (err: any) {
      if (err?.response?.status === 404) {
        this.logger.log(`Original time entry ${entryId} already gone in ClickUp (404) — treating delete as done`);
        return;
      }
      throw err;
    }
  }
}
