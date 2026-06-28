/**
 * Cross-app active-workspace cookie (Clicksy side — mirror of
 * apps/meetsy-web/lib/workspace-cookie.ts).
 *
 * Clicksy and Meetsy are separate origins; this single non-HttpOnly cookie keeps
 * the selected workspace in sync BOTH ways (same trick as the shared `csrf`
 * cookie). Cookies aren't port-scoped, so a host-only cookie is shared across
 * localhost ports in dev; in prod it carries the parent domain (`.example.com`)
 * to span the two subdomains. Workspace selection is not a security boundary —
 * the API re-validates org+workspace per request — so a client-written cookie
 * is fine.
 */
export const WORKSPACE_COOKIE = "active_workspace_id";

/**
 * `Domain` to write so the cookie is shared with Meetsy. `VITE_COOKIE_DOMAIN`
 * override wins (multi-label TLDs); localhost/IP/single-label → host-only
 * (correct for dev); otherwise the registrable parent (last two labels) so a
 * forgotten env degrades gracefully instead of silently splitting the cookie.
 */
function cookieDomain(): string | undefined {
  const override = import.meta.env.VITE_COOKIE_DOMAIN as string | undefined;
  if (override) return override;
  const host = window.location.hostname;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^[0-9.]+$/.test(host) ||
    !host.includes(".")
  ) {
    return undefined;
  }
  return "." + host.split(".").slice(-2).join(".");
}

/** Read the shared workspace id from `document.cookie` (null if unset). */
export function readWorkspaceCookie(): string | null {
  const m = document.cookie.match(
    new RegExp("(?:^|; )" + WORKSPACE_COOKIE + "=([^;]*)"),
  );
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Write the shared workspace id. `secure` only on https — a client-side `secure`
 * cookie on http://localhost is silently rejected (would break dev sync).
 */
export function writeWorkspaceCookie(id: string): void {
  const parts = [
    `${WORKSPACE_COOKIE}=${encodeURIComponent(id)}`,
    "path=/",
    "samesite=lax",
    "max-age=31536000",
  ];
  const domain = cookieDomain();
  if (domain) parts.push(`domain=${domain}`);
  if (window.location.protocol === "https:") parts.push("secure");
  document.cookie = parts.join("; ");
}
