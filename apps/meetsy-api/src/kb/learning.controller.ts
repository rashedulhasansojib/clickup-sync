import { Controller, Get, Param, Query, Sse } from "@nestjs/common";
import { Observable, Subscription } from "rxjs";
import type { AuthPrincipal } from "@clicksy/shared";
import { CurrentUser } from "../auth/decorators";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import {
  LearningGateView,
  LearningMeView,
  LearningPatternHistoryView,
  LearningService,
  LearningSummaryView,
} from "./learning.service";
import { LearningEvent } from "./learning-stream.service";

/**
 * Phase 3.2 — "what we've learned": the correction stats + the two honest metrics
 * (raw-model override rate = KB-quality proxy; nudge-acceptance = loop lift).
 * Workspace-scoped + session-authed (global AuthGuard).
 */
@Controller("workspaces/:id/learning")
export class LearningController {
  constructor(
    private readonly learning: LearningService,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  @Get()
  async summary(@CurrentUser() user: AuthPrincipal, @Param("id") id: string): Promise<LearningSummaryView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.learning.summary(workspaceId);
  }

  /**
   * v2 Phase 1 — per-user weekly digest for the /home card. Any authenticated
   * user; the workspace resolver enforces same-org scoping. The `me` in the
   * path is a fixed literal, not a param — the user id comes from the session.
   */
  @Get("me")
  async me(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
  ): Promise<LearningMeView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.learning.meSummary(workspaceId, user.userId);
  }

  /**
   * v2 Phase 3 — the loop's thresholds. Any authenticated user. Workspace-
   * independent today; Phase 5's /tuning UI will make this per-workspace by
   * reading from WorkspaceMlConfig. Shape stays stable across that migration.
   */
  @Get("gate")
  async gate(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
  ): Promise<LearningGateView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.learning.gate(workspaceId);
  }

  /**
   * v2 Phase 3 — one pattern's timeline. `key` is the base64url-encoded slug
   * from `CorrectionStat.key`; a malformed key 400s, an unknown pattern 404s
   * (both handled inside the service). `?limit=` defaults to 50, capped 200.
   */
  @Get("patterns/:key/history")
  async patternHistory(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Param("key") key: string,
    @Query("limit") limitRaw?: string,
  ): Promise<LearningPatternHistoryView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    const limit = parseInt(limitRaw ?? "", 10);
    return this.learning.patternHistory(workspaceId, key, {
      limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
    });
  }

  /**
   * v2 Phase 3 (PR-N) — SSE of near-gate / gate-passed events for this
   * workspace. Fires when a FieldOverride write brings a pattern to the
   * `NEAR_GATE_THRESHOLD` (one shy of gating) or to `MIN_CORRECTIONS` (the
   * gate itself). The UI toasts via Sonner; missed events are harmless (the
   * next `/learning` page load re-derives from the summary).
   *
   * Mirrors `KbController.stream` — Observable returned SYNCHRONOUSLY (Nest's
   * SSE handler subscribes to the return value and does not unwrap a Promise);
   * the async workspace resolution happens inside.
   */
  @Sse("stream")
  stream(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
  ): Observable<{ data: LearningEvent }> {
    return new Observable<{ data: LearningEvent }>((subscriber) => {
      let inner: Subscription | undefined;
      this.workspaces
        .resolve(user.orgId, id)
        .then((workspaceId) => {
          inner = this.learning.streamEvents(workspaceId).subscribe(subscriber);
        })
        .catch((err) => subscriber.error(err));
      return () => inner?.unsubscribe();
    });
  }
}
