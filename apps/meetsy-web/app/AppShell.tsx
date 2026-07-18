"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { AuthPrincipal } from "@/lib/auth";
import { UserProvider } from "@/lib/user-context";
import {
  WorkspaceProvider,
  useWorkspace,
} from "@/lib/workspace-context";
import { Spinner } from "@/app/ui";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/components/nav/sidebar";

/**
 * Client shell rendered inside the (server) root layout. Owns:
 *  - the client-side auth gate
 *  - the persistent left sidebar (v2 Phase 1)
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

  // The auth gate is strictly outermost: children (and the WorkspaceProvider)
  // stay UNMOUNTED until `me()` resolves. Once signed in, a single
  // WorkspaceProvider wraps BOTH the sidebar (so the switcher can read context)
  // and the page subtree — see SignedInShell.
  if (checked && user) {
    return (
      <WorkspaceProvider>
        <SignedInShell user={user}>{children}</SignedInShell>
      </WorkspaceProvider>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner label="Loading…" />
    </div>
  );
}

/**
 * The signed-in shell. Lives INSIDE the WorkspaceProvider so it can read the
 * active workspace id for the remount key. The sidebar stays mounted; only the
 * page `{children}` is keyed by the active workspace so switching remounts the
 * page subtree and re-runs its client-effect fetches.
 */
function SignedInShell({
  user,
  children,
}: {
  user: AuthPrincipal;
  children: React.ReactNode;
}) {
  const { activeWorkspaceId } = useWorkspace();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Toast host — sonner's Toaster reads the current next-themes theme so
          toasts match dark/light. Existing inline ErrorBanner callers stay
          untouched; Phase 1 will migrate the noisy ones to toast() calls. */}
      <Toaster richColors closeButton />

      <Sidebar user={user} />

      <main className="flex-1 min-w-0">
        <div className="mx-auto max-w-5xl px-6 py-8">
          <UserProvider user={user}>
            {/* Keyed by the active workspace so a switch remounts the page subtree
                (and KbGate re-runs its status check) — see WorkspaceProvider. */}
            <div key={activeWorkspaceId ?? "none"}>
              <KbGate>{children}</KbGate>
            </div>
          </UserProvider>
        </div>
      </main>
    </div>
  );
}

/**
 * First-run gate. Before showing any page, confirm the active workspace's KB is
 * `ready`; otherwise push the user into the onboarding wizard. Sits INSIDE the
 * auth gate + WorkspaceProvider + the keyed div (so it re-runs on every
 * workspace switch via the remount).
 *
 * Landmines handled:
 *  - No redirect loop: `/onboarding` is always allowed through (no fetch there).
 *  - `activeWorkspaceId` null (before listWorkspaces validates) → Spinner, no fetch.
 *  - Re-check on pathname change: the status fetch deps include `pathname`, so
 *    when the wizard finishes and routes back to `/home`, the gate re-fetches,
 *    sees `ready`, and renders — instead of redirecting back with a stale `idle`.
 *  - Fail-open on non-401 errors (render children); 401 already redirects in request().
 *  - The redirect happens in an effect, never during render.
 */
function KbGate({ children }: { children: React.ReactNode }) {
  const { activeWorkspaceId } = useWorkspace();
  const pathname = usePathname();
  const router = useRouter();

  // null = still deciding; true = render children; false = redirecting.
  const [allow, setAllow] = useState<boolean | null>(null);

  const onOnboarding = pathname === "/onboarding";

  useEffect(() => {
    // The wizard route is always allowed through (prevents a redirect loop).
    if (onOnboarding) {
      setAllow(true);
      return;
    }
    // No workspace resolved yet → show the spinner, don't fetch.
    if (!activeWorkspaceId) {
      setAllow(null);
      return;
    }

    // NB: do NOT reset `allow` to null here. KbGate stays mounted across
    // same-workspace navigations (the remount key is the workspace, not the
    // path), so blanking to a spinner before each re-check would flash + unmount
    // the page (and its EventSource) on every in-app nav. A workspace switch
    // remounts KbGate entirely, so `allow` can't carry stale across workspaces;
    // within one workspace, status doesn't flip ready→not-ready. Cold load still
    // blocks because the initial state is already null.
    let active = true;
    void api
      .kbStatus(activeWorkspaceId)
      .then((status) => {
        if (!active) return;
        if (status.status === "ready") {
          setAllow(true);
        } else {
          setAllow(false);
          router.replace("/onboarding");
        }
      })
      .catch((err) => {
        if (!active) return;
        // 401 already triggered the Clicksy-login redirect inside request(); any
        // other error fails OPEN so a backend hiccup doesn't wall the app.
        if (err instanceof ApiError && err.status === 401) return;
        setAllow(true);
      });
    return () => {
      active = false;
    };
  }, [activeWorkspaceId, pathname, onOnboarding, router]);

  if (allow) return <>{children}</>;
  return (
    <div className="flex justify-center py-20">
      <Spinner label="Loading…" />
    </div>
  );
}
