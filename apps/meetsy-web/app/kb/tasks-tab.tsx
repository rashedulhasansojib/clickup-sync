"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type KbTaskRow } from "@/lib/api";
import { Button, Card, ErrorBanner, Spinner, Tag } from "@/app/ui";
import { useTaskSheet } from "@/components/tasks/task-sheet-context";
import { Input } from "@/components/ui/input";
import { formatWhen } from "@/app/kb/facts-summary";

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Tasks tab — paginated embedded-task list, keyset-cursored so a workspace
 * with 10k+ embedded tasks stays fast. Filter box is debounced 300ms and
 * cancels in-flight requests via an `AbortController`. Click a row to open
 * `TaskDetailSheet`.
 */
export function TasksTab({ ws }: { ws: string }) {
  const [filter, setFilter] = useState("");
  const [tasks, setTasks] = useState<KbTaskRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);
  const { openTaskSheet } = useTaskSheet();

  const fetchPage = useCallback(
    async (opts: { filter: string; cursor: string | null; append: boolean }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (opts.append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const page = await api.kbTasks(ws, {
          filter: opts.filter.trim() || undefined,
          cursor: opts.cursor ?? undefined,
        });
        if (controller.signal.aborted) return;
        setTasks((prev) => (opts.append ? [...prev, ...page.tasks] : page.tasks));
        setNextCursor(page.nextCursor);
        setTotal(page.total);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(messageOf(err, "Could not load tasks."));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [ws],
  );

  // First page + refetch on filter change (debounced).
  useEffect(() => {
    if (debounceRef.current !== undefined) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      void fetchPage({ filter, cursor: null, append: false });
    }, 300);
    return () => {
      if (debounceRef.current !== undefined) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [filter, fetchPage]);

  return (
    <Card className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-700">Embedded tasks</h2>
          <p className="mt-1 text-sm text-zinc-600">
            {total !== null
              ? `${total.toLocaleString()} task${total === 1 ? "" : "s"} in the knowledge base — most-recently-updated first.`
              : "Browsing embedded tasks — most-recently-updated first."}
          </p>
        </div>
      </div>

      <Input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by task name, client, or assignee…"
      />

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <Spinner label="Loading tasks…" />
      ) : tasks.length === 0 ? (
        <p className="text-sm text-zinc-500">
          {filter.trim()
            ? `No embedded tasks match "${filter.trim()}". Clear the filter to browse everything.`
            : "No tasks embedded yet. Run Rebuild to include a wider range."}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
            {tasks.map((task) => (
              <li key={task.taskId}>
                <button
                  type="button"
                  onClick={() => openTaskSheet(task.taskId)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-zinc-50"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate font-medium text-zinc-800">
                      {task.taskName}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {task.status && <Tag>{task.status}</Tag>}
                      {task.client && <Tag>{task.client}</Tag>}
                      {task.assigneesNames && (
                        <span className="text-xs text-zinc-500">
                          {task.assigneesNames}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-zinc-400">
                    <div>{formatWhen(task.updatedDate)}</div>
                    <div>
                      {task.chunkCount} chunk{task.chunkCount === 1 ? "" : "s"}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {nextCursor && (
            <div className="pt-2">
              <Button
                variant="secondary"
                onClick={() =>
                  void fetchPage({ filter, cursor: nextCursor, append: true })
                }
                disabled={loadingMore}
              >
                {loadingMore ? <Spinner label="Loading…" /> : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
