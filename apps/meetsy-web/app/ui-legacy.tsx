import type { TaskPriority } from "@ma/shared";

/**
 * Legacy Meetsy UI primitives — the originals from before shadcn/ui landed in
 * Phase 0. Kept identical to preserve every existing caller's look and API.
 * `app/ui.tsx` is a shim that re-exports these; new work should reach for the
 * shadcn primitives at `@/components/ui/*` instead. This file goes away once
 * every caller has migrated (tracked per phase in the v2 plan).
 */

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-border bg-card text-card-foreground shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  className = "",
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
  const variants: Record<string, string> = {
    primary: "bg-primary text-primary-foreground hover:bg-primary/90",
    secondary:
      "border border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
    ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
    danger:
      "border border-destructive/40 bg-background text-destructive hover:bg-destructive/10",
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      {message}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <span
        aria-hidden
        className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-foreground"
      />
      {label ?? "Loading…"}
    </span>
  );
}

const PRIORITY_STYLES: Record<TaskPriority, string> = {
  urgent: "bg-red-100 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30",
  high: "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:border-orange-500/30",
  normal: "bg-muted text-muted-foreground border-border",
  low: "bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/30",
};

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${PRIORITY_STYLES[priority]}`}
    >
      {priority}
    </span>
  );
}

export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}
