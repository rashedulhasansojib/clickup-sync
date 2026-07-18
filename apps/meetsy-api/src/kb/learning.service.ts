import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  aggregateField,
  nudgeFor,
  type FieldAggregate,
  type FieldRecord,
  type CorrectionStat,
} from "./learning-aggregate";

/** The learnable fields. Client left the learning loop (it's a meeting-level value
 * the user sets at upload, never predicted); assignee resolves cleanly; sprint deferred. */
type LearnField = "assignee";
const FIELDS: LearnField[] = ["assignee"];

export interface LearningSnapshot {
  assignee: FieldAggregate;
}

/** A gated nudge to surface for a fresh prediction, per field. */
export interface TaskAdjustments {
  assignee?: { from: string; to: string; count: number; agreement: number };
}

export interface LearningSummaryView {
  totalOverrides: number;
  fields: Array<{
    field: LearnField;
    corrections: CorrectionStat[];
    /** Raw-model override rate — a KB-QUALITY proxy, NOT loop lift. */
    rawOverrideRate: number | null;
    rawSample: number;
    /** Nudge-acceptance rate — the loop's ACTUAL effectiveness (null until nudges shown). */
    nudgeAcceptanceRate: number | null;
    nudgeSample: number;
    /** Confirmed values that didn't resolve (a resolution miss ≠ "not enough data"). */
    unresolved: number;
  }>;
}

/**
 * v2 Phase 1 — per-user weekly rollup, one row per ISO week (Monday UTC).
 * Six weeks, oldest first, zero-padded (empty weeks show 0s so a sparkline
 * lines up with a fixed x-axis).
 */
export interface LearningMeWeek {
  /** ISO date of the week's Monday (YYYY-MM-DD, UTC). */
  weekStart: string;
  overrides: number;
  /** predicted === confirmed (model got it right for this user). */
  agreements: number;
  /** How many pushes had a nudge shown for the assignee field. */
  nudgesShown: number;
  /** How many of those the user accepted (confirmed = nudge.shown). */
  nudgesAccepted: number;
}

export interface LearningMeView {
  userId: string;
  totalOverrides: number;
  weeks: LearningMeWeek[];
}

const WEEKS_TO_RETURN = 6;

interface PredictionBundle {
  assigneeHint?: { value: string | null; abstain: boolean } | null;
}
interface ConfirmedBundle {
  clickupUserId?: string | null;
}
interface AdjustmentsBundle {
  assignee?: { shown: string; accepted: boolean };
}

@Injectable()
export class LearningService {
  constructor(private readonly prisma: PrismaService) {}

  /** Aggregate the workspace's override history into per-field stats (loads once). */
  async snapshot(workspaceId: string): Promise<LearningSnapshot> {
    const [rows, config] = await Promise.all([
      this.prisma.fieldOverride.findMany({
        where: { workspaceId },
        select: { predicted: true, confirmed: true, adjustments: true },
      }),
      this.prisma.workspacePushConfig.findUnique({
        where: { workspaceId },
        select: { assignableMembers: true },
      }),
    ]);

    const memberName = new Map<string, string>(
      ((config?.assignableMembers as Array<{ clickupUserId: string; name: string }> | null) ?? []).map((m) => [m.clickupUserId, m.name]),
    );

    const records: Record<LearnField, FieldRecord[]> = { assignee: [] };
    for (const row of rows) {
      const predicted = (row.predicted as PredictionBundle | null) ?? {};
      const confirmed = (row.confirmed as ConfirmedBundle) ?? {};
      const adj = (row.adjustments as AdjustmentsBundle | null) ?? {};
      records.assignee.push(
        this.toRecord(
          predFieldValue(predicted.assigneeHint),
          confirmed.clickupUserId ?? null,
          memberName,
          adj.assignee,
        ),
      );
    }

    return {
      assignee: aggregateField(records.assignee),
    };
  }

  /** Pure: apply the gated organic nudges of a snapshot to a fresh prediction bundle. */
  applyNudges(snap: LearningSnapshot, predicted: PredictionBundle): TaskAdjustments {
    const out: TaskAdjustments = {};
    const a = nudgeFor(snap.assignee, predFieldValue(predicted.assigneeHint));
    if (a) out.assignee = { from: a.predicted, to: a.confirmed, count: a.count, agreement: a.agreement };
    return out;
  }

  /** Per-task adjustments for a run (snapshot once, apply per task). */
  async adjustForTasks(
    workspaceId: string,
    predictionsByTask: Record<string, PredictionBundle>,
  ): Promise<Record<string, TaskAdjustments>> {
    const snap = await this.snapshot(workspaceId);
    const out: Record<string, TaskAdjustments> = {};
    for (const [taskId, pred] of Object.entries(predictionsByTask)) {
      const adj = this.applyNudges(snap, pred ?? {});
      if (adj.assignee) out[taskId] = adj;
    }
    return out;
  }

