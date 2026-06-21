import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ParsedWebhook } from './webhook-parser.service';

@Injectable()
export class WebhookEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async saveReceived(parsed: ParsedWebhook, workspaceId: string): Promise<{ duplicate: boolean; id?: bigint }> {
    try {
      const event = await this.prisma.clickupWebhookEvent.create({ data: { workspaceId, fingerprint: parsed.fingerprint, eventType: parsed.eventType, taskId: parsed.taskId, rawPayload: parsed.payload as any } });
      await this.prisma.clickupWebhookSeen.create({ data: { workspaceId, fingerprint: parsed.fingerprint } }).catch(() => undefined);
      return { duplicate: false, id: event.id };
    } catch (error: any) {
      if (error?.code === 'P2002') return { duplicate: true };
      throw error;
    }
  }

  markProcessed(fingerprint: string) { return this.prisma.clickupWebhookEvent.update({ where: { fingerprint }, data: { status: 'processed', processedAt: new Date(), errorMessage: null } }); }
  markFailed(fingerprint: string, message: string) { return this.prisma.clickupWebhookEvent.update({ where: { fingerprint }, data: { status: 'failed', processedAt: new Date(), errorMessage: message } }); }

  /** Failed events still carrying their raw payload, oldest first. Used by the
   *  admin "Retry all failed" path to re-enqueue them on `clickup-webhooks`. */
  findFailed(limit = 500) {
    return this.prisma.clickupWebhookEvent.findMany({
      where: { status: 'failed' },
      orderBy: { receivedAt: 'asc' },
      take: Math.min(limit, 2000),
      select: { id: true, fingerprint: true, rawPayload: true, workspaceId: true },
    });
  }

  markRequeued(fingerprint: string) {
    return this.prisma.clickupWebhookEvent.update({
      where: { fingerprint },
      data: { status: 'received', processedAt: null, errorMessage: null },
    });
  }
}
