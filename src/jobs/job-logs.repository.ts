import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class JobLogsRepository {
  constructor(private readonly prisma: PrismaService) {}
  started(data: { workspaceId?: string | null; jobId?: string; queueName: string; jobName: string; entityType?: string; entityId?: string; attemptsMade?: number; payload?: unknown }) {
    return this.prisma.syncJobLog.create({ data: { ...data, status: 'started', payload: data.payload as any, startedAt: new Date() } });
  }
  finished(id: bigint, counts?: { tasksSynced?: number; timeEntriesSynced?: number }, status = 'completed') {
    return this.prisma.syncJobLog.update({ where: { id }, data: { status, finishedAt: new Date(), ...counts } });
  }
  failed(id: bigint, error: unknown) { const e = error as any; return this.prisma.syncJobLog.update({ where: { id }, data: { status: 'failed', finishedAt: new Date(), errorMessage: e?.message || String(error), errorStack: e?.stack } }); }
}
