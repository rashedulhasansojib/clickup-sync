import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { ParticipantAlias } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ClickUpClient } from "../clickup/clickup.client";
import { normalizeAlias } from "./roster-memory.service";
import type {
  BulkImportParticipantAliasBody,
  BulkImportResult,
  CreateParticipantAliasBody,
  ParticipantAliasesPage,
  ParticipantAliasRow,
  UpdateParticipantAliasBody,
} from "./participant-aliases.dto";

/**
 * v2 Phase 7 PR-D — CRUD + list for the /kb Participants tab.
 *
 * Read shape denormalizes the ClickUp member name server-side so all roles
 * can browse the KB without needing Owner/Admin access to `/clickup/members`.
 * Writes are enforced Owner/Admin by the controller — this service assumes the
 * caller is authorized.
 */
@Injectable()
export class RosterBrowserService {
  private readonly logger = new Logger(RosterBrowserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clickup: ClickUpClient,
  ) {}

  /** Keyset-cursored list (newest-lastSeenAt first). `filter` matches the raw
   * alias or the joined ClickUp member name — case-insensitive substring. */
  async list(
    workspaceId: string,
    opts: { filter?: string; cursor?: string; limit?: number },
  ): Promise<ParticipantAliasesPage> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const filter = opts.filter?.trim() ?? "";
    const memberNameById = await this.getMemberNameMap(workspaceId);

