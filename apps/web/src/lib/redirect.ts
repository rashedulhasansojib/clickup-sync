/**
 * Open-redirect-safe resolution of a `?redirect=` param for the Clicksy↔Meetsy
 * single-login round-trip. A user sent from Meetsy lands on Clicksy's login as
 * `.../login?redirect=<meetsy-url>` and must be returned to Meetsy after sign-in.
 *
 * Safety model: EXACT-ORIGIN ALLOWLIST. The only origin we will ever redirect to
 * is `VITE_MEETSY_WEB_ORIGIN` (build-time baked by Vite). Anything else — a
 * different origin, a relative/protocol-relative path, a `javascript:`/`data:`
 * URL, or an unparseable value — resolves to `null`, and the caller falls back
 * to the in-app `/overview` route. This prevents open redirects.
 */
export function safeMeetsyRedirect(): string | null {
  // Allowlist must be configured; if unset, never redirect off-app.
  const allowed = import.meta.env.VITE_MEETSY_WEB_ORIGIN as string | undefined;
  if (!allowed) return null;

  let allowedOrigin: string;
  try {
    // Normalize the allowed value (tolerate a trailing slash / path in the env).
    allowedOrigin = new URL(allowed).origin;
  } catch {
    return null;
  }

  const raw = new URLSearchParams(window.location.search).get("redirect");
  if (!raw) return null;

  try {
    // NO base argument: relative ("/x") and protocol-relative ("//evil.com")
    // inputs throw here instead of resolving against the current origin — that
    // is the crux of the guard. `javascript:`/`data:` parse to origin "null".
    const target = new URL(raw);
    if (target.origin !== allowedOrigin) return null;
    return target.toString();
  } catch {
    return null;
  }
}
