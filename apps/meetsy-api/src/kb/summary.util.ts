import type { ComponentEntry, ThroughputWeek } from "./summary.types";

/** Split a comma-joined ClickUp string into trimmed, non-empty parts. */
export function parseList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface ParsedAssignee {
  name: string;
  email: string | null;
  /** Stable identity key for dedup: lowercased email if present, else name. */
  key: string;
}

/**
 * Pair the positionally-aligned `assignees_names` / `assignees_emails` strings
 * into distinct assignees. Defensive: tolerates mismatched lengths (zips by index,
 * fills the shorter side with null), falls back to the email as the display name
 * when a name slot is missing, and drops fully-empty slots.
 */
export function parseAssignees(
  names: string | null | undefined,
  emails: string | null | undefined,
): ParsedAssignee[] {
  const nameArr = parseList(names);
  const emailArr = parseList(emails);
  const len = Math.max(nameArr.length, emailArr.length);
  const out: ParsedAssignee[] = [];
  for (let i = 0; i < len; i++) {
    const email = emailArr[i] ?? null;
    const name = nameArr[i] ?? email ?? null;
    if (!name) continue;
    const key = (email ?? name).toLowerCase();
    out.push({ name, email, key });
  }
  return out;
}

/** The most specific component label for a task: list → folder → first tag. */
export function primaryComponent(task: {
  listName?: string | null;
  folderName?: string | null;
  tags?: string | null;
}): string | null {
  if (task.listName && task.listName.trim()) return task.listName.trim();
  if (task.folderName && task.folderName.trim()) return task.folderName.trim();
  const [firstTag] = parseList(task.tags);
  return firstTag ?? null;
}

/** Top-N entries of a label→count map, ties broken by label for determinism. */
export function topCounts(counts: Map<string, number>, n: number): ComponentEntry[] {
  return [...counts.entries()]
    .map(([component, taskCount]) => ({ component, taskCount }))
    .sort((a, b) => b.taskCount - a.taskCount || a.component.localeCompare(b.component))
    .slice(0, n);
}

/** Monday (UTC) of the ISO week containing `d`, as `YYYY-MM-DD`. */
export function isoWeekStart(d: Date): string {
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay: 0=Sun..6=Sat. Shift so Monday=0.
  const shift = (u.getUTCDay() + 6) % 7;
  u.setUTCDate(u.getUTCDate() - shift);
  return u.toISOString().slice(0, 10);
}

/** The last `n` ISO-week-start dates ending with the week containing `now`. */
export function lastIsoWeeks(now: Date, n: number): string[] {
  const start = isoWeekStart(now);
  const base = new Date(`${start}T00:00:00.000Z`);
  const weeks: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const w = new Date(base);
    w.setUTCDate(w.getUTCDate() - i * 7);
    weeks.push(w.toISOString().slice(0, 10));
  }
  return weeks;
}

/**
 * Merge created/closed per-week raw rows onto a fixed `n`-week skeleton ending at
 * `now`, zero-filling gaps so the sparkline is dense. Pure + unit-tested.
 */
export function buildThroughputWeeks(
  createdRows: Array<{ week: string; count: number }>,
  closedRows: Array<{ week: string; count: number }>,
  now: Date,
  n: number,
): ThroughputWeek[] {
  const created = new Map(createdRows.map((r) => [r.week, r.count]));
  const closed = new Map(closedRows.map((r) => [r.week, r.count]));
  return lastIsoWeeks(now, n).map((week) => ({
    week,
    created: created.get(week) ?? 0,
    closed: closed.get(week) ?? 0,
  }));
}

/**
 * Staleness gate for the cached card: regenerate when the embedded count moved
 * "materially" (>2%, min 1 task) since the cached card was generated. Pure +
 * unit-tested. Exact equality would also satisfy the spec; the small tolerance
 * just avoids regenerating on a single incidental embed.
 */
export function isStale(cachedCount: number, currentCount: number): boolean {
  const diff = Math.abs(cachedCount - currentCount);
  if (diff === 0) return false;
  return diff > Math.max(1, Math.floor(currentCount * 0.02));
}
