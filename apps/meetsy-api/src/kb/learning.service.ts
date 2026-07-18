import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  aggregateField,
  decodePatternKey,
  nudgeFor,
  MIN_AGREEMENT,
  MIN_CORRECTIONS,
  NEAR_GATE_THRESHOLD,
  type FieldAggregate,
  type FieldRecord,
  type CorrectionStat,
} from "./learning-aggregate";
import { LearningCacheService } from "./learning-cache.service";
import { LearningStreamService, classifyThreshold } from "./learning-stream.service";
import { MlConfigService } from "./ml-config.service";

/** v2 Phase 3 — the learnable fields. Client left the learning loop (a
 * meeting-level value the user sets at upload, never predicted). Assignee
 * resolves cleanly via `WorkspacePushConfig.assignableMembers`; sprint via
 * `sprintLists`. Adding a new field means (a) FIELDS entry, (b) predicted
 * accessor in `predictedForField`, (c) confirmed accessor in `confirmedForField`,
 * (d) resolver map in `snapshot`, (e) branch in `push.service.computeAdjustments`. */
export type LearnField = "assignee" | "sprint";
export const FIELDS: LearnField[] = ["assignee", "sprint"];

export type LearningSnapshot = Record<LearnField, FieldAggregate>;

/** A gated nudge to surface for a fresh prediction, per field. */
export type TaskAdjustments = Partial<
  Record<LearnField, { from: string; to: string; count: number; agreement: number }>
>;

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
  /** v2 Phase 3 — sprint prediction, sibling to assigneeHint. */
  sprint?: { value: string | null; abstain: boolean } | null;
}
interface ConfirmedBundle {
  clickupUserId?: string | null;
  /** v2 Phase 3 — the ClickUp list id the task was pushed to. Maps to a sprint
   * name via `WorkspacePushConfig.sprintLists[]` — asymmetric with assignee's
   * name-resolution (documented in Phase 3 spec §3.1). */
  listId?: string | null;
}
interface AdjustmentsBundle {
  assignee?: { shown: string; accepted: boolean };
  /** v2 Phase 3 — sprint nudge audit, sibling to assignee. */
  sprint?: { shown: string; accepted: boolean };
}

export interface LearningGateView {
  minCorrections: number;
  minAgreement: number;
  nearGateThreshold: number;
  fields: LearnField[];
}

export interface LearningPatternHistoryEntry {
  runId: string;
  meetsyTaskId: string;
  createdAt: string;
  nudgeShown: boolean;
}

export interface LearningPatternHistoryView {
  key: string;
  field: LearnField;
  predicted: string;
  confirmed: string;
  count: number;
  agreement: number;
  gatePassed: boolean;
  entries: LearningPatternHistoryEntry[];
}

@Injectable()
export class LearningService {
  private readonly logger = new Logger(LearningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: LearningCacheService,
    private readonly stream: LearningStreamService,
    private readonly mlConfig: MlConfigService,
  ) {}

  /** v2 Phase 3 — expose the loop's thresholds. v2 Phase 5 — reads
   * per-workspace values from `WorkspaceMlConfig` (falling back to hardcoded
   * defaults via MlConfigService). `nearGateThreshold` is derived from
   * `minCorrections - 1` so it moves with the gate. */
  async gate(workspaceId: string): Promise<LearningGateView> {
    const cfg = await this.mlConfig.forWorkspace(workspaceId);
    return {
      minCorrections: cfg.tunables.minCorrections,
      minAgreement: cfg.tunables.minAgreement,
      nearGateThreshold: Math.max(cfg.tunables.minCorrections - 1, 0),
      fields: [...FIELDS],
    };
  }

  /** v2 Phase 3 — invalidate the cached snapshot after a FieldOverride write.
   * Called from `push.service.logFieldOverride`. Best-effort: never throws. */
  async invalidateCache(workspaceId: string): Promise<void> {
    await this.cache.invalidate(workspaceId);
  }

