import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { workspacesApi, type SwitcherWorkspace } from '../api/workspaces';
import { setActiveWorkspaceId } from '../api/client';
import { queryClient } from '../lib/queryClient';
import { readWorkspaceCookie, writeWorkspaceCookie } from '../lib/workspaceCookie';

interface WorkspaceCtx {
  workspaces: SwitcherWorkspace[];
  activeId: string | null;
  active: SwitcherWorkspace | undefined;
  setActive: (id: string) => void;
  isLoading: boolean;
}

const WorkspaceContext = createContext<WorkspaceCtx>({} as WorkspaceCtx);
const STORAGE_KEY = 'activeWorkspaceId';

// Prime the request interceptor synchronously at module load so the very first
// data requests after a reload are already scoped to the remembered workspace
// (before the workspaces list round-trips). Prefer the shared cross-app cookie
// (a switch made in Meetsy) over this app's own sessionStorage.
const stored0 =
  readWorkspaceCookie() ??
  (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null);
if (stored0) setActiveWorkspaceId(stored0);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [activeId, setActiveIdState] = useState<string | null>(
    () => readWorkspaceCookie() ?? sessionStorage.getItem(STORAGE_KEY),
  );

  const { data: workspaces = [], isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: workspacesApi.list,
    staleTime: 5 * 60_000,
  });

  function apply(id: string, invalidate: boolean) {
    setActiveWorkspaceId(id);
    sessionStorage.setItem(STORAGE_KEY, id);
    // Mirror into the shared cookie so the switch reflects in Meetsy too.
    writeWorkspaceCookie(id);
    setActiveIdState(id);
    if (invalidate) {
      // Every dashboard query's data depends on the active workspace — refetch
      // them all. (The space filter is reset by the switcher in TopBar, since
      // a space id from the old workspace is meaningless in the new one.)
      queryClient.invalidateQueries();
    }
  }

  // Latest state for the focus listener without re-binding it every render.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const workspacesRef = useRef<SwitcherWorkspace[]>(workspaces);
  workspacesRef.current = workspaces;

  // Bidirectional sync: when this tab regains focus (e.g. the user switched
  // workspace over in Meetsy), adopt the shared cookie's value. Cookie-ONLY, so
  // there's no re-resolution loop; `apply` writes the same value back (no
  // feedback) and invalidates queries to refetch the new workspace's data.
  useEffect(() => {
    function syncFromCookie() {
      const cookieId = readWorkspaceCookie();
      if (!cookieId || cookieId === activeIdRef.current) return;
      const list = workspacesRef.current;
      if (list.length > 0 && !list.some((w) => w.id === cookieId)) return;
      apply(cookieId, true);
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') syncFromCookie();
    }
    window.addEventListener('focus', syncFromCookie);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', syncFromCookie);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the list loads, make sure the remembered id is still valid; otherwise
  // fall back to the default (or first) workspace.
  useEffect(() => {
    if (!workspaces.length) return;
    const valid = activeId && workspaces.some((w) => w.id === activeId);
    if (!valid) {
      const def = workspaces.find((w) => w.isDefault) ?? workspaces[0];
      apply(def.id, false);
    } else if (activeId) {
      setActiveWorkspaceId(activeId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces]);

  const active = workspaces.find((w) => w.id === activeId);

  return (
    <WorkspaceContext.Provider
      value={{ workspaces, activeId, active, setActive: (id) => apply(id, true), isLoading }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useActiveWorkspace() {
  return useContext(WorkspaceContext);
}
