import { Injectable, Logger } from "@nestjs/common";
import type { Participant } from "@ma/shared";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Per-confirmation summary returned by `learnFromConfirmation`. Powers the
 * PR-C toast: "Learned N, corrected M, blocklisted K."
 *   kept        — user re-confirmed an existing (or system-suggested) mapping
 *   learned     — user picked a member for a name we had no suggestion for
 *   corrected   — user swapped one member for another (KB or heuristic → new)
 *   blocklisted — user clicked "Never match this name"
 *   skipped     — nothing to learn (blank name, both-null, cleared-without-flag,
 *                 or the DB write failed and we swallowed it)
 */
export interface LearnStats {
  kept: number;
  learned: number;
  corrected: number;
  blocklisted: number;
  skipped: number;
}

/**
 * v2 Phase 7 — per-workspace roster memory.
 *
 * The stateless three-tier heuristic (`AssigneeResolverService`) makes the same
 * mistake forever. This service closes the loop:
 *   - READ (PR-B): callers ask `suggest(workspaceId, name)` before the heuristic;
 *     a KB hit shortcuts the whole resolver chain.
 *   - WRITE (PR-A, wired here): every `confirmRoster` call diffs suggested vs
 *     confirmed and UPSERTs the learned mappings — pure code, no LLM.
 *
 * Alias key: NORMALIZED lowercase, single-spaced, punctuation stripped (so
 * "Dan L." and "Dan L" collide into one KB row).
 *
 * The write path is best-effort: any Prisma error is warn-logged and swallowed,
 * mirroring `AnalysisService.suggestClickupMembers` — a KB write must never block
 * a meeting from progressing to analysis.
 */
@Injectable()
export class RosterMemoryService {
  private readonly logger = new Logger(RosterMemoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * KB-first lookup for a single participant name. Returns:
   *   - `{ clickupUserId, source: "kb", confirmations }` on a mapped hit
   *   - `{ clickupUserId: null, source: "kb" }` on a blocklist hit
   *   - `null` on miss (caller falls through to heuristic).
   *
   * Not consumed until PR-B — kept here so the read + write paths live together.
   */
  async suggest(
    workspaceId: string,
    name: string,
  ): Promise<{ clickupUserId: string | null; source: "kb"; confirmations?: number } | null> {
    const alias = normalizeAlias(name);
    if (!alias) return null;
    try {
      const row = await this.prisma.participantAlias.findUnique({
        where: { workspace_alias_unique: { workspaceId, alias } },
        select: { clickupUserId: true, confirmations: true },
      });
      if (!row) return null;
      return {
        clickupUserId: row.clickupUserId,
        source: "kb",
        confirmations: row.confirmations,
      };
    } catch (err) {
      this.logger.warn(
        `Roster KB read failed (workspace=${workspaceId}, alias="${alias}"): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Diff suggested vs confirmed roster and UPSERT learned mappings.
   *
   * The diff is pure code (see docs/superpowers/specs/2026-07-19-… §4.2). Per
   * participant (matched by stable `id`):
   *
   *   suggested.uid  |  confirmed.uid  |  action                                | write
   *   ─────────────  |  ─────────────  |  ─────────────                         | ─────────────
   *   X              |  X              |  KEPT non-null                         | user_confirmed (confirmations +=1)
   *   X or null      |  Y (!= X, !=null)|  CORRECTED                            | user_corrected (confirmations=1)
   *   X              |  null           |  CLEARED (no explicit blocklist yet)   | skip (PR-C ships explicit blocklist)
   *   null           |  null           |  NO-OP                                 | skip
   *
   * Returns per-bucket counts so the caller (or PR-C toast) can summarize.
   */
  async learnFromConfirmation(input: {
    workspaceId: string;
    userId: string;
    suggested: readonly Participant[];
    confirmed: readonly Participant[];
  }): Promise<LearnStats> {
    const stats: LearnStats = { learned: 0, corrected: 0, kept: 0, blocklisted: 0, skipped: 0 };
    const suggestedById = new Map(input.suggested.map((p) => [p.id, p]));

    for (const c of input.confirmed) {
      const displayName = c.displayName?.trim() ?? "";
      const alias = normalizeAlias(displayName);
      // Skip empty/generic aliases and rows we can't key on.
      if (!alias) {
        stats.skipped++;
        continue;
      }

      const s = suggestedById.get(c.id);
      const suggestedUid = s?.clickupUserId ?? null;
      const confirmedUid = c.clickupUserId ?? null;
      const explicitlyBlocklisted = c.blocklist === true && confirmedUid === null;

      // Explicit blocklist (user clicked "Never match this name") — write the
      // blocklist row even if the field was already null before.
      if (explicitlyBlocklisted) {
        try {
          await this.prisma.participantAlias.upsert({
            where: { workspace_alias_unique: { workspaceId: input.workspaceId, alias } },
            create: {
              workspaceId: input.workspaceId,
              alias,
              aliasRaw: displayName,
              clickupUserId: null,
              source: "user_blocklisted",
              confirmations: 1,
              createdBy: input.userId,
            },
            update: {
              clickupUserId: null,
              source: "user_blocklisted",
              confirmations: 1,
              aliasRaw: displayName,
              lastSeenAt: new Date(),
            },
          });
          stats.blocklisted++;
        } catch (err) {
          stats.skipped++;
          this.logger.warn(
            `Roster KB blocklist failed (workspace=${input.workspaceId}, alias="${alias}"): ${(err as Error).message}`,
          );
        }
        continue;
      }

      // Both null → nothing to learn.
      if (suggestedUid === null && confirmedUid === null) {
        stats.skipped++;
        continue;
      }
      // Cleared without an explicit blocklist flag — treat as a no-op (user may
      // have just been editing and hasn't decided). Prevents accidental blocklist.
      if (suggestedUid !== null && confirmedUid === null) {
        stats.skipped++;
        continue;
      }

      const kept = suggestedUid !== null && suggestedUid === confirmedUid;
      const source = kept ? "user_confirmed" : "user_corrected";

      try {
        await this.prisma.participantAlias.upsert({
          where: { workspace_alias_unique: { workspaceId: input.workspaceId, alias } },
          create: {
            workspaceId: input.workspaceId,
            alias,
            aliasRaw: displayName,
            clickupUserId: confirmedUid,
            source,
            confirmations: 1,
            createdBy: input.userId,
          },
          update: kept
            ? {
                confirmations: { increment: 1 },
                lastSeenAt: new Date(),
                aliasRaw: displayName,
                // Keep the row's existing source unless it was blocklist/corrected —
                // a repeat confirmation upgrades to `user_confirmed`.
                source: "user_confirmed",
                clickupUserId: confirmedUid,
              }
            : {
                // Correction resets the confirmation counter — this is a NEW mapping.
                confirmations: 1,
                lastSeenAt: new Date(),
                aliasRaw: displayName,
                source: "user_corrected",
                clickupUserId: confirmedUid,
              },
        });
        if (kept) stats.kept++;
        else if (suggestedUid === null) stats.learned++;
        else stats.corrected++;
      } catch (err) {
        stats.skipped++;
        this.logger.warn(
          `Roster KB write failed (workspace=${input.workspaceId}, alias="${alias}"): ${(err as Error).message}`,
        );
      }
    }

    return stats;
  }
}

/**
 * Normalize a participant name into the KB alias key.
 *
 * Lowercase, collapse internal whitespace, strip punctuation (so "Dan L." →
 * "dan l"), keep letters/numbers/spaces including Unicode letters (so "Zoë" →
 * "zoë" — case-insensitive but preserved). Empty input → "".
 */
export function normalizeAlias(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
