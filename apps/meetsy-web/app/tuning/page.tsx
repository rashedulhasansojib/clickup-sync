"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  api,
  ApiError,
  type MlConfigPreviewView,
  type WorkspaceMlConfigView,
} from "@/lib/api";
import type { RunSnapshotPayload, WorkspaceTunables } from "@ma/shared";
import { useCurrentUser } from "@/lib/user-context";
import { useWorkspace } from "@/lib/workspace-context";
import { Card, ErrorBanner, Spinner } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SECTIONS, SECTION_TITLES, TUNABLE_META } from "./tunable-meta";

/**
 * v2 Phase 5 — `/tuning`. Owner writable, Member read-only. Numeric form for
 * every `WorkspaceTunables` field grouped by section, a Preview button that
 * opens a right-side sheet with per-run duplicate deltas + gate summary, and a
 * Save button that writes via PUT. Model routing is DISPLAY-ONLY in this cut
 * (runtime consumption is deferred — see spec §3.2.3).
 */
export default function TuningPage() {
  const user = useCurrentUser();
  const { activeWorkspaceId } = useWorkspace();
  const isOwner = user.role === "OWNER";

  const [initial, setInitial] = useState<WorkspaceMlConfigView | null>(null);
  const [tunables, setTunables] = useState<WorkspaceTunables | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<MlConfigPreviewView | null>(null);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    let active = true;
    setInitial(null);
    setTunables(null);
    setLoadError(null);
    void api
      .mlConfigGet(activeWorkspaceId)
      .then((view) => {
        if (!active) return;
        setInitial(view);
        setTunables(view.tunables);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [activeWorkspaceId]);

  const setField = useCallback((key: keyof WorkspaceTunables, value: number) => {
    setTunables((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  const dirty = useMemo(() => {
    if (!initial || !tunables) return false;
    return (Object.keys(TUNABLE_META) as Array<keyof WorkspaceTunables>).some(
      (key) => tunables[key] !== initial.tunables[key],
    );
  }, [initial, tunables]);

  const handleSave = useCallback(async () => {
    if (!activeWorkspaceId || !tunables || !initial) return;
    setSaving(true);
    try {
      const body: RunSnapshotPayload = { tunables, models: initial.models };
      const view = await api.mlConfigPut(activeWorkspaceId, body);
      setInitial(view);
      setTunables(view.tunables);
      toast.success("Tuning saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [activeWorkspaceId, tunables, initial]);

  const handlePreview = useCallback(async () => {
    if (!activeWorkspaceId || !tunables || !initial) return;
    setPreviewing(true);
    try {
      const body: RunSnapshotPayload = { tunables, models: initial.models };
      const view = await api.mlConfigPreview(activeWorkspaceId, body, 10);
      setPreview(view);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }, [activeWorkspaceId, tunables, initial]);

  if (!activeWorkspaceId) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        Loading workspace…
      </div>
    );
  }
  if (loadError) return <ErrorBanner message={loadError} />;
  if (!initial || !tunables) return <Spinner label="Loading tuning…" />;

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tuning</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Per-workspace ML tunables + model routing. Changes to duplicate bands
            and learning-gate values take effect on the very next run; other fields
            are stored but not yet consumed by the runtime pipeline (marked below).
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          {initial.isDefault ? (
            <span className="rounded-full border border-input bg-muted/50 px-2 py-0.5">
              Using defaults
            </span>
          ) : (
            <>
              <div>Last saved</div>
              <div className="font-mono text-[11px]">
                {initial.updatedAt
                  ? new Date(initial.updatedAt).toLocaleString()
                  : "—"}
              </div>
            </>
          )}
        </div>
      </header>

      {!isOwner && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          Read-only. Only an Owner can change tunables.
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          {SECTIONS.map((section) => {
            const fields = (Object.keys(TUNABLE_META) as Array<keyof WorkspaceTunables>).filter(
              (key) => TUNABLE_META[key].section === section,
            );
            if (fields.length === 0) return null;
            return (
              <Card key={section} className="space-y-4 p-6">
                <h2 className="text-sm font-semibold text-foreground">
                  {SECTION_TITLES[section]}
                </h2>
                <div className="grid gap-4">
                  {fields.map((key) => {
                    const meta = TUNABLE_META[key];
                    const value = tunables[key];
                    const defaultValue = initial.tunables[key];
                    return (
                      <div key={key} className="grid gap-1.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <Label htmlFor={`tun-${key}`} className="text-sm">
                            {meta.label}
                            {!meta.consumed && (
                              <span
                                className="ml-2 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700"
                                title="Stored but not yet consumed by the runtime pipeline. Applies from Phase 5.x."
                              >
                                Not applied yet
                              </span>
                            )}
                          </Label>
                          <span className="text-[11px] text-muted-foreground/70">
                            default {defaultValue}
                          </span>
                        </div>
                        <Input
                          id={`tun-${key}`}
                          type="number"
                          value={value}
                          min={meta.min}
                          max={meta.max}
                          step={meta.step}
                          disabled={!isOwner || saving}
                          onChange={(e) => {
                            const n = Number.parseFloat(e.target.value);
                            if (Number.isFinite(n)) setField(key, n);
                          }}
                        />
                        <p className="text-xs text-muted-foreground">{meta.description}</p>
                      </div>
                    );
                  })}
                </div>
              </Card>
            );
          })}

          <Card className="space-y-2 p-6">
            <h2 className="text-sm font-semibold text-foreground">Model routing</h2>
            <p className="text-xs text-muted-foreground">
              Persisted per workspace and recorded on every run snapshot. Runtime
              pipeline currently reads hardcoded per-stage effort levels;
              consumption is deferred to a follow-up phase.
            </p>
            <table className="w-full text-xs">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-medium">Stage</th>
                  <th className="py-1 text-left font-medium">Deployment</th>
                  <th className="py-1 text-left font-medium">Effort</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {Object.entries(initial.models.pipeline).map(([stage, cfg]) => (
                  <tr key={stage} className="border-b last:border-b-0">
                    <td className="py-1">{stage}</td>
                    <td className="py-1">{cfg.deployment}</td>
                    <td className="py-1">{cfg.effort}</td>
                  </tr>
                ))}
                {[
                  ["narrative", initial.models.narrative],
                  ["clamp", initial.models.clamp],
                  ["judge", initial.models.judge],
                ].map(([stage, cfg]) => (
                  <tr key={String(stage)} className="border-b last:border-b-0">
                    <td className="py-1">{String(stage)}</td>
                    <td className="py-1">{(cfg as { deployment: string; effort: string }).deployment}</td>
                    <td className="py-1">{(cfg as { deployment: string; effort: string }).effort}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card className="space-y-3 p-6">
            <h3 className="text-sm font-semibold text-foreground">Preview & save</h3>
            <p className="text-xs text-muted-foreground">
              Preview replays the last 10 completed runs against the current form
              values, showing how duplicate classifications would shift. Save then
              persists the values for future runs.
            </p>
            {isOwner ? (
              <div className="flex flex-col gap-2">
                <Button
                  onClick={handlePreview}
                  disabled={!dirty || previewing || saving}
                  variant="outline"
                >
                  {previewing ? "Previewing…" : "Preview"}
                </Button>
                <Button onClick={handleSave} disabled={!dirty || saving || previewing}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/70">Owners can preview and save.</p>
            )}
          </Card>
        </aside>
      </div>

      <PreviewSheet
        open={preview !== null}
        preview={preview}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}

function PreviewSheet({
  open,
  preview,
  onClose,
}: {
  open: boolean;
  preview: MlConfigPreviewView | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(v) => (v ? undefined : onClose())}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Preview</SheetTitle>
        </SheetHeader>
        {!preview ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="space-y-6 overflow-y-auto p-6 text-sm">
            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Learning gate
              </h4>
              <div className="grid grid-cols-2 gap-3 rounded-md border p-3 text-xs">
                <div>
                  <div className="text-muted-foreground">Baseline</div>
                  <div>Gating: {preview.gate.baseline.patternsGating}</div>
                  <div>Near-gate: {preview.gate.baseline.patternsNearGate}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Candidate</div>
                  <div>Gating: {preview.gate.candidate.patternsGating}</div>
                  <div>Near-gate: {preview.gate.candidate.patternsNearGate}</div>
                </div>
              </div>
            </section>

            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Duplicates delta ({preview.runs.length} runs)
              </h4>
              {preview.runs.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No completed runs in this workspace yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {preview.runs.map((r) => (
                    <li key={r.runId} className="rounded-md border p-3">
                      <div className="flex items-baseline justify-between">
                        <div className="truncate font-medium">
                          {r.meetingTitle ?? "(untitled)"}
                        </div>
                        <div className="ml-2 shrink-0 text-[10px] font-mono text-muted-foreground/70">
                          {r.runId.slice(0, 8)}
                        </div>
                      </div>
                      {r.duplicates ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          Flag {r.duplicates.baseline.flag} → {r.duplicates.candidate.flag}
                          {" · "}
                          Suggest {r.duplicates.baseline.suggest} → {r.duplicates.candidate.suggest}
                          {" · "}
                          <span className={r.duplicates.changed > 0 ? "text-amber-600" : ""}>
                            {r.duplicates.changed} task
                            {r.duplicates.changed === 1 ? "" : "s"} reclassified
                          </span>
                        </div>
                      ) : (
                        <div className="mt-1 text-xs italic text-muted-foreground/70">
                          No per-task neighbours stored on this run — skipped.
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <details className="text-xs">
                <summary className="cursor-pointer font-medium text-muted-foreground">
                  Skipped fields ({preview.skipped.length})
                </summary>
                <ul className="mt-2 space-y-1 text-muted-foreground">
                  {preview.skipped.map((s) => (
                    <li key={s.field}>
                      <code>{s.field}</code> — {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
