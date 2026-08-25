export type AppRole = 'web' | 'worker';

/**
 * Which process role this instance runs as. `web` serves HTTP + the SPA and
 * enqueues jobs; `worker` runs BullMQ processors + the cron scheduler. The
 * split exists so blue-green's warm old web color does NOT also run cron
 * (which would double-fire scheduled backfills). Defaults to `web`.
 */
export function getRole(): AppRole {
  const raw = (process.env.ROLE ?? '').trim().toLowerCase();
  return raw === 'worker' ? 'worker' : 'web';
}

export function isWorker(): boolean {
  return getRole() === 'worker';
}

export function isWeb(): boolean {
  return getRole() === 'web';
}
