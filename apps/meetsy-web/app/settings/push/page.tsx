"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  ApiError,
  type AssignableMember,
  type ClickUpSpaceNode,
  type PushConfigView,
  type WorkspaceListItem,
} from "@/lib/api";
import { useCurrentUser } from "@/lib/user-context";
import { Button, Card, ErrorBanner, Spinner } from "@/app/ui";

/**
 * Owner/Admin push-settings page. Per workspace, pick the target ClickUp list
 * (space→folder→list tree) and the set of assignable members (checklist), plus
 * an optional default status. Saved via PUT /workspaces/:id/push-config.
 *
 * Members are redirect-gated to Owner/Admin in the backend (@Roles); here we
 * also gate the UI off the session role so a Member sees a clear note instead of
 * a broken page (the /clickup/* + PUT calls would 403 for them).
 */
export default function PushSettingsPage() {
  const user = useCurrentUser();
  const isAdmin = user.role === "OWNER" || user.role === "ADMIN";

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <PageHeader />
        <Card className="p-6">
          <p className="text-sm text-zinc-600">
            You don&apos;t have access to push settings. Ask an Owner or Admin to
            configure the ClickUp target list and assignable members.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader />
      <PushSettingsEditor />
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        ClickUp push settings
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Choose where Meetsy creates tasks and who can be assigned. Applied per
        workspace.
      </p>
    </div>
  );
}

