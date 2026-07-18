"use client";

import { cn } from "@/lib/utils";

/**
 * Tiny inline SVG sparkline for the /home learning digest. Six data points is
 * the sweet spot for the "weeks" trend — bringing in a charting lib for this
 * would be gratuitous. Renders one bar per point; null values render as a
 * dotted skeleton so an inactive week is legible, not just missing.
 */
export interface SparkPoint {
  label: string;
  value: number | null;
}

export function Sparkline({
  data,
  max,
  className,
}: {
  data: SparkPoint[];
  /** Optional shared max (across sibling sparklines) for consistent scaling. */
  max?: number;
  className?: string;
}) {
  if (data.length === 0) return null;
  const values = data.map((p) => p.value ?? 0);
  const localMax = max ?? Math.max(1, ...values);
  const barWidth = 100 / data.length;
  return (
    <svg
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Weekly trend: ${data.map((p) => `${p.label} ${p.value ?? "no data"}`).join(", ")}`}
      className={cn("h-10 w-full", className)}
    >
      {data.map((p, i) => {
        const x = i * barWidth + barWidth * 0.1;
        const w = barWidth * 0.8;
        const h = p.value == null ? 2 : (p.value / localMax) * 36;
        const y = 40 - h - 2;
        const missing = p.value == null;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={w}
            height={Math.max(h, 2)}
            rx={1}
            className={cn(
              "transition-colors",
              missing ? "fill-zinc-200" : "fill-zinc-700",
            )}
          />
        );
      })}
    </svg>
  );
}
