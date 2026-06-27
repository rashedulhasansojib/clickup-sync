/**
 * Cookie-session auth helpers (Phase 0 — Meetsy adopts Clicksy's cookie session).
 *
 * Meetsy no longer issues or stores tokens. Authentication is the shared,
 * HTTP-only `clickup_sync_sid` cookie that Clicksy sets (sent automatically to
 * meetsy.<domain> once the cookie carries a parent `Domain`). The browser owns
 * that cookie; this module only deals with:
 *   - the non-HTTP-only `csrf` cookie (read for the double-submit header), and
 *   - redirecting unauthenticated users to CLICKSY's login.
 *
 * There is no Meetsy login/register and nothing is persisted client-side.
 */

/** Org roles, matching Clicksy's Prisma `Role` enum (mirrors `@clicksy/shared`). */
export type Role = "OWNER" | "ADMIN" | "MEMBER";

/**
 * Identity returned by `GET /auth/me` — the principal the backend AuthGuard
 * attaches to every authenticated request. Shape mirrors `@clicksy/shared`'s
 * `AuthPrincipal` (we can't import it: that package isn't a web dependency, and
 * `@ma/shared`'s `AuthUser` is the retired JWT shape).
 */
export interface AuthPrincipal {
  userId: string;
  orgId: string;
  role: Role;
  email: string | null;
  isMachine: boolean;
}

/** Non-HTTP-only CSRF cookie name (double-submit; matches Clicksy/`@clicksy/shared`). */
const CSRF_COOKIE = "csrf";

/**
 * Clicksy's login URL. Unauthenticated Meetsy users are sent here (cross-origin),
 * with a `redirect` back to the current Meetsy page. Build-time baked like
 * `NEXT_PUBLIC_API_URL`; the dev default keeps `next build` green with no env set.
 */
export const CLICKSY_LOGIN_URL =
  process.env.NEXT_PUBLIC_CLICKSY_LOGIN_URL ?? "http://localhost:5173/login";

/**
 * Read a cookie value by name from `document.cookie`. Returns the RAW value —
 * NOT decoded — because the CSRF double-submit compares the header against the
 * cookie byte-for-byte (Clicksy's token isn't percent-encoded).
 */
export function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(prefix)) return part.slice(prefix.length);
  }
  return null;
}

/** The current CSRF token (from the `csrf` cookie), or null if absent. */
export function getCsrfToken(): string | null {
  return readCookie(CSRF_COOKIE);
}

/**
 * Redirect the browser to Clicksy's login, preserving where to come back to.
 * Cross-origin navigation, so there's no in-app redirect loop to guard against.
 */
export function redirectToClicksyLogin(): void {
  if (typeof window === "undefined") return;
  const back = window.location.href;
  window.location.assign(
    `${CLICKSY_LOGIN_URL}?redirect=${encodeURIComponent(back)}`,
  );
}