function PushSettingsEditor() {
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load the workspace list once; default-first selection.
  useEffect(() => {
    let active = true;
    void api
      .listWorkspaces()
      .then((rows) => {
        if (!active) return;
        setWorkspaces(rows);
        setWorkspaceId((prev) => prev ?? rows[0]?.id ?? null);
      })
      .catch((err) => {
        if (!active) return;
        setLoadError(
          err instanceof ApiError ? err.message : "Could not load workspaces.",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  if (loadError) return <ErrorBanner message={loadError} />;
  if (!workspaces) return <Spinner label="Loading workspaces…" />;
  if (workspaces.length === 0) {
    return (
      <Card className="p-6">
        <p className="text-sm text-zinc-600">No workspaces found for your org.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {workspaces.length > 1 && (
        <Card className="p-5">
          <label className="block text-sm font-medium text-zinc-700">
            Workspace
            <select
              value={workspaceId ?? ""}
              onChange={(e) => setWorkspaceId(e.target.value)}
              className="mt-1.5 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-800 focus:border-zinc-400 focus:outline-none"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
        </Card>
      )}

      {/* Remount the form per workspace so its loaded config/lists/members reset. */}
      {workspaceId && (
        <WorkspacePushForm key={workspaceId} workspaceId={workspaceId} />
      )}
    </div>
  );
}

function WorkspacePushForm({ workspaceId }: { workspaceId: string }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [spaces, setSpaces] = useState<ClickUpSpaceNode[]>([]);
  const [members, setMembers] = useState<AssignableMember[]>([]);
  const [config, setConfig] = useState<PushConfigView | null>(null);

  // Editable state.
  const [targetListId, setTargetListId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [defaultStatus, setDefaultStatus] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);

    // Config is required; lists/members can each fail independently (e.g. no
    // ClickUp token) — surface that distinctly so the page still renders.
    void (async () => {
      try {
        const cfg = await api.getPushConfig(workspaceId);
        if (!active) return;
        setConfig(cfg);
        setTargetListId(cfg?.targetListId ?? null);
        setDefaultStatus(cfg?.defaultStatus ?? "");
        setSelectedIds(
          new Set((cfg?.assignableMembers ?? []).map((m) => m.clickupUserId)),
        );

        const [listsRes, membersRes] = await Promise.allSettled([
          api.getClickUpLists(workspaceId),
          api.getClickUpMembers(workspaceId),
        ]);
        if (!active) return;

        if (listsRes.status === "fulfilled") {
          setSpaces(listsRes.value.spaces);
        } else {
          setLoadError(messageOf(listsRes.reason, "Could not load ClickUp lists."));
        }
        if (membersRes.status === "fulfilled") {
          setMembers(membersRes.value.members);
        } else if (listsRes.status === "fulfilled") {
          // Only show the members error if lists succeeded (avoid double banner).
          setLoadError(
            messageOf(membersRes.reason, "Could not load ClickUp members."),
          );
        }
      } catch (err) {
        if (active) {
          setLoadError(messageOf(err, "Could not load push settings."));
        }
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [workspaceId]);

  // Map listId → name across the whole tree, for the saved targetListName.
  const listNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const space of spaces) {
      for (const list of space.lists) map.set(list.id, list.name);
      for (const folder of space.folders) {
        for (const list of folder.lists) map.set(list.id, list.name);
      }
    }
    return map;
  }, [spaces]);

  const toggleMember = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!targetListId) {
      setSaveError("Pick a target list first.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveOk(null);

    const assignableMembers: AssignableMember[] = members.filter((m) =>
      selectedIds.has(m.clickupUserId),
    );

    try {
      const saved = await api.putPushConfig(workspaceId, {
        targetListId,
        // Prefer the freshly-loaded tree name; fall back to the stored one.
        targetListName:
          listNameById.get(targetListId) ?? config?.targetListName ?? null,
        assignableMembers,
        defaultStatus: defaultStatus.trim() || null,
      });
      setConfig(saved);
      setSaveOk("Saved ✓");
    } catch (err) {
      setSaveError(messageOf(err, "Could not save push settings."));
    } finally {
      setSaving(false);
    }
  }, [
    workspaceId,
    targetListId,
    members,
    selectedIds,
    defaultStatus,
    listNameById,
    config,
  ]);

  if (loading) return <Spinner label="Loading push settings…" />;

  const hasLists = spaces.length > 0;

  return (
    <div className="space-y-6">
      {loadError && <ErrorBanner message={loadError} />}

      {/* Target list picker */}
      <Card className="space-y-3 p-5">
        <div>
          <h2 className="text-sm font-semibold text-zinc-700">Target list</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            New ClickUp tasks are created here by default.
          </p>
        </div>

        {!hasLists ? (
          <p className="text-sm text-zinc-500">
            No ClickUp lists available. Make sure this workspace has a connected
            ClickUp token.
          </p>
        ) : (
          <div className="space-y-4">
            {spaces.map((space) => (
              <div key={space.id} className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                  {space.name}
                </p>
                <div className="space-y-1 pl-2">
                  {space.lists.map((list) => (
                    <ListRadio
                      key={list.id}
                      id={list.id}
                      name={list.name}
                      checked={targetListId === list.id}
                      onSelect={setTargetListId}
                    />
                  ))}
                  {space.folders.map((folder) => (
                    <div key={folder.id} className="pl-2">
                      <p className="py-0.5 text-xs font-medium text-zinc-500">
                        {folder.name}
                      </p>
                      <div className="pl-2">
                        {folder.lists.map((list) => (
                          <ListRadio
                            key={list.id}
                            id={list.id}
                            name={list.name}
                            checked={targetListId === list.id}
                            onSelect={setTargetListId}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Assignable members checklist */}
      <Card className="space-y-3 p-5">
        <div>
          <h2 className="text-sm font-semibold text-zinc-700">
            Assignable members
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Only these ClickUp members can be picked as task assignees during a
            push.
          </p>
        </div>

        {members.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No ClickUp members available. Make sure this workspace has a
            connected ClickUp token.
          </p>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {members.map((m) => (
              <label
                key={m.clickupUserId}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(m.clickupUserId)}
                  onChange={() => toggleMember(m.clickupUserId)}
                  className="h-4 w-4 rounded border-zinc-300"
                />
                <span className="min-w-0">
                  <span className="font-medium">{m.name}</span>
                  {m.email && (
                    <span className="ml-1 text-xs text-zinc-400">{m.email}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}
      </Card>

      {/* Optional default status */}
      <Card className="space-y-2 p-5">
        <label className="block text-sm font-medium text-zinc-700">
          Default status (optional)
          <input
            type="text"
            value={defaultStatus}
            onChange={(e) => setDefaultStatus(e.target.value)}
            placeholder="e.g. to do"
            className="mt-1.5 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none"
          />
        </label>
        <p className="text-xs text-zinc-500">
          Leave blank to use the list&apos;s default status.
        </p>
      </Card>

      {/* Save */}
      <Card className="flex flex-wrap items-center gap-3 p-5">
        <Button onClick={handleSave} disabled={saving || !targetListId}>
          {saving ? <Spinner label="Saving…" /> : "Save settings"}
        </Button>
        {saveOk && (
          <span className="text-xs font-medium text-green-700">{saveOk}</span>
        )}
        {config?.updatedAt && !saveOk && (
          <span className="text-xs text-zinc-400">
            Last updated {new Date(config.updatedAt).toLocaleString()}
          </span>
        )}
        {saveError && <ErrorBanner message={saveError} />}
      </Card>
    </div>
  );
}

function ListRadio({
  id,
  name,
  checked,
  onSelect,
}: {
  id: string;
  name: string;
  checked: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-50">
      <input
        type="radio"
        name="targetList"
        checked={checked}
        onChange={() => onSelect(id)}
        className="h-4 w-4 border-zinc-300"
      />
      <span>{name}</span>
    </label>
  );
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}
