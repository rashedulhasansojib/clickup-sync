import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthPrincipal, Role } from "@clicksy/shared";
import { ROLES_KEY } from "./decorators";

/** Enforces @Roles(...) on top of authentication. No @Roles → any authenticated. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const user = ctx.switchToHttp().getRequest().user as AuthPrincipal | undefined;
    if (!user) throw new ForbiddenException("Not authenticated");
    if (!required.includes(user.role)) throw new ForbiddenException("Insufficient role");
    return true;
  }
}
