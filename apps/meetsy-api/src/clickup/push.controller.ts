import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import type { AuthPrincipal } from "@clicksy/shared";
import { CurrentUser } from "../auth/decorators";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { PushRunDto, PushRunSchema } from "./clickup.dto";
import { PushService } from "./push.service";

/**
 * Run-scoped push endpoints. Any authenticated user (the human review gate);
 * mutations require CSRF via the global AuthGuard.
 */
@Controller("runs/:id/push")
export class PushController {
  constructor(private readonly push: PushService) {}

  /** Push status/audit (+ assignee suggestions) for a run. */
  @Get()
  getStatus(@CurrentUser() user: AuthPrincipal, @Param("id") id: string) {
    return this.push.getStatus(user.orgId, id);
  }

  /** Push the (edited) approved tasks; idempotent per task. */
  @Post()
  pushTasks(
    @CurrentUser() user: AuthPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(PushRunSchema)) body: PushRunDto,
  ) {
    return this.push.pushTasks(user.orgId, id, body, user.userId);
  }
}
