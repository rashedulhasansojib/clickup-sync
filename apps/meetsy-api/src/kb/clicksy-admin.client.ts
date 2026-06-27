import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "../config/config.service";

/**
 * Thin client for Clicksy's internal admin API, used by KB onboarding to fill a
 * coverage gap before embedding: trigger a task backfill + a comment backfill on
 * a space, then poll until the work drains.
 *
 * Cross-service auth = the shared `ADMIN_API_KEY` (the same machine credential
 * Clicksy mints a synthetic Owner from). Native `fetch` (Node 22+), mirroring
 * meetsy's ClickUpClient. DEGRADES GRACEFULLY: if unconfigured or unreachable,
 * methods log + no-op so onboarding proceeds with whatever is already mirrored.
 */
@Injectable()
export class ClicksyAdminClient {
  private readonly logger = new Logger(ClicksyAdminClient.name);

  constructor(private readonly config: ConfigService) {}

  /** True when both the base URL and the shared admin key are configured. */
  get isConfigured(): boolean {
    return Boolean(this.config.get("CLICKSY_ADMIN_URL") && this.config.get("ADMIN_API_KEY"));
  }

  private async post(path: string, body: unknown, workspaceId: string): Promise<boolean> {
    const base = this.config.get("CLICKSY_ADMIN_URL");
    const key = this.config.get("ADMIN_API_KEY");
    if (!base || !key) return false;
    const url = `${base.replace(/\/$/, "")}${path}?workspaceId=${encodeURIComponent(workspaceId)}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": key },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        this.logger.warn(`Clicksy admin POST ${path} → ${res.status} ${detail}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`Clicksy admin POST ${path} unreachable: ${(err as Error).message}`);
      return false;
    }
  }

  /** POST /admin/backfill — mirror a space's tasks for the given lookback. */
  triggerTaskBackfill(workspaceId: string, spaceId: string, lookbackDays: number): Promise<boolean> {
    return this.post("/admin/backfill", { spaceId, lookbackDays }, workspaceId);
  }

  /** POST /admin/comments/backfill — mirror a space's task comments (throttled). */
  triggerCommentBackfill(workspaceId: string, spaceId: string): Promise<boolean> {
    return this.post("/admin/comments/backfill", { spaceId }, workspaceId);
  }

  /** GET /admin/backfill/active — returns the live per-space progress. */
  private async getActiveSpaceCount(workspaceId: string): Promise<number | null> {
    const base = this.config.get("CLICKSY_ADMIN_URL");
    const key = this.config.get("ADMIN_API_KEY");
    if (!base || !key) return null;
    const url = `${base.replace(/\/$/, "")}/admin/backfill/active?workspaceId=${encodeURIComponent(workspaceId)}`;
    try {
      const res = await fetch(url, { headers: { "x-admin-key": key } });
      if (!res.ok) return null;
      const data = (await res.json()) as { spaces?: unknown[] };
      return Array.isArray(data.spaces) ? data.spaces.length : 0;
    } catch (err) {
      this.logger.warn(`Clicksy admin /backfill/active unreachable: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Poll /admin/backfill/active until no spaces are in flight, or the timeout
   * elapses. Bounded so a stuck/unreachable Clicksy never hangs the embed job
   * (which BullMQ could otherwise mark stalled). Returns true if it drained.
   */
  async pollUntilDrained(
    workspaceId: string,
    { timeoutMs = 5 * 60_000, intervalMs = 5_000 }: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await this.getActiveSpaceCount(workspaceId);
      // null = unreachable; stop polling and let onboarding proceed (degrade).
      if (active === null) return false;
      if (active === 0) return true;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    this.logger.warn(`Clicksy backfill poll timed out for workspace ${workspaceId}`);
    return false;
  }
}
