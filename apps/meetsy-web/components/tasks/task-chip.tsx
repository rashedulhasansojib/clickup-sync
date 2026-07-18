"use client";

import { cn } from "@/lib/utils";
import { useTaskSheet } from "./task-sheet-context";

/**
 * v2 Phase 2 (PR-K) — a ClickUp task-id chip that opens the side sheet on
 * click. An interactive element (button, not span) — role/keyboard behavior
 * comes for free. Falls back to a static span when no `onOpen` is provided
 * AND no TaskSheetProvider is in the tree (defensive; the sheet is always
 * expected on `/runs/:id`).
 */
type Tone = "zinc" | "blue" | "amber" | "red" | "green" | "violet";
const TONE: Record<Tone, string> = {
  zinc: "bg-muted text-muted-foreground border-border",
  blue: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/30",
  amber: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30",
  red: "bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30",
  green: "bg-green-50 text-green-700 border-green-200 dark:bg-green-500/10 dark:text-green-300 dark:border-green-500/30",
  violet: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:border-violet-500/30",
};

export function TaskChip({
  taskId,
  tone = "blue",
  title,
  children,
  className,
}: {
  taskId: string;
  tone?: Tone;
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const { openTaskSheet } = useTaskSheet();
  return (
    <button
      type="button"
      onClick={() => openTaskSheet(taskId)}
      title={title ?? `Open ${taskId}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors hover:opacity-90 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-ring",
        TONE[tone],
        className,
      )}
    >
      {children ?? taskId}
    </button>
  );
}
