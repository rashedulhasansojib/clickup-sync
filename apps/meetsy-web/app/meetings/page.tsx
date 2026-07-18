"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import type { RunListView, RunStatus } from "@ma/shared";
import { api, ApiError } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-context";
import { Button, Card, ErrorBanner, Spinner } from "@/app/ui";
import { RunRow } from "@/components/runs/run-list";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

type StatusFilter = RunStatus | "all";

const FILTERS: Array<{ label: string; value: StatusFilter }> = [
  { label: "All", value: "all" },
  { label: "Completed", value: "completed" },
  { label: "Running", value: "running" },
  { label: "Failed", value: "failed" },
];

/**
 * Full paginated history of runs. Filter + search state lives in the URL
 * (deep-linkable); status/search changes use `router.replace` so filter churn
 * doesn't fill history. Non-empty `q` hits /runs/search, empty `q` hits /runs.
 *
 * Next 15 requires `useSearchParams()` callers to sit inside a Suspense
 * boundary; the default export wraps the real component to satisfy that.
 */
export default function MeetingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-20">
          <Spinner label="Loading meetings…" />
        </div>
      }
    >
      <MeetingsInner />
    </Suspense>
  );
}

function MeetingsInner() {
  const router = useRouter();
  const search = useSearchParams();
  const { activeWorkspaceId } = useWorkspace();

  const statusParam = search.get("status") as StatusFilter | null;
  const status: StatusFilter =
    statusParam && FILTERS.some((f) => f.value === statusParam)
      ? statusParam
      : "all";
  const page = Math.max(1, Number.parseInt(search.get("page") ?? "1", 10) || 1);
  const q = (search.get("q") ?? "").trim();

  // Local input state — the URL's `q` is the "committed" value that the effect
  // fetches on. Typing updates `qInput`; a debounce commits it to the URL.
  const [qInput, setQInput] = useState(q);
  useEffect(() => {
    // Keep the input in sync when the URL changes externally (browser back, etc.).
    setQInput(q);
  }, [q]);

  const [runs, setRuns] = useState<RunListView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    let active = true;
    setLoading(true);
    setError(null);
    const call = q
      ? api.searchRuns(activeWorkspaceId, {
          q,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
          status: status === "all" ? undefined : status,
        })
      : api.listRuns(activeWorkspaceId, {
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
          status: status === "all" ? undefined : status,
        });
    void call
      .then((view) => {
        if (!active) return;
        setRuns(view);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) return;
        setError(
          err instanceof ApiError ? err.message : "Could not load runs.",
        );
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeWorkspaceId, page, status, q]);

  // Debounced commit of the search input into the URL.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (qInput === q) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      commitQuery(qInput);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // commitQuery closes over `search` and `router`; both stable in Next 15.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput, q]);

  function commitQuery(next: string) {
    const trimmed = next.trim();
    const params = new URLSearchParams(search.toString());
    if (trimmed) params.set("q", trimmed);
    else params.delete("q");
    params.delete("page"); // new search resets pagination
    const query = params.toString();
    router.replace(query ? `/meetings?${query}` : "/meetings");
  }

  function setFilter(next: StatusFilter) {
    const params = new URLSearchParams(search.toString());
    if (next === "all") params.delete("status");
    else params.set("status", next);
    params.delete("page"); // filter change resets pagination
    const query = params.toString();
    router.replace(query ? `/meetings?${query}` : "/meetings");
  }

  function goToPage(next: number) {
    const params = new URLSearchParams(search.toString());
    if (next <= 1) params.delete("page");
    else params.set("page", String(next));
    const query = params.toString();
    router.replace(query ? `/meetings?${query}` : "/meetings");
  }

  const total = runs?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = runs?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            Meetings
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Every analysis run in this workspace, newest first.
          </p>
        </div>
        <Link href="/new">
          <Button>Analyze a meeting</Button>
        </Link>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                status === f.value
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-900",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-72">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
            aria-hidden
          />
          <input
            type="search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Search transcripts…"
            aria-label="Search meetings"
            className="w-full rounded-md border border-zinc-300 bg-white py-1.5 pl-9 pr-8 text-sm outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200"
          />
          {qInput && (
            <button
              type="button"
              onClick={() => {
                setQInput("");
                commitQuery("");
              }}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {loading && !runs && (
        <Card className="flex items-center justify-center p-8">
          <Spinner label={q ? "Searching…" : "Loading runs…"} />
        </Card>
      )}

      {error && <ErrorBanner message={error} />}

      {!loading && !error && items.length === 0 && (
        <Card className="p-8 text-center">
          <h3 className="text-base font-medium text-zinc-900">
            {q ? "No runs match" : "No runs match"}
          </h3>
          <p className="mt-1 text-sm text-zinc-500">
            {q ? (
              <>
                Nothing found for <span className="font-medium">“{q}”</span>.
                {" "}
                <button
                  type="button"
                  onClick={() => commitQuery("")}
                  className="text-zinc-700 underline hover:text-zinc-900"
                >
                  Clear search
                </button>
              </>
            ) : status === "all" ? (
              "Upload a transcript to get started."
            ) : (
              `No runs with status “${status}.” Clear the filter to see everything.`
            )}
          </p>
        </Card>
      )}

      {items.length > 0 && (
        <div
          className={cn(
            "space-y-2 transition-opacity",
            loading && "pointer-events-none opacity-50",
          )}
        >
          {items.map((item) => (
            <RunRow key={item.id} item={item} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-zinc-500">
          <Button
            variant="secondary"
            disabled={page <= 1}
            onClick={() => goToPage(page - 1)}
          >
            ← Previous
          </Button>
          <span>
            Page {page} of {totalPages} · {total.toLocaleString()} run
            {total === 1 ? "" : "s"}
          </span>
          <Button
            variant="secondary"
            disabled={page >= totalPages}
            onClick={() => goToPage(page + 1)}
          >
            Next →
          </Button>
        </div>
      )}
    </div>
  );
}
