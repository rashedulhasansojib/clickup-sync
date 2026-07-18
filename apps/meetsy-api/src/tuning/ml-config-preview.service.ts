import { Injectable, Logger } from "@nestjs/common";
import { type RunSnapshotPayload } from "@ma/shared";
import { PrismaService } from "../prisma/prisma.service";
import { classifyDuplicates } from "../kb/duplicate-bands";
import {
  LearningService,
  type LearningSnapshot,
} from "../kb/learning.service";
import {
  MlConfigService,
} from "../kb/ml-config.service";

/** Per-run delta shown on the /tuning preview sheet. */
export interface MlConfigPreviewRun {
  runId: string;
  meetingTitle: string | null;
  meetingDate: string | null;
  taskCount: number;
  duplicates: {
    baseline: { flag: number; suggest: number };
    candidate: { flag: number; suggest: number };
    /** How many tasks' classified sets differ between baseline and candidate. */
    changed: number;
  } | null;
}

export interface MlConfigPreviewGateSummary {
  patternsGating: number;
  patternsNearGate: number;
}

export interface MlConfigPreviewSkipped {
  field: string;
  reason: string;
}

export interface MlConfigPreviewView {
  runs: MlConfigPreviewRun[];
  gate: {
    baseline: MlConfigPreviewGateSummary;
    candidate: MlConfigPreviewGateSummary;
  };
  skipped: MlConfigPreviewSkipped[];
}

interface PreviewOpts {
  limit?: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

/**
 * v2 Phase 5 (PR-V) — replay the workspace's last N completed runs against a
 * candidate ML config and return per-run deltas. Currently replays ONLY the
 * duplicate classifier (from the per-run `neighboursByTask` frozen on
 * `AnalysisRun.result` at completion time). Every other tunable is either
 * workspace-wide (learning gate — one summary at the top of the response) or
 * requires re-running the KB / embed pipeline (simFloor / rrfK / models); those
 * appear in the `skipped` list with a documented reason.
 *
 * Compute is synchronous (pure math on pre-loaded JSON). See spec §5 for why
 * the `meetsy-ml-preview` BullMQ queue is deferred.
 */
@Injectable()
export class MlConfigPreviewService {
  private readonly logger = new Logger(MlConfigPreviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mlConfig: MlConfigService,
    private readonly learning: LearningService,
  ) {}

  async run(
    workspaceId: string,
    candidate: RunSnapshotPayload,
    opts: PreviewOpts = {},
  ): Promise<MlConfigPreviewView> {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    // Load last N completed runs newest-first. `AnalysisRunSnapshot` is
    // optional per landmine #2 — legacy runs from before Phase 0's snapshot
    // writer landed still qualify (we fall back to workspace defaults for the
    // baseline compare, marked explicitly in the response's baseline counts).
    const runs = await this.prisma.analysisRun.findMany({
      where: { workspaceId, status: "completed" },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        result: true,
        snapshot: { select: { tunables: true } },
        meeting: { select: { title: true, meetingDate: true } },
      },
    });

    const workspaceCfg = await this.mlConfig.forWorkspace(workspaceId);

    const runViews: MlConfigPreviewRun[] = [];
    for (const row of runs) {
      const parsed = safeParseResult(row.result);
      const neighboursByTask = parsed?.neighboursByTask ?? null;

      const baselineBands = extractBands(row.snapshot?.tunables, workspaceCfg.tunables);
      const candidateBands = {
        dupFlag: candidate.tunables.dupFlag,
        dupSuggest: candidate.tunables.dupSuggest,
      };

      let duplicates: MlConfigPreviewRun["duplicates"] = null;
      if (neighboursByTask && Object.keys(neighboursByTask).length > 0) {
        let baseFlag = 0;
        let baseSuggest = 0;
        let candFlag = 0;
        let candSuggest = 0;
        let changed = 0;
        for (const [, neighbours] of Object.entries(neighboursByTask)) {
          const raw = (neighbours ?? []).map((n) => ({
            taskId: n.taskId,
            sim: n.sim,
          }));
          const base = classifyDuplicates(raw, baselineBands);
          const cand = classifyDuplicates(raw, candidateBands);
          baseFlag += base.filter((h) => h.band === "flag").length;
          baseSuggest += base.filter((h) => h.band === "suggest").length;
          candFlag += cand.filter((h) => h.band === "flag").length;
          candSuggest += cand.filter((h) => h.band === "suggest").length;
          if (hitSetKey(base) !== hitSetKey(cand)) changed += 1;
        }
        duplicates = {
          baseline: { flag: baseFlag, suggest: baseSuggest },
          candidate: { flag: candFlag, suggest: candSuggest },
          changed,
        };
      }

      runViews.push({
        runId: row.id,
        meetingTitle: row.meeting?.title ?? null,
        meetingDate: row.meeting?.meetingDate
          ? row.meeting.meetingDate.toISOString()
          : null,
        taskCount: neighboursByTask ? Object.keys(neighboursByTask).length : 0,
        duplicates,
      });
    }

