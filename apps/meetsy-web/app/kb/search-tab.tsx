"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, type KbSearchHit } from "@/lib/api";
import { Card, ErrorBanner, Spinner, Tag } from "@/app/ui";
import { useTaskSheet } from "@/components/tasks/task-sheet-context";
import { Input } from "@/components/ui/input";

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Search tab — a plain input + debounced (300ms) hybrid RRF hits. Clicking a
 * hit opens the `TaskDetailSheet`. Reads `?q=` on mount so the ⌘K palette (PR-S)
 * can deep-link into a specific query; the current query is echoed back to the
 * URL as the user types so browser-back works.
 */
export function SearchTab({ ws }: { ws: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const initialQ = params.get("q") ?? "";
  const [q, setQ] = useState(initialQ);
  const [hits, setHits] = useState<KbSearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<number | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const { openTaskSheet } = useTaskSheet();

  const run = useCallback(
    async (query: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      if (!query.trim()) {
        setHits(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const res = await api.kbSearch(ws, query.trim(), 20);
        if (controller.signal.aborted) return;
        setHits(res);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(messageOf(err, "Search failed."));
        setHits([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [ws],
  );

  useEffect(() => {
    if (debounceRef.current !== undefined) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      void run(q);
      // Echo the query into the URL so back/forward is honest, but don't
      // scroll (shallow).
      const next = new URLSearchParams(params.toString());
      if (q.trim()) next.set("q", q.trim());
      else next.delete("q");
      router.replace(`/kb?${next.toString()}`, { scroll: false });
    }, 300);
    return () => {
      if (debounceRef.current !== undefined) {
        window.clearTimeout(debounceRef.current);
      }
    };
    // params is a URLSearchParams instance — Router replace on every keystroke
    // is safe; we intentionally don't add `params` here to avoid a feedback loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, run, router]);

  return (
    <Card className="space-y-4 p-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Search the knowledge base</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Hybrid vector + keyword search across embedded ClickUp tasks. Click a
          result to open the task details.
        </p>
      </div>

      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search embedded tasks…"
        autoFocus
      />

      {error && <ErrorBanner message={error} />}

      {loading && !hits && <Spinner label="Searching…" />}

      {hits !== null && hits.length === 0 && !loading && (
        <p className="text-sm text-muted-foreground">
          {q.trim()
            ? `No embedded tasks match "${q.trim()}".`
            : "Type a query to search."}
        </p>
      )}

      {hits && hits.length > 0 && (
        <ul className="space-y-2">
          {hits.map((hit) => (
            <li key={hit.sourceId}>
              <button
                type="button"
                onClick={() => openTaskSheet(hit.sourceId)}
                className="flex w-full flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2 text-left hover:bg-muted/50"
              >
                <div className="flex items-center justify-between gap-3">
                  <code className="truncate text-xs text-muted-foreground">
                    {hit.sourceId}
                  </code>
                  <span className="text-xs text-muted-foreground/70">
                    score {hit.score.toFixed(3)}
                  </span>
                </div>
                <p className="line-clamp-2 text-sm text-foreground">
                  {hit.snippet}
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {hit.metadata.status && <Tag>{hit.metadata.status}</Tag>}
                  {hit.metadata.assignee && <Tag>{hit.metadata.assignee}</Tag>}
                  {hit.metadata.client && <Tag>{hit.metadata.client}</Tag>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
