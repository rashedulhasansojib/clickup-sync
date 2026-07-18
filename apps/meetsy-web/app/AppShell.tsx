"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AuthPrincipal } from "@/lib/auth";
import { UserProvider } from "@/lib/user-context";
import {
  WorkspaceProvider,
  useWorkspace,
} from "@/lib/workspace-context";
import { useLearningStream } from "@/lib/useLearningStream";
import { Spinner } from "@/app/ui";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/components/nav/sidebar";
import { CommandPalette } from "@/components/nav/command-palette";

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
 *
 * v2 Phase 4 — the old `KbGate` full-page redirect to `/onboarding` is gone.
 * `/kb` renders its own idle banner when the KB isn't `ready`; every other
 * route tolerates an unbuilt KB (see `learning/page.tsx`, `home/page.tsx`).
 */
function SignedInShell({
  user,
  children,
}: {
  user: AuthPrincipal;
  children: React.ReactNode;
}) {
  const { activeWorkspaceId } = useWorkspace();
  // v2 Phase 3 (PR-N) — subscribe workspace-wide to near-gate / gate-passed
  // events. Mounted here (not inside a page) so a toast can land while the
  // user is pushing — the moment when the threshold actually crosses. The
  // hook auto-cleans when the workspace switches or the shell unmounts.
  useLearningStream(activeWorkspaceId);
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Toaster richColors closeButton />
      <CommandPalette user={user} />

      <Sidebar user={user} />

      <main className="flex-1 min-w-0">
        <div className="mx-auto max-w-5xl px-6 py-8">
          <UserProvider user={user}>
            <div key={activeWorkspaceId ?? "none"}>{children}</div>
          </UserProvider>
        </div>
      </main>
    </div>
  );
}
