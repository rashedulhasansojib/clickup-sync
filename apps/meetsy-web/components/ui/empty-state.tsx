import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * v2 Phase 6 (PR-CC) — a small "nothing here yet" surface. Icon in a muted
 * circle, title, optional description, optional single action (link OR
 * onClick). Dashed border to visually mark the *absence* of content without
 * feeling like a hard error state.
 */
export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  const button = action ? (
    <Button size="sm" onClick={action.onClick} type="button">
      {action.label}
    </Button>
  ) : null;

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card p-8 text-center",
        className,
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Icon className="h-5 w-5 text-muted-foreground" aria-hidden />
      </div>
      <div className="space-y-1">
        <h3 className="text-base font-medium text-foreground">{title}</h3>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && (action.href ? <Link href={action.href}>{button}</Link> : button)}
    </div>
  );
}
