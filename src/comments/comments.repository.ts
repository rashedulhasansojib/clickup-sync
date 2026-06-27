import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NormalizedComment } from '../clickup/clickup-normalizer';

@Injectable()
export class CommentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert a comment by its ClickUp id (the conflict key). Idempotent: a re-sync
   * of the same comment updates in place and bumps `syncCount` rather than
   * duplicating. Mirrors TasksRepository.upsert.
   */
  upsert(comment: NormalizedComment, workspaceId: string) {
    return this.prisma.clickupTaskComment.upsert({
      where: { commentId: comment.commentId },
      create: {
        ...comment,
        workspaceId,
        reactions: comment.reactions as Prisma.InputJsonValue,
        raw: comment.raw as Prisma.InputJsonValue,
        isDeleted: false,
        syncCount: 1,
      },
      update: {
        ...comment,
        reactions: comment.reactions as Prisma.InputJsonValue,
        raw: comment.raw as Prisma.InputJsonValue,
        isDeleted: false,
        deletedAt: null,
        syncCount: { increment: 1 },
      },
    });
  }

  /**
   * Stamp the comment-completeness markers on the owning task once its comment
   * sync finishes. `updateMany` (not `update`) so it no-ops instead of throwing
   * when the task row isn't mirrored yet — comments carry no FK to the task.
   */
  markTaskCommentsSynced(taskId: string, commentCount: number) {
    return this.prisma.clickupTask.updateMany({
      where: { taskId },
      data: { commentsSyncedAt: new Date(), commentCount },
    });
  }
}