  /**
   * v2 Phase 3 (PR-N) — publish a near-gate / gate-passed event when the
   * just-written FieldOverride crossed a threshold. Called from
   * `push.service.logFieldOverride` AFTER the DB write + cache invalidation.
   * Best-effort — a publish miss only loses a toast (the next `/learning`
   * page load re-derives the pattern's state from the summary).
   *
   * Design note: we don't need to know pre-vs-post counts here. The
   * post-write snapshot's count is the authoritative "count after this
   * write". A nudge-influenced write doesn't contribute to the organic
   * count (see `learning-aggregate.ts:73-78`), so a nudge row can only
   * increment the count if we somehow bypassed the filter — which is
   * exactly why we consult the aggregate, not the raw counter.
   */
  async maybePublishThreshold(
    workspaceId: string,
    row: {
      predicted: unknown;
      confirmed: unknown;
      adjustments: unknown;
    },
  ): Promise<void> {
    try {
      const predicted = (row.predicted as PredictionBundle | null) ?? {};
      const confirmed = (row.confirmed as ConfirmedBundle) ?? {};
      const adj = (row.adjustments as AdjustmentsBundle | null) ?? {};
      const [snap, mlCfg] = await Promise.all([
        this.snapshot(workspaceId),
        this.mlConfig.forWorkspace(workspaceId),
      ]);
      const minCorrections = mlCfg.tunables.minCorrections;

      // Same resolvers `snapshot()` uses (they must match — an event whose
      // pattern isn't findable in the snapshot would confuse the UI).
      const config = await this.prisma.workspacePushConfig.findUnique({
        where: { workspaceId },
        select: { assignableMembers: true, sprintLists: true },
      });
      const memberName = new Map<string, string>(
        ((config?.assignableMembers as Array<{ clickupUserId: string; name: string }> | null) ?? []).map(
          (m) => [m.clickupUserId, m.name],
        ),
      );
      const sprintName = new Map<string, string>(
        ((config?.sprintLists as Array<{ listId: string; name: string }> | null) ?? []).map(
          (s) => [s.listId, s.name],
        ),
      );

      const perField: Array<{
        field: LearnField;
        predValue: string | null;
        confValue: string | null;
        nudgeShown: boolean;
      }> = [
        {
          field: "assignee",
          predValue: predFieldValue(predicted.assigneeHint),
          confValue: confirmed.clickupUserId
            ? memberName.get(confirmed.clickupUserId) ?? null
            : null,
          nudgeShown: Boolean(adj.assignee),
        },
        {
          field: "sprint",
          predValue: predFieldValue(predicted.sprint),
          confValue: confirmed.listId ? sprintName.get(confirmed.listId) ?? null : null,
          nudgeShown: Boolean(adj.sprint),
        },
      ];

      for (const { field, predValue, confValue, nudgeShown } of perField) {
        // Non-correction (agreed / abstain / unresolved) → nothing to fire.
        if (!predValue || !confValue || predValue === confValue) continue;
        // Nudge-influenced correction → not counted in the aggregate (organic
        // only). No threshold to publish because the count didn't change.
        if (nudgeShown) continue;
        const stat = snap[field].corrections.find(
          (c) => c.predicted === predValue && c.confirmed === confValue,
        );
        if (!stat) continue;
        const kind = classifyThreshold(stat.count, minCorrections);
        if (!kind) continue;
        await this.stream.publish({
          workspaceId,
          field,
          predicted: predValue,
          confirmed: confValue,
          count: stat.count,
          at: Date.now(),
          kind,
        });
      }
    } catch (err) {
      // Never surface — a threshold-notification failure must not affect
      // the push flow. The next page load re-derives from the summary.
      this.logger.warn(
        `maybePublishThreshold failed for workspace ${workspaceId}: ${(err as Error).message}`,
      );
    }
  }

  /** SSE feed of near-gate / gate-passed events for a workspace. */
  streamEvents(workspaceId: string) {
    return this.stream.subscribe(workspaceId);
  }

  /** Aggregate the workspace's override history into per-field stats (loads once). */
  async snapshot(workspaceId: string): Promise<LearningSnapshot> {
    // v2 Phase 3 — read-through cache. A miss falls through to the DB scan
    // then writes back before returning; a Redis outage transparently
    // degrades to Phase-2 always-DB behavior.
    const cached = await this.cache.read(workspaceId);
    if (cached) return cached;

    const [rows, config] = await Promise.all([
      this.prisma.fieldOverride.findMany({
        where: { workspaceId },
        select: { predicted: true, confirmed: true, adjustments: true },
      }),
      this.prisma.workspacePushConfig.findUnique({
        where: { workspaceId },
        select: { assignableMembers: true, sprintLists: true },
      }),
    ]);

    const memberName = new Map<string, string>(
      ((config?.assignableMembers as Array<{ clickupUserId: string; name: string }> | null) ?? []).map((m) => [m.clickupUserId, m.name]),
    );
    // v2 Phase 3 — resolve confirmed listId → sprint name via the workspace's
    // configured sprint lists. Missing/rotated listIds surface as `unresolved`
    // in the aggregate rather than silently vanishing.
    const sprintName = new Map<string, string>(
      ((config?.sprintLists as Array<{ listId: string; name: string }> | null) ?? []).map((s) => [s.listId, s.name]),
    );

    const records: Record<LearnField, FieldRecord[]> = { assignee: [], sprint: [] };
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
      records.sprint.push(
        this.toRecord(
          predFieldValue(predicted.sprint),
          confirmed.listId ?? null,
          sprintName,
          adj.sprint,
        ),
      );
    }

