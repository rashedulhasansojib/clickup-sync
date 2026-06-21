import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class SyncCheckpointsRepository {
  constructor(private readonly prisma: PrismaService) {}
  markAttempt(workspaceId: string, source: string, scopeType: string, scopeId: string) {
    return this.prisma.syncCheckpoint.upsert({ where: { workspaceId_source_scopeType_scopeId: { workspaceId, source, scopeType, scopeId } }, create: { workspaceId, source, scopeType, scopeId, lastAttemptedSyncAt: new Date() }, update: { lastAttemptedSyncAt: new Date() } });
  }
  markSuccess(workspaceId: string, source: string, scopeType: string, scopeId: string, when = new Date()) {
    return this.prisma.syncCheckpoint.upsert({ where: { workspaceId_source_scopeType_scopeId: { workspaceId, source, scopeType, scopeId } }, create: { workspaceId, source, scopeType, scopeId, lastAttemptedSyncAt: when, lastSuccessfulSyncAt: when }, update: { lastSuccessfulSyncAt: when, lastAttemptedSyncAt: when } });
  }
}
