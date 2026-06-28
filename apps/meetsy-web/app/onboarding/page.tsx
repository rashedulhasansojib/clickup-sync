"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  api,
  ApiError,
  type KbDocumentRow,
  type KbFacts,
  type KbOnboardBody,
  type KbRange,
  type KbScope,
  type KbSummaryView,
} from "@/lib/api";
import {
  KbBuildPanel,
  RangeRadios,
  SpacesChecklist,
  StepActions,
  SubScopeChecklists,
  useKbSpaces,
} from "@/app/onboarding/steps";
import { useCurrentUser } from "@/lib/user-context";
import { useWorkspace } from "@/lib/workspace-context";
import { Button, Card, ErrorBanner, Spinner, Tag } from "@/app/ui";

/**
 * First-run onboarding wizard. A local stepper that builds the workspace
 * knowledge base from Clicksy-mirrored ClickUp tasks, then shows what it learned
 * and optionally ingests SOP/reference documents.
 *
 * Role gate: onboarding (and the spaces/scope/upload fetches) are Owner/Admin on
 * the backend. A Member would 403, so we short-circuit the WHOLE wizard to a
 * read-only note before any KB fetch fires.
 */
export default function OnboardingPage() {
  const user = useCurrentUser();
  const { activeWorkspaceId, workspaces } = useWorkspace();
  const isAdmin = user.role === "OWNER" || user.role === "ADMIN";

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <Header />
        <Card className="p-6">
          <p className="text-sm text-zinc-600">
            Your workspace isn&apos;t set up yet — ask an Owner or Admin to run
            onboarding.
          </p>
        </Card>
      </div>
    );
  }

  if (!activeWorkspaceId) {
    return (
      <div className="flex justify-center py-20">
        <Spinner label="Loading workspace…" />
      </div>
    );
  }

  const workspaceName =
    workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? "this workspace";

  return (
    <Wizard
      key={activeWorkspaceId}
      ws={activeWorkspaceId}
      workspaceName={workspaceName}
    />
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        Set up your workspace
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        We&apos;ll learn from your ClickUp history so Meetsy can suggest better
        tasks.
      </p>
    </div>
  );
}

const STEP_LABELS = [
  "Workspace",
  "Spaces",
  "Sub-scope",
  "Date range",
  "Build",
  "What we learned",
  "Documents",
] as const;