    // The alias search is cheap (indexed on workspaceId, small rows). The
    // ClickUp-member-name filter is applied in-memory: we only join names post-
    // fetch, so filter first by alias substring (SQL) THEN post-filter by name.
    const where = {
      workspaceId,
      ...(filter
        ? {
            OR: [
              { alias: { contains: filter.toLowerCase() } },
              { aliasRaw: { contains: filter, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    // Cursor is the base64-encoded (lastSeenAt.iso|id) tuple from the previous
    // page's last row. Fetch limit+1 to know if there's more.
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    const rows = await this.prisma.participantAlias.findMany({
      where: {
        ...where,
        ...(cursor
          ? {
              OR: [
                { lastSeenAt: { lt: cursor.lastSeenAt } },
                {
                  AND: [
                    { lastSeenAt: cursor.lastSeenAt },
                    { id: { gt: cursor.id } },
                  ],
                },
              ],
            }
          : {}),
      },
      orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? encodeCursor(page[page.length - 1]!.lastSeenAt, page[page.length - 1]!.id)
      : null;

    // Total is over the same base `where` (ignoring cursor), for the pagination footer.
    const total = await this.prisma.participantAlias.count({ where });

    // If filter is set AND matched no rows via alias, additionally search by
    // joined member name (unavoidable in-memory pass — worst case: workspace-wide
    // ClickUp members list is small). Only executed on empty-alias-match to
    // avoid a duplicate scan.
    let finalRows = page.map((r) => toRow(r, memberNameById));
    if (filter && finalRows.length === 0 && !opts.cursor) {
      const all = await this.prisma.participantAlias.findMany({
        where: { workspaceId },
        orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
        take: 500,
      });
      const needle = filter.toLowerCase();
      finalRows = all
        .map((r) => toRow(r, memberNameById))
        .filter((r) => r.clickupName?.toLowerCase().includes(needle))
        .slice(0, limit);
    }

    return { rows: finalRows, nextCursor, total };
  }

  /** Manual seed: create or overwrite a mapping. Alias key is normalized. */
  async create(
    workspaceId: string,
    userId: string,
    body: CreateParticipantAliasBody,
  ): Promise<ParticipantAliasRow> {
    const alias = normalizeAlias(body.aliasRaw);
    if (!alias) {
      throw new ConflictException(
        "aliasRaw is empty after normalization (no letters/numbers)",
      );
    }
    const memberNameById = await this.getMemberNameMap(workspaceId);
    // If clickupUserId points at a real member, its name is joinable; if the
    // caller passes a departed user id we still write (the row is a hint; the
    // suggest path already handles "row exists → member missing" as a miss).
    const source =
      body.clickupUserId === null ? "user_blocklisted" : "admin_seeded";

    const row = await this.prisma.participantAlias.upsert({
      where: { workspace_alias_unique: { workspaceId, alias } },
      create: {
        workspaceId,
        alias,
        aliasRaw: body.aliasRaw,
        clickupUserId: body.clickupUserId,
        source,
        confirmations: 1,
        createdBy: userId,
      },
      update: {
        aliasRaw: body.aliasRaw,
        clickupUserId: body.clickupUserId,
        source,
        // Manual re-seed does NOT increment the human-confirmation counter.
        // Bump `lastSeenAt` so the row surfaces at the top of the KB list.
        lastSeenAt: new Date(),
      },
    });
    return toRow(row, memberNameById);
  }

  /** Update mapping target and/or display text on an existing row. */
  async update(
    workspaceId: string,
    aliasId: string,
    body: UpdateParticipantAliasBody,
  ): Promise<ParticipantAliasRow> {
    const existing = await this.prisma.participantAlias.findFirst({
      where: { id: aliasId, workspaceId },
    });
    if (!existing) {
      throw new NotFoundException(`Alias ${aliasId} not found`);
    }
    const memberNameById = await this.getMemberNameMap(workspaceId);

    // If `clickupUserId` changed to null this becomes a blocklist row; if it
    // changed to non-null this becomes an admin-seeded mapping. `aliasRaw`-only
    // edits keep the source untouched.
    let nextSource = existing.source;
    if (body.clickupUserId !== undefined) {
      nextSource = body.clickupUserId === null ? "user_blocklisted" : "admin_seeded";
    }

    const updated = await this.prisma.participantAlias.update({
      where: { id: aliasId },
      data: {
        ...(body.aliasRaw !== undefined ? { aliasRaw: body.aliasRaw } : {}),
        ...(body.clickupUserId !== undefined
          ? { clickupUserId: body.clickupUserId }
          : {}),
        source: nextSource,
        lastSeenAt: new Date(),
      },
    });
    return toRow(updated, memberNameById);
  }

  /** Hard delete — the row disappears from the KB. The user can re-teach next
   * confirmation. Prefer this over "set null clickupUserId" when the goal is
   * "just forget this alias entirely". */
  async delete(workspaceId: string, aliasId: string): Promise<void> {
    const existing = await this.prisma.participantAlias.findFirst({
      where: { id: aliasId, workspaceId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException(`Alias ${aliasId} not found`);
    }
    await this.prisma.participantAlias.delete({ where: { id: aliasId } });
  }

  /** CSV bulk seed — one upsert per row. Alias collisions inside the request
   * are resolved by "last wins" (Map dedupe). Rows with an empty normalized
   * alias are counted as skipped. */
  async bulkImport(
    workspaceId: string,
    userId: string,
    body: BulkImportParticipantAliasBody,
  ): Promise<BulkImportResult> {
    // De-dupe within the batch on the normalized alias — last row wins.
    const byAlias = new Map<
      string,
      { aliasRaw: string; clickupUserId: string | null }
    >();
    let skipped = 0;
    for (const r of body.rows) {
      const alias = normalizeAlias(r.aliasRaw);
      if (!alias) {
        skipped++;
        continue;
      }
      byAlias.set(alias, {
        aliasRaw: r.aliasRaw,
        clickupUserId: r.clickupUserId ?? null,
      });
    }

    let imported = 0;
    let updated = 0;
    for (const [alias, row] of byAlias) {
      try {
        const source =
          row.clickupUserId === null ? "user_blocklisted" : "admin_seeded";
        const existing = await this.prisma.participantAlias.findUnique({
          where: { workspace_alias_unique: { workspaceId, alias } },
          select: { id: true },
        });
        if (existing) {
          await this.prisma.participantAlias.update({
            where: { id: existing.id },
            data: {
              aliasRaw: row.aliasRaw,
              clickupUserId: row.clickupUserId,
              source,
              lastSeenAt: new Date(),
            },
          });
          updated++;
        } else {
          await this.prisma.participantAlias.create({
            data: {
              workspaceId,
              alias,
              aliasRaw: row.aliasRaw,
              clickupUserId: row.clickupUserId,
              source,
              confirmations: 1,
              createdBy: userId,
            },
          });
          imported++;
        }
      } catch (err) {
        skipped++;
        this.logger.warn(
          `Bulk import row failed (workspace=${workspaceId}, alias="${alias}"): ${(err as Error).message}`,
        );
      }
    }
    return { imported, updated, skipped };
  }

  /**
   * Best-effort ClickUp member-name lookup. A missing token / disconnected
   * ClickUp integration yields an empty map — callers still render rows, just
   * without the joined name. Never throws.
   */
  private async getMemberNameMap(workspaceId: string): Promise<Map<string, string>> {
    try {
      const members = await this.clickup.getAssignableMembers(workspaceId);
      return new Map(members.map((m) => [m.clickupUserId, m.name]));
    } catch (err) {
      this.logger.warn(
        `ClickUp member lookup skipped for workspace ${workspaceId}: ${(err as Error).message}`,
      );
      return new Map();
    }
  }
}

function toRow(
  r: ParticipantAlias,
  memberNameById: Map<string, string>,
): ParticipantAliasRow {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    alias: r.alias,
    aliasRaw: r.aliasRaw,
    clickupUserId: r.clickupUserId,
    clickupName: r.clickupUserId ? (memberNameById.get(r.clickupUserId) ?? null) : null,
    source: r.source,
    confirmations: r.confirmations,
    lastSeenAt: r.lastSeenAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
  };
}

function encodeCursor(lastSeenAt: Date, id: string): string {
  return Buffer.from(`${lastSeenAt.toISOString()}|${id}`, "utf8").toString(
    "base64url",
  );
}
function decodeCursor(raw: string): { lastSeenAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    if (!iso || !id) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return { lastSeenAt: d, id };
  } catch {
    return null;
  }
}
