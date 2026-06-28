import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AssigneeResolverService } from "../clickup/assignee-resolver.service";
import type { AssignableMember } from "../clickup/clickup.types";
import { rankOwners } from "./assignment-rank";
import type { Neighbour } from "./prediction-prior";

/**
 * Phase 3.1 — smart assignment. For each extracted task, rank the assignable
 * member pool by OWNERSHIP PRECEDENT (who closed similar work, from the 2c.2 kNN
 * neighbours, conditioned on the predicted client to beat the base-rate echo),
 * with workload as a featherweight tie-break. Recommendation-only + abstain-first;
 * the human confirms (and that confirmation is logged as a FieldOverride).
 */
export interface AssignmentCandidate {
  clickupUserId: string | null; // null when the historical owner is NOT in the pool
  name: string;
  inPool: boolean;
  ownershipScore: number;
  closedSimilar: number;
  openTasks: number;
  trackedHours30d: number;
  evidenceTaskIds: string[];
}

export interface TaskAssignment {
  recommended: AssignmentCandidate | null; // top IN-POOL owner, or null when abstaining
  ranked: AssignmentCandidate[];
  abstain: boolean;
  conditionedOnClient: boolean;
  rationale: string;
}

/** Ownership scores within this fraction are a "tie" → broken by lighter load. */
const TIE_MARGIN = 0.1;

@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: AssigneeResolverService,
  ) {}

  /**
   * Rank owners per task from the (already-computed) neighbours, conditioning on
   * the MEETING-LEVEL client (set at upload — no longer per-task predicted) to
   * beat the base-rate echo. Best-effort: any failure leaves a task without an
   * assignment recommendation.
   */
  async rank(
    workspaceId: string,
    neighboursByTask: Record<string, Neighbour[]>,
    meetingClientName: string | null,
    members: AssignableMember[],
  ): Promise<Record<string, TaskAssignment>> {
    const out: Record<string, TaskAssignment> = {};
    if (members.length === 0) return out; // no candidate pool configured

    const workload = await this.loadWorkload(workspaceId, members);

    for (const [taskId, neighbours] of Object.entries(neighboursByTask)) {
      try {
        out[taskId] = this.rankOne(neighbours, meetingClientName, members, workload);
      } catch (err) {
        this.logger.warn(`Assignment skipped for task ${taskId}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  private rankOne(
    neighbours: Neighbour[],
    predictedClient: string | null,
    members: AssignableMember[],
    workload: Map<string, { openTasks: number; trackedHours30d: number }>,
  ): TaskAssignment {
    const ranking = rankOwners(neighbours, predictedClient);
    if (ranking.owners.length === 0) {
      return { recommended: null, ranked: [], abstain: true, conditionedOnClient: ranking.conditionedOnClient, rationale: "No clear owner from history." };
    }

    const candidates: AssignmentCandidate[] = ranking.owners.map((o) => {
      const memberId = this.resolver.resolve(o.name, members);
      const member = members.find((m) => m.clickupUserId === memberId);
      const load = (member && workload.get(member.clickupUserId)) ?? { openTasks: 0, trackedHours30d: 0 };
      return {
        clickupUserId: memberId,
        name: member?.name ?? o.name, // matched member name, or the raw history name when out-of-pool
        inPool: Boolean(memberId),
        ownershipScore: o.score,
        closedSimilar: o.closedSimilar,
        openTasks: load.openTasks,
        trackedHours30d: load.trackedHours30d,
        evidenceTaskIds: o.evidenceTaskIds,
      };
    });

    // Workload tie-break: among the in-pool candidates whose ownership is within
    // TIE_MARGIN of the top in-pool score, prefer the lighter (fewer open tasks).
    const inPool = candidates.filter((c) => c.inPool);
    let recommended: AssignmentCandidate | null = null;
    if (inPool.length > 0) {
      const topScore = inPool[0].ownershipScore;
      const contenders = inPool.filter((c) => topScore - c.ownershipScore <= TIE_MARGIN);
      contenders.sort((a, b) => a.openTasks - b.openTasks);
      recommended = contenders[0];
    }

    let abstain = false;
    let rationale: string;
    if (recommended) {
      const tieBroken = recommended.name !== inPool[0].name;
      rationale =
        `${recommended.name} — owns this work (${recommended.closedSimilar} closed similar` +
        `${ranking.conditionedOnClient ? `, ${predictedClient}` : ""})` +
        `; load: ${recommended.openTasks} open / ${recommended.trackedHours30d}h (30d)` +
        (tieBroken ? "; chosen over a similarly-experienced but busier teammate" : "");
    } else {
      // History points only to people OUTSIDE the assignable pool — surface that
      // honestly rather than a bare abstain.
      abstain = true;
      rationale = `History suggests ${candidates[0].name}, who is not in the assignable pool — pick an assignee.`;
    }

    return { recommended, ranked: candidates, abstain, conditionedOnClient: ranking.conditionedOnClient, rationale };
  }

  /**
   * Per-member workload: current OPEN-task count (by assignee name) + tracked
   * hours over the last 30 days (by user name). Computed once per run. Featherweight
   * — a thin signal here (few users/entries), used only as a tie-break.
   */
  private async loadWorkload(
    workspaceId: string,
    members: AssignableMember[],
  ): Promise<Map<string, { openTasks: number; trackedHours30d: number }>> {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [openTasks, entries] = await Promise.all([
      this.prisma.clickupTask.findMany({
        where: { workspaceId, isDeleted: false, closedDate: null },
        select: { assigneesNames: true },
      }),
      this.prisma.clickupTimeEntry.findMany({
        where: { workspaceId, startTime: { gte: since } },
        select: { userName: true, durationHours: true },
      }),
    ]);

    const map = new Map<string, { openTasks: number; trackedHours30d: number }>();
    for (const m of members) map.set(m.clickupUserId, { openTasks: 0, trackedHours30d: 0 });

    for (const t of openTasks) {
      for (const raw of (t.assigneesNames ?? "").split(",")) {
        const id = this.resolver.resolve(raw.trim(), members);
        if (id) map.get(id)!.openTasks += 1;
      }
    }
    for (const e of entries) {
      const id = this.resolver.resolve(e.userName ?? null, members);
      if (id) map.get(id)!.trackedHours30d += Number(e.durationHours);
    }
    for (const v of map.values()) v.trackedHours30d = Math.round(v.trackedHours30d * 10) / 10;
    return map;
  }
}