function Wizard({ ws, workspaceName }: { ws: string; workspaceName: string }) {
  const router = useRouter();
  const [step, setStep] = useState(1); // 1-based, matches STEP_LABELS

  // Scope selections carried across steps.
  const [selectedSpaceIds, setSelectedSpaceIds] = useState<Set<string>>(
    new Set(),
  );
  const [folderNames, setFolderNames] = useState<Set<string>>(new Set());
  const [listIds, setListIds] = useState<Set<string>>(new Set());
  const [clients, setClients] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<KbRange>("3m");

  const onboardBody = useMemo<KbOnboardBody>(() => {
    const scope: KbScope = {};
    if (selectedSpaceIds.size) scope.spaceIds = [...selectedSpaceIds];
    if (folderNames.size) scope.folderNames = [...folderNames];
    if (listIds.size) scope.listIds = [...listIds];
    if (clients.size) scope.clients = [...clients];
    // Omit `scope` entirely when nothing is selected (range-only onboard).
    return Object.keys(scope).length ? { range, scope } : { range };
  }, [selectedSpaceIds, folderNames, listIds, clients, range]);

  return (
    <div className="space-y-6">
      <Header />
      <Stepper current={step} />

      {step === 1 && (
        <ConfirmStep
          workspaceName={workspaceName}
          onNext={() => setStep(2)}
        />
      )}
      {step === 2 && (
        <SpacesStep
          ws={ws}
          selected={selectedSpaceIds}
          onChange={setSelectedSpaceIds}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}
      {step === 3 && (
        <SubScopeStep
          ws={ws}
          spaceIds={[...selectedSpaceIds]}
          folderNames={folderNames}
          listIds={listIds}
          clients={clients}
          onFolders={setFolderNames}
          onLists={setListIds}
          onClients={setClients}
          onBack={() => setStep(2)}
          onNext={() => setStep(4)}
        />
      )}
      {step === 4 && (
        <RangeStep
          range={range}
          onChange={setRange}
          onBack={() => setStep(3)}
          onNext={() => setStep(5)}
        />
      )}
      {step === 5 && (
        <BuildStep
          ws={ws}
          body={onboardBody}
          onBack={() => setStep(4)}
          onReady={() => setStep(6)}
        />
      )}
      {step === 6 && <SummaryStep ws={ws} onNext={() => setStep(7)} />}
      {step === 7 && (
        <DocumentsStep ws={ws} onFinish={() => router.replace("/")} />
      )}
    </div>
  );
}

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1;
        const state =
          n < current ? "done" : n === current ? "active" : "upcoming";
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={
                "flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold " +
                (state === "active"
                  ? "bg-zinc-900 text-white"
                  : state === "done"
                    ? "bg-green-100 text-green-700"
                    : "bg-zinc-100 text-zinc-400")
              }
            >
              {state === "done" ? "✓" : n}
            </span>
            <span
              className={
                state === "active"
                  ? "font-medium text-zinc-800"
                  : "text-zinc-400"
              }
            >
              {label}
            </span>
            {n < STEP_LABELS.length && (
              <span className="text-zinc-300">›</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// ── Step 1: confirm workspace ───────────────────────────────────────────

function ConfirmStep({
  workspaceName,
  onNext,
}: {
  workspaceName: string;
  onNext: () => void;
}) {
  return (
    <Card className="space-y-4 p-6">
      <div>
        <h2 className="text-sm font-semibold text-zinc-700">
          Confirm workspace
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          You&apos;re setting up{" "}
          <span className="font-medium text-zinc-900">{workspaceName}</span>.
          Meetsy will read this workspace&apos;s ClickUp task history (already
          mirrored by Clicksy) to learn your team, components, and workflow — no
          new ClickUp permissions needed.
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          Switch workspaces from the picker in the header if this isn&apos;t the
          one you meant.
        </p>
      </div>
      <StepActions>
        <Button onClick={onNext}>Get started</Button>
      </StepActions>
    </Card>
  );
}

// ── Step 2: pick spaces ─────────────────────────────────────────────────

function SpacesStep({
  ws,
  selected,
  onChange,
  onBack,
  onNext,
}: {
  ws: string;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { spaces, error } = useKbSpaces(ws);

  if (error && spaces === null) return <ErrorBanner message={error} />;
  if (spaces === null) return <Spinner label="Loading spaces…" />;

  const isEmpty = spaces.length === 0;

  return (
    <Card className="space-y-4 p-6">
      <div>
        <h2 className="text-sm font-semibold text-zinc-700">Pick spaces</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Choose which ClickUp spaces feed the knowledge base. Leave all
          unchecked to include everything in range.
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      <SpacesChecklist spaces={spaces} selected={selected} onChange={onChange} />

      <StepActions onBack={onBack}>
        <Button onClick={onNext}>
          {isEmpty || selected.size === 0 ? "Continue anyway" : "Continue"}
        </Button>
      </StepActions>
    </Card>
  );
}

// ── Step 3: optional sub-scope ──────────────────────────────────────────

function SubScopeStep({
  ws,
  spaceIds,
  folderNames,
  listIds,
  clients,
  onFolders,
  onLists,
  onClients,
  onBack,
  onNext,
}: {
  ws: string;
  spaceIds: string[];
  folderNames: Set<string>;
  listIds: Set<string>;
  clients: Set<string>;
  onFolders: (next: Set<string>) => void;
  onLists: (next: Set<string>) => void;
  onClients: (next: Set<string>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <Card className="space-y-5 p-6">
      <div>
        <h2 className="text-sm font-semibold text-zinc-700">
          Narrow the scope (optional)
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Pick folders, lists, or clients to focus on. This step is optional.
        </p>
        <p className="mt-2 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
          Narrowing shrinks the knowledge base — more tasks generally means
          better suggestions. Leave everything empty to include everything in the
          selected spaces.
        </p>
      </div>

      <SubScopeChecklists
        ws={ws}
        spaceIds={spaceIds}
        folderNames={folderNames}
        listIds={listIds}
        clients={clients}
        onFolders={onFolders}
        onLists={onLists}
        onClients={onClients}
      />

      <StepActions onBack={onBack}>
        <Button
          variant="secondary"
          onClick={() => {
            onFolders(new Set());
            onLists(new Set());
            onClients(new Set());
            onNext();
          }}
        >
          Skip
        </Button>
        <Button onClick={onNext}>Continue</Button>
      </StepActions>
    </Card>
  );
}

// ── Step 4: date range ──────────────────────────────────────────────────

function RangeStep({
  range,
  onChange,
  onBack,
  onNext,
}: {
  range: KbRange;
  onChange: (r: KbRange) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <Card className="space-y-4 p-6">
      <div>
        <h2 className="text-sm font-semibold text-zinc-700">Date range</h2>
        <p className="mt-1 text-sm text-zinc-600">
          How far back should we read tasks? A wider window means a richer
          knowledge base but a longer first build.
        </p>
      </div>
      <RangeRadios range={range} onChange={onChange} />
      <StepActions onBack={onBack}>
        <Button onClick={onNext}>Continue</Button>
      </StepActions>
    </Card>
  );
}

// ── Step 5: start + progress ────────────────────────────────────────────

function BuildStep({
  ws,
  body,
  onBack,
  onReady,
}: {
  ws: string;
  body: KbOnboardBody;
  onBack: () => void;
  onReady: () => void;
}) {
  return <KbBuildPanel ws={ws} body={body} onBack={onBack} onDone={onReady} />;
}

// ── Step 6: what we learned ─────────────────────────────────────────────

function SummaryStep({ ws, onNext }: { ws: string; onNext: () => void }) {
  const [summary, setSummary] = useState<KbSummaryView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    void api
      .kbSummary(ws)
      .then((res) => {
        if (!active) return;
        setSummary(res);
      })
      .catch((err) => {
        if (!active) return;
        setError(messageOf(err, "Could not load the summary."));
      });
    return () => {
      active = false;
    };
  }, [ws]);

  if (error) {
    return (
      <Card className="space-y-4 p-6">
        <ErrorBanner message={error} />
        <p className="text-sm text-zinc-600">
          The knowledge base is built — we just couldn&apos;t summarize it right
          now. You can continue.
        </p>
        <StepActions>
          <Button onClick={onNext}>Continue</Button>
        </StepActions>
      </Card>
    );
  }

  if (!summary) return <Spinner label="Summarizing…" />;

  const facts = summary.facts ?? {};

  return (
    <Card className="space-y-5 p-6">
      <div>
        <h2 className="text-sm font-semibold text-zinc-700">What we learned</h2>
        <p className="mt-1 text-xs text-zinc-500">
          A snapshot distilled from your workspace history.
        </p>
      </div>

      {summary.narrative && (
        <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-700">
          {summary.narrative}
        </p>
      )}

      <FactsGrid facts={facts} />

      <p className="text-xs text-zinc-400">
        Generated {formatWhen(summary.generatedAt)}.
      </p>

      <StepActions>
        <Button onClick={onNext}>Continue</Button>
      </StepActions>
    </Card>
  );
}

/** Render the loosely-typed facts bag defensively — guard every shape. */
function FactsGrid({ facts }: { facts: KbFacts }) {
  const sections: Array<{ key: string; title: string }> = [
    { key: "roster", title: "Roster" },
    { key: "components", title: "Components" },
    { key: "throughput", title: "Throughput" },
    { key: "categories", title: "Categories" },
    { key: "workload", title: "Workload" },
    { key: "blockers", title: "Blockers" },
    { key: "coverage", title: "Coverage" },
  ];

  const rendered = sections
    .map((s) => ({ ...s, value: facts[s.key] }))
    .filter((s) => s.value != null && !isEmptyValue(s.value));

  if (rendered.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        No structured facts yet — the knowledge base is built but didn&apos;t
        surface a summary breakdown.
      </p>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {rendered.map((s) => (
        <div
          key={s.key}
          className="rounded-lg border border-zinc-200 bg-zinc-50 p-3"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            {s.title}
          </p>
          <div className="mt-1.5">
            <FactValue value={s.value} />
          </div>
        </div>
      ))}
    </div>
  );
}

function isEmptyValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object")
    return Object.keys(value as object).length === 0;
  return value === "" || value == null;
}

/** Best-effort defensive render of an unknown fact value. */
function FactValue({ value }: { value: unknown }) {
  if (value == null) return null;

  if (typeof value === "string" || typeof value === "number") {
    return <p className="text-sm text-zinc-700">{String(value)}</p>;
  }
  if (typeof value === "boolean") {
    return <p className="text-sm text-zinc-700">{value ? "Yes" : "No"}</p>;
  }
  if (Array.isArray(value)) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.slice(0, 24).map((item, i) => (
          <Tag key={i}>{scalarLabel(item)}</Tag>
        ))}
        {value.length > 24 && (
          <span className="text-xs text-zinc-400">
            +{value.length - 24} more
          </span>
        )}
      </div>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      12,
    );
    return (
      <dl className="space-y-0.5">
        {entries.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 text-sm">
            <dt className="text-zinc-500">{k}</dt>
            <dd className="text-right font-medium text-zinc-700">
              {scalarLabel(v)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return null;
}

/** Reduce an unknown to a short human label (objects → name/title or JSON). */
function scalarLabel(item: unknown): string {
  if (item == null) return "—";
  if (typeof item === "string") return item;
  if (typeof item === "number" || typeof item === "boolean")
    return String(item);
  if (typeof item === "object") {
    const obj = item as Record<string, unknown>;
    for (const key of ["name", "title", "label", "key"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
    try {
      const json = JSON.stringify(item);
      return json.length > 48 ? `${json.slice(0, 47)}…` : json;
    } catch {
      return "—";
    }
  }
  return String(item);
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// ── Step 7: optional document upload ────────────────────────────────────

function DocumentsStep({
  ws,
  onFinish,
}: {
  ws: string;
  onFinish: () => void;
}) {
  const [docs, setDocs] = useState<KbDocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await api.kbListDocuments(ws);
      // Contract pins a bare array; guard in case the backend wraps it.
      const list = Array.isArray(rows)
        ? rows
        : ((rows as { documents?: KbDocumentRow[] } | null)?.documents ?? []);
      setDocs(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(messageOf(err, "Could not load documents."));
    } finally {
      setLoading(false);
    }
  }, [ws]);

  useEffect(() => {
    let active = true;
    void (async () => {
      await load();
      if (!active) return;
    })();
    return () => {
      active = false;
    };
  }, [load]);

  const onUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Allow re-uploading the same filename (reset the input value).
      e.target.value = "";
      if (!file) return;
      setUploading(true);
      setUploadError(null);
      try {
        await api.kbUploadDocument(ws, file);
        await load();
      } catch (err) {
        setUploadError(messageOf(err, "Could not upload the document."));
      } finally {
        setUploading(false);
      }
    },
    [ws, load],
  );

  const onDelete = useCallback(
    async (docId: string) => {
      try {
        await api.kbDeleteDocument(ws, docId);
        await load();
      } catch (err) {
        setUploadError(messageOf(err, "Could not delete the document."));
      }
    },
    [ws, load],
  );

  return (
    <Card className="space-y-5 p-6">
      <div>
        <h2 className="text-sm font-semibold text-zinc-700">
          Add SOPs &amp; references (optional)
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Upload process docs, style guides, or definitions so Meetsy can ground
          its suggestions in how your team actually works. You can always do this
          later.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50">
          <input
            type="file"
            onChange={onUpload}
            disabled={uploading}
            className="hidden"
          />
          {uploading ? <Spinner label="Uploading…" /> : "Upload a document"}
        </label>
      </div>

      {uploadError && <ErrorBanner message={uploadError} />}

      <div className="space-y-2">
        {loading ? (
          <Spinner label="Loading documents…" />
        ) : loadError ? (
          <ErrorBanner message={loadError} />
        ) : docs.length === 0 ? (
          <p className="text-sm text-zinc-500">No documents yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
            {docs.map((doc) => (
              <li
                key={doc.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate text-zinc-700">
                  {doc.filename ?? doc.name ?? doc.id}
                  {doc.status && (
                    <span className="ml-2">
                      <Tag>{doc.status}</Tag>
                    </span>
                  )}
                </span>
                <Button
                  variant="danger"
                  className="px-2 py-1 text-xs"
                  onClick={() => onDelete(doc.id)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <StepActions>
        <Button variant="secondary" onClick={onFinish}>
          Skip
        </Button>
        <Button onClick={onFinish}>Finish</Button>
      </StepActions>
    </Card>
  );
}
