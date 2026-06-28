/**
 * Cross-app active-workspace cookie.
 *
 * Clicksy and Meetsy live on different origins (dev: localhost:5173 / :3001;
 * prod: example.com / meetsy.example.com). To keep the selected workspace in
 * sync BOTH ways, both apps read+write this single non-HttpOnly cookie — the
 * same mechanism Clicksy already uses for its shared `csrf` cookie. Cookies are
 * NOT port-scoped, so in dev a host-only cookie is shared across all localhost
 * ports automatically; in prod it must carry the parent domain (`.example.com`)
 * to span the two subdomains (see `cookieDomain`).
 *
 * Workspace selection is NOT a security boundary — the API re-validates
 * `orgId`+`workspaceId` on every request — so a client-written cookie is fine.
 */
export const WORKSPACE_COOKIE = "active_workspace_id";

/**
 * The `Domain` attribute to write so the cookie is shared with the sibling app.
 *  - `NEXT_PUBLIC_COOKIE_DOMAIN` override wins (set it for multi-label TLDs like
 *    `.example.co.uk` where the 2-label heuristic is wrong).
 *  - localhost / IP / single-label hosts → host-only (undefined): correct for
 *    dev, where cookies are already shared across ports on the same host.
 *  - otherwise derive the registrable parent as the last two labels with a
 *    leading dot (`meetsy.example.com` AND `example.com` → `.example.com`), so a
 *    forgotten env degrades gracefully instead of silently splitting the cookie.
 */
function cookieDomain(): string | undefined {
  const override = process.env.NEXT_PUBLIC_COOKIE_DOMAIN;
  if (override) return override;
  if (typeof window === "undefined") return undefined;
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

/** Read the shared workspace id from `document.cookie` (null on server/unset). */
export function readWorkspaceCookie(): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split("; ")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === WORKSPACE_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return null;
}

/**
 * Write the shared workspace id. `secure` is added ONLY on https — a client-side
 * `secure` cookie on http://localhost is silently rejected, which would break
 * dev sync with no error.
 */
export function writeWorkspaceCookie(id: string): void {
  if (typeof document === "undefined") return;
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
