export const QUEUES = {
  CLICKUP_WEBHOOKS: 'clickup-webhooks',
  CLICKUP_TASKS: 'clickup-tasks',
  CLICKUP_TIME_ENTRIES: 'clickup-time-entries',
  CLICKUP_BACKFILLS: 'clickup-backfills',
  MAINTENANCE: 'maintenance',
  CLICKUP_ASSIGNEE_REPLACEMENT: 'clickup-assignee-replacement',
  CLICKUP_COMMENTS: 'clickup-comments',
} as const;

/**
 * Worker options for processors that call the ClickUp API. The BullMQ limiter
 * caps how many jobs a worker runs per window so we don't blow ClickUp's rate
 * limit — important once worker concurrency is raised above the default of 1
 * (and a safety net for multi-instance deploys). Tunable via env.
 */
export function clickupWorkerOptions() {
  return {
    limiter: {
      max: Number(process.env.CLICKUP_JOB_RATE_MAX || 30),
      duration: Number(process.env.CLICKUP_JOB_RATE_DURATION_MS || 60_000),
    },
  };
}

/**
 * Worker options for the comment-sync worker. The comment backfill is the only
 * bulk consumer of the shared ClickUp token (100/min budget on Free/Unlimited/
 * Business), so its limiter is deliberately CONSERVATIVE (~40/min) — well under
 * the budget so the existing task + time-entry sync (and Meetsy's low-volume
 * calls on the same token) are never starved. Tunable via env.
 */
export function clickupCommentsWorkerOptions() {
  return {
    limiter: {
      max: Number(process.env.CLICKUP_COMMENTS_JOB_RATE_MAX || 40),
      duration: Number(process.env.CLICKUP_COMMENTS_JOB_RATE_DURATION_MS || 60_000),
    },
  };
}

export const JOBS = {
  PROCESS_CLICKUP_EVENT: 'process-clickup-event',
  SYNC_CLICKUP_TASK: 'sync-clickup-task',
  DELETE_CLICKUP_TASK: 'delete-clickup-task',
  RECONCILE_CLICKUP_TASK: 'reconcile-clickup-task',
  SYNC_TASK_TIME_ENTRIES: 'sync-task-time-entries',
  BACKFILL_CLICKUP_SPACE: 'backfill-clickup-space',
  REFRESH_CLICKUP_WEBHOOKS: 'refresh-clickup-webhooks',
  REPLACE_TIME_ENTRY_ASSIGNEES: 'replace-time-entry-assignees',
  RECALCULATE_COSTS: 'recalculate-costs',
  SYNC_TASK_COMMENTS: 'sync-task-comments',
} as const;