  /**
   * v2 Phase 1 — per-user weekly digest for the /home card. Joins
   * FieldOverride → TaskPush on (runId, meetsyTaskId) so we can filter by the
   * pushing user (FieldOverride itself has no userId column today). Buckets
   * the last 6 ISO weeks (Monday UTC), zero-padded so a sparkline has a
   * fixed x-axis whether or not the user was active that week.
   */
  async meSummary(workspaceId: string, userId: string): Promise<LearningMeView> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        created_at: Date;
        predicted: unknown;
        confirmed: unknown;
        adjustments: unknown;
      }>
    >`
      SELECT fo."createdAt" AS created_at,
             fo.predicted,
             fo.confirmed,
             fo.adjustments
      FROM "meetsy"."FieldOverride" fo
      JOIN "meetsy"."TaskPush" tp
        ON tp."runId" = fo."runId"
       AND tp."meetsyTaskId" = fo."meetsyTaskId"
      WHERE fo."workspaceId" = ${workspaceId}
        AND tp."pushedBy" = ${userId}
    `;

    // Precompute the last 6 ISO-week Monday starts, oldest first. Uses the
    // caller's clock — same rule as the SQL, so a row created today lands in
    // the "current week" bucket.
    const weekStarts = lastNWeekStarts(WEEKS_TO_RETURN, new Date());
    const buckets = new Map<string, LearningMeWeek>();
    for (const iso of weekStarts) {
      buckets.set(iso, {
        weekStart: iso,
        overrides: 0,
        agreements: 0,
        nudgesShown: 0,
        nudgesAccepted: 0,
      });
    }

    // Resolve names once for equality checks (same trick as `snapshot()`).
    const config = await this.prisma.workspacePushConfig.findUnique({
      where: { workspaceId },
      select: { assignableMembers: true },
    });
    const memberName = new Map<string, string>(
      ((config?.assignableMembers as Array<{ clickupUserId: string; name: string }> | null) ?? []).map(
        (m) => [m.clickupUserId, m.name],
      ),
    );

    for (const row of rows) {
      const iso = weekStartIso(row.created_at);
      const bucket = buckets.get(iso);
      // Rows outside the 6-week window still count toward totalOverrides
      // (which is the join's cardinality) but not toward any week.
      const predicted = (row.predicted as PredictionBundle | null) ?? {};
      const confirmed = (row.confirmed as ConfirmedBundle) ?? {};
      const adj = (row.adjustments as AdjustmentsBundle | null) ?? {};

      const predValue = predFieldValue(predicted.assigneeHint);
      const confValue = confirmed.clickupUserId
        ? (memberName.get(confirmed.clickupUserId) ?? null)
        : null;
      const agreed = predValue !== null && predValue === confValue;

      if (bucket) {
        bucket.overrides += 1;
        if (agreed) bucket.agreements += 1;
        if (adj.assignee) {
          bucket.nudgesShown += 1;
          if (adj.assignee.accepted) bucket.nudgesAccepted += 1;
        }
      }
    }

    return {
      userId,
      totalOverrides: rows.length,
      weeks: weekStarts.map((iso) => buckets.get(iso)!),
    };
  }

  /** "What we've learned": corrections + the two honest metrics, per field. */
  async summary(workspaceId: string): Promise<LearningSummaryView> {
    const total = await this.prisma.fieldOverride.count({ where: { workspaceId } });
    const snap = await this.snapshot(workspaceId);
    return {
      totalOverrides: total,
      fields: FIELDS.map((field) => {
        const a = snap[field];
        return {
          field,
          corrections: a.corrections,
          rawOverrideRate: a.rawOverrideRate,
          rawSample: a.rawSample,
          nudgeAcceptanceRate: a.nudgeAcceptanceRate,
          nudgeSample: a.nudgeSample,
          unresolved: a.unresolved,
        };
      }),
    };
  }

  /** Build a per-field record, resolving the confirmed id → a comparable name. */
  private toRecord(
    predicted: string | null,
    confirmedRaw: string | null,
    nameById: Map<string, string>,
    nudge: { shown: string; accepted: boolean } | undefined,
  ): FieldRecord {
    const confirmed = confirmedRaw ? (nameById.get(confirmedRaw) ?? null) : null;
    const unresolved = Boolean(confirmedRaw) && confirmed === null;
    return {
      predicted,
      confirmed,
      unresolved,
      nudgeShown: nudge?.shown ?? null,
      nudgeAccepted: nudge?.accepted ?? false,
    };
  }
}

/** A field prediction contributes its value only when it did NOT abstain. */
function predFieldValue(f: { value: string | null; abstain: boolean } | null | undefined): string | null {
  if (!f || f.abstain) return null;
  return f.value;
}

/** ISO week-start (Monday, UTC) of a Date, as `YYYY-MM-DD`. */
export function weekStartIso(input: Date): string {
  const d = new Date(input.getTime());
  // getUTCDay: Sun=0 … Sat=6. Shift so Monday=0 … Sunday=6.
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

/** The last N week-start ISOs, oldest first, ending at `now`'s week. */
export function lastNWeekStarts(n: number, now: Date): string[] {
  const currentMonday = new Date(`${weekStartIso(now)}T00:00:00Z`);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(currentMonday.getTime());
    d.setUTCDate(d.getUTCDate() - i * 7);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
