import { Injectable, Logger } from '@nestjs/common';
import { ClickupClient } from '../clickup/clickup.client';
import { ClickupNormalizer } from '../clickup/clickup-normalizer';
import { CommentsRepository } from './comments.repository';

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);
  constructor(
    private readonly clickup: ClickupClient,
    private readonly normalizer: ClickupNormalizer,
    private readonly repo: CommentsRepository,
  ) {}

  /**
   * Re-fetch all of a task's comments from ClickUp and upsert them idempotently,
   * then stamp the task's comment-completeness markers. Re-fetching (rather than
   * parsing the webhook payload inline) keeps a single resilient code path:
   * webhook-driven and backfill syncs run identically and converge.
   */
  async syncTaskComments(workspaceId: string, taskId: string): Promise<number> {
    const comments = await this.clickup.getTaskComments(workspaceId, taskId);
    let count = 0;
    for (const c of comments) {
      const normalized = this.normalizer.normalizeComment(c, taskId);
      await this.repo.upsert(normalized, workspaceId);
      count += 1;
    }
    // TODO(comment-delete-reconcile): ClickUp emits no comment-deleted webhook,
    // so a comment removed in ClickUp lingers here. A later pass should soft-delete
    // (isDeleted/deletedAt) local rows for this task absent from the fetched set —
    // same shape as the existing task delete-reconcile. Deferred (Phase 1.x).

    // Set the completeness markers AFTER all pages are upserted so downstream
    // consumers (Meetsy's KB) re-embed once on completion, not per page.
    await this.repo.markTaskCommentsSynced(taskId, count);
    this.logger.log(`Synced ${count} comment(s) for ClickUp task ${taskId}`);
    return count;
  }
}
