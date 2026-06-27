import { Injectable } from "@nestjs/common";
import { Prisma, UserStatus } from "@prisma/client";
import { sha256 } from "@clicksy/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "../config/config.service";

/** A validated session row with its joined user (only the fields Meetsy needs). */
export type ValidatedSession = Prisma.SessionGetPayload<{ include: { user: true } }>;

/**
 * READ-ONLY mirror of Clicksy's SessionService.validate(). Meetsy has no write
 * grant on `public`, so — unlike Clicksy — it never deletes expired/idle rows and
 * never touches `last_seen_at` (no sliding refresh). It only reads the session +
 * user and decides accept/reject. Hashing uses the SHARED sha256 so a token issued
 * by Clicksy hashes to the same `token_hash` Meetsy looks up.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private maxAgeDays(): number {
    return this.config.get("SESSION_MAX_AGE_DAYS");
  }
  private idleDays(): number {
    return this.config.get("SESSION_IDLE_TIMEOUT_DAYS");
  }

  /**
   * Validate a plaintext cookie token. Returns the session row + user, or null.
   * NO writes (read-only role): expired/idle sessions are rejected but not deleted.
   */
  async validate(token: string): Promise<ValidatedSession | null> {
    const row = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });
    if (!row) return null;
    // Absolute expiry.
    if (row.expiresAt.getTime() < Date.now()) return null;
    // Idle timeout (bounds a stolen cookie on an abandoned session). `lastSeenAt`
    // is null until Clicksy's first touch, so fall back to createdAt.
    const lastActivity = (row.lastSeenAt ?? row.createdAt)?.getTime() ?? 0;
    if (Date.now() - lastActivity > this.idleDays() * 24 * 60 * 60 * 1000) return null;
    if (!row.user || row.user.status === UserStatus.DISABLED) return null;
    return row;
  }
}
