import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { AuthPrincipal, Role } from "@clicksy/shared";

/** Marks a route as not requiring authentication (skips the global AuthGuard). */
export const IS_PUBLIC_KEY = "isPublic";
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

/** Restrict a route to specific org roles: `@Roles("OWNER", "ADMIN")`. */
export const ROLES_KEY = "roles";
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Injects the authenticated principal: `@CurrentUser() user: AuthPrincipal`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal =>
    ctx.switchToHttp().getRequest().user as AuthPrincipal,
);
