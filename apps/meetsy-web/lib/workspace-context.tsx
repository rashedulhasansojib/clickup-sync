"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  api,
  setActiveWorkspaceId,
  type WorkspaceListItem,
} from "./api";
import { readWorkspaceCookie, writeWorkspaceCookie } from "./workspace-cookie";

/**
 * Tracks the active org workspace for the whole signed-in page tree and keeps
 * `api.ts`'s module-level `activeWorkspaceId` in sync, so every workspace-scoped
 * call (createMeeting, getRun, chat, SSE, …) targets the chosen workspace.
 *
 * Resolution order (first wins):
 *  1. a `?workspaceId=` launch param on the URL (then stripped from the address),
 *  2. the shared cross-app cookie (so a switch made in Clicksy reflects here),
 *  3. the last choice persisted in localStorage,
 *  4. (after `GET /workspaces` resolves) the org default, then the first item.
 *
 * Switching here writes the shared cookie too, and a focus/visibility listener
 * re-reads it — so a switch made in EITHER app reflects in the other (the
 * bidirectional sync). `resolveInitial` runs as a LAZY useState initializer so
 * api.ts is primed synchronously — BEFORE any gated child fires its first fetch.
 */

const STORAGE_KEY = "meetsy:activeWorkspaceId";

interface WorkspaceContextValue {
  activeWorkspaceId: string | null;
  workspaces: WorkspaceListItem[];
  setActive: (id: string | null) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * Resolves the initial active workspace id and primes api.ts synchronously.
 * SSR-safe: returns null on the server (no window/localStorage/history there).
 */
function resolveInitial(): string | null {
  if (typeof window === "undefined") return null;

  let resolved: string | null = null;

  const params = new URLSearchParams(window.location.search);
  const launch = params.get("workspaceId");
  if (launch) {
    // Launch param ALWAYS wins (explicit deep-link intent) — persist it to BOTH
    // localStorage and the shared cookie (so a later hop back to Clicksy agrees).
    // The URL is stripped of `workspaceId` in an effect AFTER mount (see
    // WorkspaceProvider) — NOT here: this runs during render (lazy useState
    // initializer), and Next patches history.replaceState to sync the Router, so
    // calling it here throws "Cannot update Router while rendering".
    resolved = launch;
    try {
      localStorage.setItem(STORAGE_KEY, launch);
    } catch {
      // localStorage may be unavailable (private mode); ignore.
    }
    writeWorkspaceCookie(launch);
  } else {
    // No launch param — prefer the shared cross-app cookie (a switch made in
    // Clicksy), then fall back to this app's own localStorage.
    resolved = readWorkspaceCookie();
    if (!resolved) {
      try {
        resolved = localStorage.getItem(STORAGE_KEY);
      } catch {
        resolved = null;
      }
    }
  }

  // Prime api.ts before returning so gated children see the right workspace.
  setActiveWorkspaceId(resolved);
  return resolved;
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [activeWorkspaceId, setId] = useState<string | null>(resolveInitial);
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([]);

  function setActive(id: string | null) {
    setActiveWorkspaceId(id);
    if (typeof window !== "undefined") {
      try {
        if (id) localStorage.setItem(STORAGE_KEY, id);
        else localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore storage failures
      }
      // Mirror into the shared cookie so the switch reflects in Clicksy too.
      if (id) writeWorkspaceCookie(id);
    }
    setId(id);
  }

  // Latest state for the focus listener without re-binding it every render.
  const activeRef = useRef(activeWorkspaceId);
  activeRef.current = activeWorkspaceId;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  // Bidirectional sync: when this tab regains focus (e.g. the user switched
  // workspace over in Clicksy, then came back), adopt the shared cookie's value.
  // Cookie-ONLY — never re-run resolveInitial here (the launch param is already
  // stripped, and re-resolving could loop). Adopting calls setActive, which
  // writes the same cookie value back (no feedback loop) and remounts the page.
  useEffect(() => {
    function syncFromCookie() {
      const cookieId = readWorkspaceCookie();
      if (!cookieId || cookieId === activeRef.current) return;
      const list = workspacesRef.current;
      // If the list is loaded, only adopt a workspace that's actually in it;
      // before it loads, adopt optimistically (the list effect re-validates).
      if (list.length > 0 && !list.some((w) => w.id === cookieId)) return;
      setActive(cookieId);
    }
    function onVisibility() {
      if (document.visibilityState === "visible") syncFromCookie();
    }
    window.addEventListener("focus", syncFromCookie);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", syncFromCookie);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Strip the one-time `?workspaceId=` launch param from the URL AFTER mount.
  // resolveInitial already consumed + persisted it; this just cleans the address
  // bar. It MUST live in an effect (not resolveInitial) because Next patches
  // history.replaceState to sync the Router — calling it during render throws
  // "Cannot update a component (Router) while rendering a different component".
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("workspaceId")) return;
    params.delete("workspaceId");
    const query = params.toString();
    const newUrl =
      window.location.pathname + (query ? `?${query}` : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);
  }, []);

  useEffect(() => {
    let active = true;
    void api
      .listWorkspaces()
      .then((list) => {
        if (!active) return;
        setWorkspaces(list);
        // Validate the resolved id against the real list; fall back to the
        // org default (then the first workspace) when it's stale or unset.
        const isValid =
          activeWorkspaceId != null &&
          list.some((w) => w.id === activeWorkspaceId);
        if (!isValid) {
          const fallback = list.find((w) => w.isDefault) ?? list[0];
          if (fallback) setActive(fallback.id);
        }
      })
      .catch(() => {
        // request() already handles 401 → Clicksy login redirect; for any
        // other failure leave the current (possibly null) selection in place.
      });
    return () => {
      active = false;
    };
    // Run once on mount — the activeWorkspaceId read is intentionally the
    // initial value (validation of the primed id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <WorkspaceContext.Provider
      value={{ activeWorkspaceId, workspaces, setActive }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

/** The active-workspace context. Must be called inside `<WorkspaceProvider>`. */
export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be used within <WorkspaceProvider>");
  }
  return ctx;
}

/**
 * Header dropdown to switch the active workspace. Renders nothing when there's
 * one (or zero) workspace — there's nothing to switch between.
 */
export function WorkspaceSwitcher() {
  const { activeWorkspaceId, workspaces, setActive } = useWorkspace();
  if (workspaces.length <= 1) return null;
  return (
    <select
      value={activeWorkspaceId ?? ""}
      onChange={(e) => setActive(e.target.value)}
      aria-label="Active workspace"
      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm font-medium text-zinc-700 hover:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400"
    >
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );
}
