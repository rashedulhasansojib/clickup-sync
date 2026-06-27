import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import * as crypto from "node:crypto";
import {
  SESSION_COOKIE,
  CSRF_COOKIE,
  MUTATING_METHODS,
  type AuthPrincipal,
} from "@clicksy/shared";
import { ConfigService } from "../config/config.service";
import { SessionService } from "./session.service";
import { IS_PUBLIC_KEY } from "./decorators";

/**
 * Authenticates the SAME `clickup_sync_sid` cookie Clicksy issues, validated
 * READ-ONLY against `public.sessions`/`public.users`. Mirrors Clicksy's
 * AuthGuard contract (machine cred → session cookie → CSRF double-submit) but
 * performs no writes. Registered globally as an APP_GUARD.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();

    // Optional machine credential — synthetic Owner for server-to-server calls.
    const apiKey = this.config.get("ADMIN_API_KEY");
    const provided = req.headers["x-admin-key"] as string | undefined;
    if (apiKey && provided && this.timingSafeEqual(apiKey, provided)) {
      // orgId is left empty for the machine principal in Phase 0 — the workspace
      // resolver falls back to the default workspace regardless of org.
      req.user = {
        userId: "machine",
        orgId: "",
        role: "OWNER",
        email: null,
        isMachine: true,
      } satisfies AuthPrincipal;
      return true;
    }

    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) throw new UnauthorizedException("Not authenticated");
    const row = await this.sessions.validate(token);
    if (!row) throw new UnauthorizedException("Session invalid or expired");

    // CSRF double-submit for mutating verbs (header must equal the csrf cookie).
    if (MUTATING_METHODS.has(req.method)) {
      const header = req.headers["x-csrf-token"] as string | undefined;
      const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
      if (!header || !cookie || header !== cookie) {
        throw new ForbiddenException("CSRF token mismatch");
      }
    }

    req.user = {
      userId: row.user.id,
      orgId: row.user.orgId,
      role: row.user.role,
      email: row.user.email,
      isMachine: false,
    } satisfies AuthPrincipal;
    return true;
  }

  private timingSafeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  }
}
