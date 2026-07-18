"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, type KbOnboardBody, type KbStatusView } from "@/lib/api";
import { useCurrentUser } from "@/lib/user-context";
import { useWorkspace } from "@/lib/workspace-context";
import { Button, Card, ErrorBanner, Spinner } from "@/app/ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  TaskSheetProvider,
} from "@/components/tasks/task-sheet-context";
import { TaskDetailSheet } from "@/components/tasks/task-detail-sheet";
import { KbBuildPanel } from "@/app/kb/steps";
import { OverviewTab } from "@/app/kb/overview-tab";
import { TasksTab } from "@/app/kb/tasks-tab";
import { DocumentsTab } from "@/app/kb/documents-tab";
import { SearchTab } from "@/app/kb/search-tab";
import { RebuildTab } from "@/app/kb/rebuild-tab";

type KbTab = "overview" | "tasks" | "documents" | "search" | "rebuild";
const TAB_ORDER: KbTab[] = ["overview", "tasks", "documents", "search", "rebuild"];

function parseTab(raw: string | null, canWrite: boolean): KbTab {
  const parsed = TAB_ORDER.find((t) => t === raw);
  if (!parsed) return "overview";
  if (parsed === "rebuild" && !canWrite) return "overview";
  return parsed;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * v2 Phase 4 — the consolidated `/kb` route. One shell with five tabs
 * (Overview / Tasks / Documents / Search / Rebuild), replacing the retired
 * `/onboarding` wizard and `/settings/kb` re-embed page. Idle KB is signaled
 * in-page (banner + "Start onboarding" for Owner/Admin), not with a full-page
 * redirect.
 */
export default function KbPage() {
  const user = useCurrentUser();
  const { activeWorkspaceId } = useWorkspace();
  const canWrite = user.role === "OWNER" || user.role === "ADMIN";

  if (!activeWorkspaceId) {
    return (
      <div className="flex justify-center py-20">
        <Spinner label="Loading workspace…" />
      </div>
    );
  }

  return (
    <TaskSheetProvider>
      <TaskDetailSheet workspaceId={activeWorkspaceId} />
      <KbShell
        key={activeWorkspaceId}
        ws={activeWorkspaceId}
        canWrite={canWrite}
      />
    </TaskSheetProvider>
  );
}

function KbShell({ ws, canWrite }: { ws: string; canWrite: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const currentTab = parseTab(params.get("tab"), canWrite);

  const [status, setStatus] = useState<KbStatusView | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatusError(null);
    try {
      const s = await api.kbStatus(ws);
      setStatus(s);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setStatusError(messageOf(err, "Could not load KB status."));
    }
  }, [ws]);

  useEffect(() => {
    void load();
  }, [load]);

  const setTab = useCallback(
    (t: string) => {
      const next = new URLSearchParams(params.toString());
      next.set("tab", t);
      // Drop `?q=` when navigating away from Search so the URL is honest.
      if (t !== "search") next.delete("q");
      router.replace(`/kb?${next.toString()}`, { scroll: false });
    },
    [router, params],
  );

  return (
    <div className="space-y-6">
      <PageHeader />

      {statusError && <ErrorBanner message={statusError} />}

      {status && status.status !== "ready" && (
        <IdleBanner
          ws={ws}
          canWrite={canWrite}
          status={status}
          onDone={load}
        />
      )}

      {!status && !statusError && (
        <div className="flex justify-center py-20">
          <Spinner label="Loading knowledge base…" />
        </div>
      )}

      {status && (
        <Tabs value={currentTab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="tasks">Tasks</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
            <TabsTrigger value="search">Search</TabsTrigger>
            {canWrite && <TabsTrigger value="rebuild">Rebuild</TabsTrigger>}
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            {status.status === "ready" ? (
              <OverviewTab ws={ws} status={status} />
            ) : (
              <Card className="p-6">
                <p className="text-sm text-zinc-500">
                  Overview appears once the knowledge base is ready.
                </p>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="tasks" className="mt-4">
            {status.status === "ready" ? (
              <TasksTab ws={ws} />
            ) : (
              <Card className="p-6">
                <p className="text-sm text-zinc-500">
                  Tasks appear here once onboarding embeds them.
                </p>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="documents" className="mt-4">
            <DocumentsTab ws={ws} canWrite={canWrite} />
          </TabsContent>

          <TabsContent value="search" className="mt-4">
            {status.status === "ready" ? (
              <SearchTab ws={ws} />
            ) : (
              <Card className="p-6">
                <p className="text-sm text-zinc-500">
                  Search is available once the knowledge base is ready.
                </p>
              </Card>
            )}
          </TabsContent>

          {canWrite && (
            <TabsContent value="rebuild" className="mt-4">
              <RebuildTab ws={ws} status={status} onDone={load} />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        Knowledge base
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Browse embedded tasks and documents, search the knowledge base, or
        rebuild with a different scope.
      </p>
    </div>
  );
}

/**
 * KB isn't `ready` — surface it in-page instead of forcing a redirect. Owner/
 * Admin can start onboarding directly from here (range-only default, same as
 * the retired wizard's step-5). Members see a read-only note.
 */
function IdleBanner({
  ws,
  canWrite,
  status,
  onDone,
}: {
  ws: string;
  canWrite: boolean;
  status: KbStatusView;
  onDone: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const body = useMemo<KbOnboardBody>(() => ({ range: "3m" }), []);

  const tone = status.status === "error" ? "red" : "amber";
  const label =
    status.status === "onboarding"
      ? "Your knowledge base is currently building. This can take a few minutes."
      : status.status === "error"
        ? "The knowledge base build hit an error. Rebuild to try again."
        : "Your knowledge base isn't set up yet.";

  if (status.status === "onboarding" || starting) {
    return (
      <Card className="space-y-4 p-6">
        <div>
          <h2 className="text-sm font-semibold text-zinc-700">
            Building the knowledge base…
          </h2>
          <p className="mt-1 text-sm text-zinc-600">{label}</p>
        </div>
        <KbBuildPanel
          ws={ws}
          body={body}
          onDone={() => {
            setStarting(false);
            onDone();
          }}
        />
      </Card>
    );
  }

  const border = tone === "red" ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50";
  const text = tone === "red" ? "text-red-800" : "text-amber-800";

  return (
    <div className={`rounded-lg border ${border} px-4 py-3 ${text}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          <p className="font-medium">{label}</p>
          {canWrite ? (
            <p className="mt-0.5 text-xs opacity-80">
              Start onboarding to embed your ClickUp task history — only takes a
              few minutes.
            </p>
          ) : (
            <p className="mt-0.5 text-xs opacity-80">
              Ask an Owner or Admin to set up the knowledge base.
            </p>
          )}
        </div>
        {canWrite && (
          <Button onClick={() => setStarting(true)}>Start onboarding</Button>
        )}
      </div>
    </div>
  );
}
