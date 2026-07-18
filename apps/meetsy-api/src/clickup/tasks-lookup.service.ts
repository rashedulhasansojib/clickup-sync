import { Injectable } from "@nestjs/common";
import type { ClickUpTaskLookupView } from "@ma/shared";
import { PrismaService } from "../prisma/prisma.service";

/**
 * v2 Phase 0 — resolves a ClickUp task_id to human-readable metadata (title,
 * status, assignee, url, updatedAt) for the Meetsy review UI's clickable chips
 * (duplicates, evidenceTaskIds, kbContext).
 *
 * Reads the read-only `public.clickup_tasks` mirror (KbChunk sources come from
 * here too). Soft-scoped by the requesting workspace's `workspaceId` — a
 * cross-workspace/-org lookup returns null (200), not 404 or 403. Rationale:
 * a chip may point at a task predating the KB sync or a task that has since
 * been deleted; the UI treats null as "unavailable" and falls back to the
 * bare id — never an error banner.
 */
@Injectable()
export class TasksLookupService {
  constructor(private readonly prisma: PrismaService) {}

  async forWorkspace(
    workspaceId: string,
    taskId: string,
  ): Promise<ClickUpTaskLookupView | null> {
    const row = await this.prisma.clickupTask.findUnique({
      where: { taskId },
      select: {
        taskId: true,
        workspaceId: true,
        taskName: true,
        status: true,
        assigneesNames: true,
        url: true,
        updatedDate: true,
        isDeleted: true,
      },
    });
    if (!row) return null;
    // Soft-scope: never leak a task from another workspace. Same rationale as
    // the KbSearchService per-workspace filter — hydrate only what this
    // workspace already has visibility into via the mirror.
    if (row.workspaceId !== workspaceId) return null;
    // Soft-deleted tasks are treated as "not available" (the chip still renders
    // as the bare id). A restore in ClickUp flips is_deleted off and this route
    // resurrects transparently.
    if (row.isDeleted) return null;

    return {
      id: row.taskId,
      title: row.taskName,
      status: row.status ?? null,
      // `assignees_names` is a delimited string in Clicksy — hand it back
      // as-is so the UI can render either "just the first" or the full list.
      assigneeName: row.assigneesNames ?? null,
      url: row.url ?? null,
      updatedAt: (row.updatedDate ?? new Date(0)).toISOString(),
    };
  }
}
