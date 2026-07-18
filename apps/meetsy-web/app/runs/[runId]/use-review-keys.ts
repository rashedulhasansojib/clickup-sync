"use client";

import { useEffect } from "react";

/**
 * v2 Phase 6 (PR-BB) — j/k task traversal for the review page.
 *
 * Attaches a window-level `keydown` listener that moves focus between task
 * anchors (`[data-task-anchor="<id>"]`). Guards against typing in inputs,
 * textareas, or `contenteditable` regions so text editing is untouched. The
 * hook does not intercept Esc — Radix Sheet handles its own dismissal.
 *
 * Bindings:
 *   j, ArrowDown → focus next task anchor (wraps to first at end)
 *   k, ArrowUp   → focus previous task anchor (wraps to last at start)
 */
export function useReviewKeys(): void {
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (event.key !== "j" && event.key !== "k" &&
          event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const anchors = Array.from(
        document.querySelectorAll<HTMLElement>("[data-task-anchor]"),
      );
      if (anchors.length === 0) return;

      const focused = document.activeElement as HTMLElement | null;
      const currentIdx = focused
        ? anchors.findIndex((a) => a === focused || a.contains(focused))
        : -1;

      const forward = event.key === "j" || event.key === "ArrowDown";
      const nextIdx = forward
        ? currentIdx < 0
          ? 0
          : (currentIdx + 1) % anchors.length
        : currentIdx <= 0
          ? anchors.length - 1
          : currentIdx - 1;

      event.preventDefault();
      anchors[nextIdx].focus({ preventScroll: false });
      anchors[nextIdx].scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
