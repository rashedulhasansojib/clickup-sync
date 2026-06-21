import { Injectable, Logger } from '@nestjs/common';
import { ClickupClient } from '../clickup/clickup.client';
import { ClickupNormalizer } from '../clickup/clickup-normalizer';
import { TasksRepository } from './tasks.repository';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);
  constructor(private readonly clickup: ClickupClient, private readonly normalizer: ClickupNormalizer, private readonly repo: TasksRepository) {}

  async syncTask(workspaceId: string, taskId: string) {
    const task = await this.clickup.getTask(workspaceId, taskId);
    const normalized = this.normalizer.normalizeTask(task);
    await this.repo.upsert(normalized, workspaceId);
    this.logger.log(`Synced ClickUp task ${taskId}`);
    return normalized;
  }

  async syncTasks(workspaceId: string, tasks: unknown[]) {
    let count = 0;
    for (const raw of tasks) {
      const normalized = this.normalizer.normalizeTask(raw as any);
      await this.repo.upsert(normalized, workspaceId);
      count += 1;
    }
    return count;
  }

  /**
   * Fetch and upsert parent tasks that are referenced by subtasks but not yet
   * stored locally — e.g. a parent updated outside a backfill's lookback window
   * so it never appears in the fetched page. Without this, the subtask's
   * parentTaskId points at a non-existent row and parent/subtask report joins
   * silently drop. Tolerant of per-id failures (a deleted/404 parent is logged
   * and skipped, not fatal to the batch). Returns the number actually synced.
   */
  async syncMissingParents(workspaceId: string, parentIds: string[]): Promise<number> {
    const missing = await this.repo.findMissingParentIds(parentIds);
    let synced = 0;
    for (const id of missing) {
      try {
        await this.syncTask(workspaceId, id);
        synced += 1;
      } catch (err: any) {
        this.logger.warn(`Could not fetch missing parent ${id}: ${err?.message ?? err}`);
      }
    }
    if (synced > 0) this.logger.log(`Fetched ${synced}/${missing.length} missing parent task(s)`);
    return synced;
  }

  async softDeleteTask(taskId: string, workspaceId: string) { return this.repo.softDelete(taskId, workspaceId); }

  patchSpaceNames(workspaceId: string, spaceId: string, spaceName: string) { return this.repo.patchSpaceNames(workspaceId, spaceId, spaceName); }
}
