import { Body, Controller, Param, Post } from "@nestjs/common";
import { z } from "zod";
import type { AuthPrincipal } from "@clicksy/shared";
import { CurrentUser } from "../../auth/decorators";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { PushRetryService } from "./push-retry.service";

/**
 * v2 Phase 2 (PR-I) — bulk retry endpoint for failed pushes. Same auth model
 * as PushController (any authenticated user; CSRF via global AuthGuard).
 * Co-located with the rest of the push flow in `clickup/`.
 */
export const RetryFailedPushBodySchema = z.object({
  taskIds: z.array(z.string()).optional(),
});
export type RetryFailedPushBody = z.infer<typeof RetryFailedPushBodySchema>;

@Controller("runs/:id/push")
export class PushRetryController {
  constructor(private readonly retry: PushRetryService) {}

  /** Enqueue a retry job for every failed push on this run (optionally filtered). */
  @Post("retry")
  retryFailed(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RetryFailedPushBodySchema)) body: RetryFailedPushBody,
  ) {
    return this.retry.retryFailed(user.orgId, id, body.taskIds);
  }
}
