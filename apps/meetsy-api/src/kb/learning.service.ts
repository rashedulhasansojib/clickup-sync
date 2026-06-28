import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  aggregateField,
  nudgeFor,
  type FieldAggregate,
  type FieldRecord,
  type CorrectionStat,
} from "./learning-aggregate";

/** The learnable fields (client + assignee resolve cleanly; sprint deferred). */
type LearnField = "client" | "assignee";
const FIELDS: LearnField[] = ["client", "assignee"];

export interface LearningSnapshot {
  client: FieldAggregate;
  assignee: FieldAggregate;
}

/** A gated nudge to surface for a fresh prediction, per field. */
export interface TaskAdjustments {
  client?: { from: string; to: string; count: number; agreement: number };
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

interface PredictionBundle {
  client?: { value: string | null; abstain: boolean } | null;
  assigneeHint?: { value: string | null; abstain: boolean } | null;
}
interface ConfirmedBundle {
  clientOptionId?: string | null;
  clickupUserId?: string | null;
}
interface AdjustmentsBundle {
  client?: { shown: string; accepted: boolean };
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
        select: { clientOptions: true, assignableMembers: true },
      }),
    ]);

    const clientName = new Map<string, string>(
      ((config?.clientOptions as Array<{ optionId: string; name: string }> | null) ?? []).map((o) => [o.optionId, o.name]),
    );
    const memberName = new Map<string, string>(
      ((config?.assignableMembers as Array<{ clickupUserId: string; name: string }> | null) ?? []).map((m) => [m.clickupUserId, m.name]),
    );

    const records: Record<LearnField, FieldRecord[]> = { client: [], assignee: [] };
    for (const row of rows) {
      const predicted = (row.predicted as PredictionBundle | null) ?? {};
      const confirmed = (row.confirmed as ConfirmedBundle) ?? {};
      const adj = (row.adjustments as AdjustmentsBundle | null) ?? {};
      records.client.push(
        this.toRecord(
          predFieldValue(predicted.client),
          confirmed.clientOptionId ?? null,
          clientName,
          adj.client,
        ),
      );
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
      client: aggregateField(records.client),
      assignee: aggregateField(records.assignee),
    };
  }

  /** Pure: apply the gated organic nudges of a snapshot to a fresh prediction bundle. */
  applyNudges(snap: LearningSnapshot, predicted: PredictionBundle): TaskAdjustments {
    const out: TaskAdjustments = {};
    const c = nudgeFor(snap.client, predFieldValue(predicted.client));
    if (c) out.client = { from: c.predicted, to: c.confirmed, count: c.count, agreement: c.agreement };
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
      if (adj.client || adj.assignee) out[taskId] = adj;
    }
    return out;
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