    const cfg = await this.mlConfig.forWorkspace(workspaceId);
    const gate = {
      minCorrections: cfg.tunables.minCorrections,
      minAgreement: cfg.tunables.minAgreement,
    };
    const snap: LearningSnapshot = {
      assignee: aggregateField("assignee", records.assignee, gate),
      sprint: aggregateField("sprint", records.sprint, gate),
    };
    // Write-back (best-effort — a cache failure only affects the next read).
    await this.cache.write(workspaceId, snap);
    return snap;
  }

  /**
   * v2 Phase 3 — per-pattern history for a `/learning/patterns/:key/history`
   * drill-down. Decodes the pattern key, loads the resolved snapshot to grab
   * the pattern's aggregate stats, then joins FieldOverride rows in
   * chronological order and filters to those matching the pattern's
   * (field, predicted, confirmed) after name resolution.
   *
   * Uses the SAME resolvers as `snapshot()` so a row that appears in the
   * pattern's aggregate `count` also appears in the history — no drift
   * between the summary and its drilldown.
   */
  async patternHistory(
    workspaceId: string,
    key: string,
    opts: { limit: number } = { limit: 50 },
  ): Promise<LearningPatternHistoryView> {
    let decoded: { field: string; predicted: string; confirmed: string };
    try {
      decoded = decodePatternKey(key);
    } catch (err) {
      throw new BadRequestException(`Invalid pattern key: ${(err as Error).message}`);
    }
    if (!FIELDS.includes(decoded.field as LearnField)) {
      throw new BadRequestException(`Unknown field in pattern key: ${decoded.field}`);
    }
    const field = decoded.field as LearnField;

    const snap = await this.snapshot(workspaceId);
    const stat = snap[field].corrections.find(
      (c) => c.predicted === decoded.predicted && c.confirmed === decoded.confirmed,
    );
    if (!stat) {
      throw new NotFoundException(
        `Pattern ${decoded.predicted} → ${decoded.confirmed} not found in ${field} history`,
      );
    }

    const limit = Math.min(Math.max(opts.limit, 1), 200);
    // Newest-first scan of FieldOverride rows for the workspace. Ordering is
    // fine at the workspace-index level; we filter to the pattern's
    // (predicted, confirmed) in-memory after name resolution.
    const rows = await this.prisma.fieldOverride.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      select: {
        runId: true,
        meetsyTaskId: true,
        createdAt: true,
        predicted: true,
        confirmed: true,
        adjustments: true,
      },
      take: 500, // cap the scan; enough to gather `limit` matches in nearly all workspaces
    });

    const config = await this.prisma.workspacePushConfig.findUnique({
      where: { workspaceId },
      select: { assignableMembers: true, sprintLists: true },
    });
    const memberName = new Map<string, string>(
      ((config?.assignableMembers as Array<{ clickupUserId: string; name: string }> | null) ?? []).map(
        (m) => [m.clickupUserId, m.name],
      ),
    );
    const sprintName = new Map<string, string>(
      ((config?.sprintLists as Array<{ listId: string; name: string }> | null) ?? []).map(
        (s) => [s.listId, s.name],
      ),
    );

    const entries: LearningPatternHistoryEntry[] = [];
    for (const row of rows) {
      if (entries.length >= limit) break;
      const predicted = (row.predicted as PredictionBundle | null) ?? {};
      const confirmed = (row.confirmed as ConfirmedBundle) ?? {};
      const adj = (row.adjustments as AdjustmentsBundle | null) ?? {};
      const predValue =
        field === "assignee"
          ? predFieldValue(predicted.assigneeHint)
          : predFieldValue(predicted.sprint);
      const confValue =
        field === "assignee"
          ? confirmed.clickupUserId
            ? memberName.get(confirmed.clickupUserId) ?? null
            : null
          : confirmed.listId
            ? sprintName.get(confirmed.listId) ?? null
            : null;
      if (predValue !== decoded.predicted || confValue !== decoded.confirmed) continue;
      const nudgeShown = field === "assignee" ? Boolean(adj.assignee) : Boolean(adj.sprint);
      entries.push({
        runId: row.runId,
        meetsyTaskId: row.meetsyTaskId,
        createdAt: row.createdAt.toISOString(),
        nudgeShown,
      });
    }

    return {
      key: stat.key,
      field,
      predicted: stat.predicted,
      confirmed: stat.confirmed,
      count: stat.count,
      agreement: stat.agreement,
      gatePassed: stat.gatePassed,
      entries,
    };
  }

  /** Pure: apply the gated organic nudges of a snapshot to a fresh prediction bundle. */
  applyNudges(snap: LearningSnapshot, predicted: PredictionBundle): TaskAdjustments {
    const out: TaskAdjustments = {};
    const a = nudgeFor(snap.assignee, predFieldValue(predicted.assigneeHint));
    if (a) out.assignee = { from: a.predicted, to: a.confirmed, count: a.count, agreement: a.agreement };
    const s = nudgeFor(snap.sprint, predFieldValue(predicted.sprint));
    if (s) out.sprint = { from: s.predicted, to: s.confirmed, count: s.count, agreement: s.agreement };
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
      // Emit the row if ANY field's nudge fired (Phase 3 expanded to sprint).
      if (adj.assignee || adj.sprint) out[taskId] = adj;
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
        // v2 Phase 3 — count ANY field's nudge (assignee or sprint) so the
        // /home digest honestly reflects the loop as it expands. `accepted`
        // on each field is a separate signal; either accepted nudge counts.
        const nudges = [adj.assignee, adj.sprint].filter(
          (n): n is { shown: string; accepted: boolean } => Boolean(n),
        );
        if (nudges.length > 0) {
          bucket.nudgesShown += nudges.length;
          bucket.nudgesAccepted += nudges.filter((n) => n.accepted).length;
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
