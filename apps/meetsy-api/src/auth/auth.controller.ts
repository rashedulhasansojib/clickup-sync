import { Controller, Get } from "@nestjs/common";
import type { AuthPrincipal } from "@clicksy/shared";
import { CurrentUser } from "./decorators";

/**
 * No login/register/refresh — Meetsy doesn't issue tokens. Authentication is the
 * shared `clickup_sync_sid` cookie (see AuthGuard). `GET /auth/me` echoes the
 * authenticated principal, handy for the frontend (Phase 0-frontend).
 */
@Controller("auth")
export class AuthController {
  @Get("me")
  me(@CurrentUser() user: AuthPrincipal): AuthPrincipal {
    return user;
  }
}
