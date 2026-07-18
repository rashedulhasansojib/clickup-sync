"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * v2 Phase 2 (PR-K) — a single side-sheet slot per view. Any `TaskChip` in the
 * subtree can `openTaskSheet(taskId)` to swap the visible task; closing removes
 * the sheet but preserves the last taskId so a re-open transition is instant.
 *
 * Scoped to `runs/[runId]/page.tsx` for now (see spec §8) — hoisting to the
 * global AppShell is a Phase 4 concern.
 */
export interface TaskSheetState {
  open: boolean;
  taskId: string | null;
  openTaskSheet: (taskId: string) => void;
  close: () => void;
}

const TaskSheetContext = createContext<TaskSheetState | null>(null);

export function TaskSheetProvider({ children }: { children: React.ReactNode }) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const openTaskSheet = useCallback((next: string) => {
    setTaskId(next);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  const value = useMemo<TaskSheetState>(
    () => ({ open, taskId, openTaskSheet, close }),
    [open, taskId, openTaskSheet, close],
  );

  return <TaskSheetContext.Provider value={value}>{children}</TaskSheetContext.Provider>;
}

export function useTaskSheet(): TaskSheetState {
  const ctx = useContext(TaskSheetContext);
  // Fallback: a TaskChip may render OUTSIDE a provider (defensive — the
  // provider is expected but the chip mustn't crash a whole page if missing).
  // In that case clicks are no-ops.
  if (!ctx) {
    return {
      open: false,
      taskId: null,
      openTaskSheet: () => undefined,
      close: () => undefined,
    };
  }
  return ctx;
}
