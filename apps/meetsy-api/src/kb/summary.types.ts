/**
 * The exact, SQL-derived "what we learned" facts for a workspace (Phase 2a.1).
 *
 * JSON-NATIVE BY CONSTRUCTION: every value here is a string | number | boolean |
 * null or a plain array/object of those — never a BigInt, Prisma Decimal, or Date.
 * This object is (a) JSON.stringify'd into the narrative prompt, (b) persisted via
 * a Prisma `Json` upsert, and (c) returned over HTTP. Raw `count(*)` → BigInt and
 * `sum/percentile` → Decimal are coerced with Number() at the query boundary;
 * dates are emitted as `YYYY-MM-DD` / ISO strings. No LLM is involved in producing
 * any of it.
 */
export interface KbFacts {
  roster: RosterEntry[];
  components: ComponentEntry[];
  throughput: Throughput;
  categories: Categories;
  workload: WorkloadEntry[];
  blockers: Blockers;
  coverage: Coverage;
}

/** One distinct assignee + what they historically own. */
export interface RosterEntry {
  name: string;
  email: string | null;
  taskCount: number;
  openCount: number;
  closedCount: number;
  /** Top 3 components (list/folder/tag) this person appears on, by task volume. */
  topComponents: ComponentEntry[];
}

export interface ComponentEntry {
  component: string;
  taskCount: number;
}

/** Created vs closed per ISO week + open/closed totals + median cycle time. */
export interface Throughput {
  /** Last N ISO weeks, oldest→newest. `week` is the week-start `YYYY-MM-DD`. */
  weeks: ThroughputWeek[];
  openTotal: number;
  closedTotal: number;
  /** median(closed_date − created_date) in days over closed tasks; null if none. */
  medianCycleTimeDays: number | null;
}

export interface ThroughputWeek {
  week: string;
  created: number;
  closed: number;
}

export interface Categories {
  statusDistribution: CategoryBucket[];
  topTags: CategoryBucket[];
  clients: CategoryBucket[];
  departments: CategoryBucket[];
  sprints: CategoryBucket[];
}

export interface CategoryBucket {
  label: string;
  count: number;
}

export interface WorkloadEntry {
  user: string;
  hours: number;
}

export interface Blockers {
  overdueOpen: BlockerGroup;
  stale: BlockerGroup;
  reopened: BlockerGroup;
}

export interface BlockerGroup {
  count: number;
  samples: BlockerSample[];
}

export interface BlockerSample {
  taskId: string;
  taskName: string;
}

export interface Coverage {
  totalTasks: number;
  embeddedCount: number;
  dateRange: { earliest: string | null; latest: string | null };
  /** % of tasks whose comment sync completed (commentsSyncedAt set), 0–100. */
  commentCoveragePct: number;
}

/** The card returned by the endpoint and persisted (facts + the LLM prose). */
export interface KbSummaryView {
  facts: KbFacts;
  narrative: string | null;
  generatedAt: string;
}
