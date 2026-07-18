import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import type { AuthPrincipal } from "@clicksy/shared";
import { CurrentUser, Roles } from "../../auth/decorators";
import { PushDeadLetterService } from "./push-dead-letter.service";

/**
 * v2 Phase 2 (PR-I) — Owner/Admin surface over permanently-failed pushes for a
 * workspace. Not yet wired to a UI (Phase 4); the endpoints exist so the
 * mechanism is complete and inspectable.
 */
@Controller("workspaces/:id/push/dead-letter")
@Roles("OWNER", "ADMIN")
export class PushDeadLetterController {
  constructor(private readonly deadLetter: PushDeadLetterService) {}

  /** GET — list unresolved dead-letters (newest first). */
  @Get()
  list(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") workspaceIdParam: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("includeResolved") includeResolved?: string,
  ) {
    const limit = clampInt(limitRaw, 1, 200, 50);
    const offset = clampInt(offsetRaw, 0, Number.MAX_SAFE_INTEGER, 0);
    return this.deadLetter.list(user.orgId, workspaceIdParam, {
      limit,
      offset,
      includeResolved: includeResolved === "true",
    });
  }

  /** POST — mark a dead-letter as resolved (hand-ACK; no re-enqueue). */
  @Post(":deadLetterId/resolve")
  resolve(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") workspaceIdParam: string,
    @Param("deadLetterId") deadLetterId: string,
  ) {
    return this.deadLetter.resolve(
      user.orgId,
      workspaceIdParam,
      deadLetterId,
      user.userId,
    );
  }
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
