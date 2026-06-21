import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { MailerService } from '../auth/mailer.service';
import { WorkspaceService } from '../workspaces/workspace.service';

export type SpikeRule = 'absolute' | 'relative' | 'both';

interface BreakdownRow {
  task_id: string | null;
  task_name: string | null;
  user_name: string | null;
  user_email: string | null;
  hours: number;
}

export interface SpikeBreakdown {
  recipientEmail: string | null;
  userName: string | null;
  totalHours: number;
  tasks: { taskId: string; taskName: string; hours: number }[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (date: string) => new Date(`${date}T00:00:00.000Z`);

@Injectable()
export class SpikeNotificationService {
  private readonly logger = new Logger(SpikeNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly workspaces: WorkspaceService,
  ) {}

  /**
   * Aggregate one user's tracked time for one Dhaka-local day, grouped by task.
   * Mirrors the watchlist's bucketing/join exactly (UTC→Dhaka, is_deleted=false,
   * COALESCE(user_id,'unknown')) so totals match the Time Spikes row.
   */
  async breakdown(workspaceId: string, userId: string, date: string): Promise<SpikeBreakdown> {
    if (!DATE_RE.test(date)) throw new BadRequestException('date must be YYYY-MM-DD');
    const rows = await this.prisma.$queryRaw<BreakdownRow[]>(Prisma.sql`
      SELECT e.task_id                                   AS task_id,
             MAX(t.task_name)                            AS task_name,
             MAX(NULLIF(e.user_name, ''))                AS user_name,
             MAX(NULLIF(e.user_email, ''))               AS user_email,
             COALESCE(SUM(e.duration_hours), 0)::float   AS hours
      FROM clickup_time_entries e
      JOIN clickup_tasks t ON e.task_id = t.task_id
      WHERE e.start_time IS NOT NULL
        AND e.workspace_id = ${workspaceId}
        AND t.is_deleted = false
        AND COALESCE(e.user_id, 'unknown') = ${userId}
        AND to_char(date_trunc('day', e.start_time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka'), 'YYYY-MM-DD') = ${date}
      GROUP BY e.task_id
      ORDER BY hours DESC
    `);
    const recipientEmail = rows.map((r) => r.user_email).find((v): v is string => !!v) ?? null;
    const userName = rows.map((r) => r.user_name).find((v): v is string => !!v) ?? null;
    const totalHours = rows.reduce((s, r) => s + (r.hours ?? 0), 0);
    const tasks = rows.map((r) => ({
      taskId: r.task_id ?? '',
      taskName: r.task_name ?? '(unknown task)',
      hours: r.hours ?? 0,
    }));
    return { recipientEmail, userName, totalHours, tasks };
  }

  async preview(workspaceId: string, userId: string, date: string) {
    const b = await this.breakdown(workspaceId, userId, date);
    const existing = await this.prisma.spikeNotification.findUnique({
      where: { workspaceId_clickupUserId_spikeDate: { workspaceId, clickupUserId: userId, spikeDate: dayStart(date) } },
    });
    return { date, ...b, alreadyNotified: !!existing };
  }

  async notify(args: {
    workspaceId: string;
    userId: string;
    date: string;
    rule?: SpikeRule;
    median?: number;
    note?: string;
    sentBy?: string;
  }) {
    const { workspaceId, userId, date, rule, median, note, sentBy } = args;
    const b = await this.breakdown(workspaceId, userId, date);
    if (b.tasks.length === 0) throw new BadRequestException('No time entries for that user on that day.');
    if (!b.recipientEmail) throw new BadRequestException('No email on file for this member; cannot send.');

    // Early guard so the common path never double-emails; the unique index is
    // the backstop for a concurrent race (caught as P2002 below).
    const existing = await this.prisma.spikeNotification.findUnique({
      where: { workspaceId_clickupUserId_spikeDate: { workspaceId, clickupUserId: userId, spikeDate: dayStart(date) } },
    });
    if (existing) throw new ConflictException('This member has already been notified for this day.');

    const cap = this.workspaces.getSpikeHoursCap(workspaceId);
    const reason = this.reasonText(rule, b.totalHours, cap, median);

    // Send first, then record. Deliberate: at-least-once + recoverable. If the
    // write below fails the error surfaces and a retry converges (worst case a
    // duplicate email); the reverse order could strand a "notified" row with no
    // email actually sent and a 409 that blocks retry.
    await this.mailer.sendSpikeNotice({
      to: b.recipientEmail,
      userName: b.userName ?? 'there',
      date,
      totalHours: b.totalHours,
      reason,
      note: note ?? null,
      tasks: b.tasks,
    });

    try {
      await this.prisma.spikeNotification.create({
        data: {
          workspaceId,
          clickupUserId: userId,
          spikeDate: dayStart(date),
          recipientEmail: b.recipientEmail,
          userName: b.userName,
          totalHours: new Prisma.Decimal(b.totalHours.toFixed(4)),
          rule: rule ?? null,
          note: note ?? null,
          sentBy: sentBy ?? null,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('This member has already been notified for this day.');
      }
      // Email already went out but the record write failed — log so this rare
      // "sent but unrecorded" state is diagnosable (a retry may re-send).
      this.logger.error(`Spike notice sent to ${b.recipientEmail} for user ${userId} on ${date} but recording failed: ${String(e)}`);
      throw e;
    }

    return { sent: true, recipientEmail: b.recipientEmail, date, totalHours: b.totalHours };
  }

  private reasonText(rule: SpikeRule | undefined, totalHours: number, cap: number, median?: number): string {
    const mult =
      median && median > 0
        ? `${(totalHours / median).toFixed(1)}× your typical ${median.toFixed(1)}h`
        : 'well above your typical daily hours';
    if (rule === 'absolute') return `over the ${cap}h/day cap`;
    if (rule === 'relative') return mult;
    if (rule === 'both') return `${mult} and over the ${cap}h/day cap`;
    return 'above the usual range';
  }
}
