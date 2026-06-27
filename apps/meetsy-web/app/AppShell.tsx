"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { AuthPrincipal } from "@/lib/auth";
import { UserProvider } from "@/lib/user-context";
import { Spinner } from "@/app/ui";

/**
 * Client shell rendered inside the (server) root layout. Owns:
 *  - the header chrome (brand + signed-in user)
 *  - the client-side auth gate
 *
 * The gate calls `GET /auth/me` once on mount. On success the principal is
 * exposed and children render. On 401 the request layer redirects the browser
 * to Clicksy's login (Meetsy has no login of its own) — so we just swallow the
 * error here and keep showing the spinner while the page navigates away.
 *
 * Children stay UNMOUNTED until `me()` resolves: this is load-bearing, not just
 * chrome — it stops authenticated pages (run polling, the SSE EventSource) from
 * firing before we know there's a session.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const [checked, setChecked] = useState(false);
  const [user, setUser] = useState<AuthPrincipal | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .me()
      .then((principal) => {
        if (!active) return;
        setUser(principal);
        setChecked(true);
      })
      .catch(() => {
        // 401 → request() already redirected to Clicksy's login; any other error
        // leaves the spinner up. Nothing to do here.
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-900 text-sm font-bold text-white">
              M
            </span>
            <span className="text-lg font-semibold tracking-tight text-zinc-900">
              Meeting Analyzer
            </span>
          </Link>
          {user && (
            <div className="flex items-center gap-4">
              {/* Push settings — Owner/Admin only (mirrors the backend @Roles gate). */}
              {(user.role === "OWNER" || user.role === "ADMIN") && (
                <Link
                  href="/settings/push"
                  className="text-sm font-medium text-zinc-600 hover:text-zinc-900"
                >
                  Push settings
                </Link>
              )}
              <span className="text-sm font-medium text-zinc-700">
                {user.email ?? "Signed in"}
              </span>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">
        {checked && user ? (
          <UserProvider user={user}>{children}</UserProvider>
        ) : (
          <div className="flex justify-center py-20">
            <Spinner label="Loading…" />
          </div>
        )}
      </main>
    </>
  );
}
