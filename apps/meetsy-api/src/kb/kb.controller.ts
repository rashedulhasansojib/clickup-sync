import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Sse,
} from "@nestjs/common";
import { Observable, type Subscription } from "rxjs";
import type { AuthPrincipal } from "@clicksy/shared";
import { CurrentUser, Roles } from "../auth/decorators";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { WorkspaceResolver } from "../analysis/workspace.resolver";
import {
  KbOnboardingService,
  KbScopeOptionsView,
  KbSpaceView,
  KbStatusView,
} from "./kb-onboarding.service";
import { KbSearchService, KbSearchHit } from "./kb-search.service";
import { KbTasksService, KbTasksPage } from "./kb-tasks.service";
import { SummaryService } from "./summary.service";
import { KbSummaryView } from "./summary.types";
import { KbProgressEvent } from "./kb.queue";
import { OnboardDto, OnboardSchema } from "./kb.dto";

/**
 * Per-workspace KB endpoints. Workspace-scoped (`?workspaceId=` / default via
 * WorkspaceResolver) + session-authed by the global AuthGuard.
 */
@Controller("workspaces/:id/kb")
export class KbController {
  constructor(
    private readonly onboarding: KbOnboardingService,
    private readonly search: KbSearchService,
    private readonly tasks: KbTasksService,
    private readonly summary: SummaryService,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  /** Start onboarding for a window preset. Owner/Admin only. */
  @Post("onboard")
  @Roles("OWNER", "ADMIN")
  async onboard(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(OnboardSchema)) body: OnboardDto,
  ): Promise<KbStatusView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.onboarding.onboard(workspaceId, body.range, body.scope);
  }

  /**
   * The spaces Clicksy syncs for this workspace + how many tasks are mirrored.
   * Any authenticated user.
   */
  @Get("spaces")
  async spaces(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
  ): Promise<{ spaces: KbSpaceView[] }> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.onboarding.listSpaces(workspaceId);
  }

  /**
   * Distinct sub-filter options (folders/lists/clients) for the chosen spaces.
   * `?spaceIds=a,b` (comma-separated; empty entries ignored). Any authed user.
   */
  @Get("scope-options")
  async scopeOptions(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("spaceIds") spaceIds?: string,
  ): Promise<KbScopeOptionsView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    const ids = (spaceIds ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return this.onboarding.scopeOptions(workspaceId, ids.length ? ids : undefined);
  }

  /** Onboarding status + counts. Any authenticated user. */
  @Get("status")
  async status(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
  ): Promise<KbStatusView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    return this.onboarding.status(workspaceId);
  }

  /**
   * Optional live onboarding progress over SSE. Returns the Observable
   * SYNCHRONOUSLY (Nest's SSE handler subscribes to the return value and does not
   * unwrap a Promise) — the async workspace resolution happens inside it.
   */
  @Sse("status/stream")
  stream(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
  ): Observable<{ data: KbProgressEvent }> {
    return new Observable<{ data: KbProgressEvent }>((subscriber) => {
      let inner: Subscription | undefined;
      this.workspaces
        .resolve(user.orgId, id)
        .then((workspaceId) => {
          inner = this.onboarding.streamProgress(workspaceId).subscribe(subscriber);
        })
        .catch((err) => subscriber.error(err));
      return () => inner?.unsubscribe();
    });
  }

  /**
   * "What we learned" summary card: SQL-exact facts + a single LLM narrative.
   * Cached per workspace; `?refresh=1` recomputes. Any authenticated user.
   */
  @Get("summary")
  async summaryCard(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("refresh") refresh?: string,
  ): Promise<KbSummaryView> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    const force = refresh !== undefined && refresh !== "" && refresh !== "0" && refresh !== "false";
    return this.summary.getOrGenerate(workspaceId, force);
  }

  /**
   * v2 Phase 4 (PR-P) — paginated list of embedded ClickUp tasks in this KB.
   * Keyset-paged on `(updated_date DESC NULLS LAST, task_id DESC)`. `?filter`
   * narrows by task name / client / assignee (ILIKE). Any authenticated user.
   */
  @Get("tasks")
  async listTasks(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("cursor") cursor?: string,
    @Query("filter") filter?: string,
    @Query("limit") limit?: string,
  ): Promise<KbTasksPage> {
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    const parsedLimit =
      limit !== undefined && limit !== ""
        ? Number.parseInt(limit, 10) || undefined
        : undefined;
    return this.tasks.list(workspaceId, {
      cursor: cursor?.trim() || undefined,
      filter: filter?.trim() || undefined,
      limit: parsedLimit,
    });
  }

  /** Hybrid (vector + keyword, RRF) search. Any authenticated user. */
  @Get("search")
  async kbSearch(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Query("q") q?: string,
    @Query("k") k?: string,
  ): Promise<KbSearchHit[]> {
    if (!q || !q.trim()) throw new BadRequestException("q is required");
    const workspaceId = await this.workspaces.resolve(user.orgId, id);
    const limit = Math.min(Math.max(Number.parseInt(k ?? "10", 10) || 10, 1), 50);
    return this.search.search(workspaceId, q.trim(), limit);
  }
}
