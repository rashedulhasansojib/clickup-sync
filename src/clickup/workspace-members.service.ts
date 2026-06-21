import { Injectable } from '@nestjs/common';
import { ClickupClient } from './clickup.client';

const TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface MemberDto {
  id: string;
  name: string | null;
  email: string | null;
  profilePicture: string | null;
  color: string | null;
  initials: string | null;
}

/**
 * Cached resolver for the workspace's members. Used by the time-entry sync to
 * pass `assignee=<all members>` to ClickUp's `/team/{team}/time_entries`
 * endpoint (the only way to capture tracked time on tasks the loggers are not
 * assignees of), and by the dashboard to render member profile photos. ClickUp
 * is hit at most once per TTL window; concurrent callers share the in-flight
 * promise.
 */
@Injectable()
export class WorkspaceMembersService {
  // Cache + in-flight promise are keyed by workspaceId so each connected
  // workspace resolves its own member directory independently.
  private cache = new Map<string, { members: MemberDto[]; expiresAt: number }>();
  private inFlight = new Map<string, Promise<MemberDto[]>>();

  constructor(private readonly clickup: ClickupClient) {}

  async getDirectory(workspaceId: string): Promise<MemberDto[]> {
    const cached = this.cache.get(workspaceId);
    if (cached && Date.now() < cached.expiresAt) return cached.members;
    const existing = this.inFlight.get(workspaceId);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const raw = await this.clickup.getTeamMembers(workspaceId);
        const members: MemberDto[] = raw
          .filter((m) => m?.user?.id !== null && m?.user?.id !== undefined)
          .map((m) => ({
            id: String(m.user.id),
            name: m.user.username ?? null,
            email: m.user.email ?? null,
            profilePicture: m.user.profilePicture ?? null,
            color: m.user.color ?? null,
            initials: m.user.initials ?? null,
          }));
        this.cache.set(workspaceId, { members, expiresAt: Date.now() + TTL_MS });
        return members;
      } finally {
        this.inFlight.delete(workspaceId);
      }
    })();
    this.inFlight.set(workspaceId, promise);
    return promise;
  }

  async getMemberIds(workspaceId: string): Promise<string[]> {
    return (await this.getDirectory(workspaceId)).map((m) => m.id);
  }
}