    // Gate summary is a single workspace-wide reading (patterns are aggregates
    // of the ENTIRE FieldOverride history, not per-run) — one row for baseline
    // and one for candidate.
    const snap = await this.learning.snapshot(workspaceId);
    const gate = {
      baseline: countGate(snap, workspaceCfg.tunables.minCorrections, workspaceCfg.tunables.minAgreement),
      candidate: countGate(snap, candidate.tunables.minCorrections, candidate.tunables.minAgreement),
    };

    return {
      runs: runViews,
      gate,
      skipped: skippedFields(),
    };
  }
}

/**
 * Extract `neighboursByTask` from the frozen `AnalysisRun.result` JSON. Kept
 * intentionally schema-free: `ReviewResultSchema` is strict about full
 * `NeighbourHit` shape (client/sprint/estimation/…) but this preview only
 * needs `taskId` + `sim` for the classifier, and a historical row missing
 * the richer fields (e.g. an older run written before the enrichment landed)
 * should not disqualify the entire replay.
 */
function safeParseResult(
  result: unknown,
): { neighboursByTask?: Record<string, Array<{ taskId: string; sim: number }>> } | null {
  if (!result || typeof result !== "object") return null;
  const raw = (result as { neighboursByTask?: unknown }).neighboursByTask;
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, Array<{ taskId: string; sim: number }>> = {};
  for (const [taskId, neighbours] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(neighbours)) continue;
    out[taskId] = neighbours
      .filter(
        (n): n is { taskId: string; sim: number } =>
          typeof n === "object" &&
          n !== null &&
          typeof (n as { taskId?: unknown }).taskId === "string" &&
          typeof (n as { sim?: unknown }).sim === "number",
      )
      .map((n) => ({ taskId: n.taskId, sim: n.sim }));
  }
  return { neighboursByTask: out };
}

function extractBands(
  snapshotTunables: unknown,
  fallback: { dupFlag: number; dupSuggest: number },
): { dupFlag: number; dupSuggest: number } {
  if (
    snapshotTunables &&
    typeof snapshotTunables === "object" &&
    typeof (snapshotTunables as { dupFlag?: unknown }).dupFlag === "number" &&
    typeof (snapshotTunables as { dupSuggest?: unknown }).dupSuggest === "number"
  ) {
    return {
      dupFlag: (snapshotTunables as { dupFlag: number }).dupFlag,
      dupSuggest: (snapshotTunables as { dupSuggest: number }).dupSuggest,
    };
  }
  return { dupFlag: fallback.dupFlag, dupSuggest: fallback.dupSuggest };
}

function hitSetKey(
  hits: Array<{ taskId: string; band: "flag" | "suggest" }>,
): string {
  return hits
    .slice()
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
    .map((h) => `${h.taskId}:${h.band}`)
    .join("|");
}

function countGate(
  snap: LearningSnapshot,
  minCorrections: number,
  minAgreement: number,
): MlConfigPreviewGateSummary {
  let gating = 0;
  let near = 0;
  const nearThreshold = Math.max(minCorrections - 1, 0);
  for (const field of Object.keys(snap) as Array<keyof LearningSnapshot>) {
    for (const c of snap[field].corrections) {
      if (c.count >= minCorrections && c.agreement >= minAgreement) gating += 1;
      else if (c.count >= nearThreshold && c.agreement >= minAgreement) near += 1;
    }
  }
  return { patternsGating: gating, patternsNearGate: near };
}

function skippedFields(): MlConfigPreviewSkipped[] {
  return [
    {
      field: "tunables.simFloor",
      reason: "Requires re-running the KB kNN search; deferred to a future async preview.",
    },
    {
      field: "tunables.minQualifying",
      reason: "Consumed inside prediction-prior; wiring deferred to Phase 5.x.",
    },
    {
      field: "tunables.closedWeight",
      reason: "Consumed in assignment ranking; wiring deferred to Phase 5.x.",
    },
    {
      field: "tunables.rrfK",
      reason: "Requires re-running hybrid search; deferred to a future async preview.",
    },
    {
      field: "tunables.novelMaxSimCutoff",
      reason: "Affects doc-embed pipeline; wiring deferred to Phase 5.x.",
    },
    {
      field: "tunables.linkMinSim",
      reason: "Affects doc↔task linking; wiring deferred to Phase 5.x.",
    },
    {
      field: "tunables.embedBatch",
      reason: "Read once at embed-worker startup; runtime change requires a redeploy.",
    },
    {
      field: "models.*",
      reason: "Pipeline stage effort is currently hardcoded; runtime consumption deferred.",
    },
  ];
}
