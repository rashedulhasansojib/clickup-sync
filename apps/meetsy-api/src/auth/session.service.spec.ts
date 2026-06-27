import { sha256 } from "@clicksy/shared";
import { SessionService } from "./session.service";

const DAY = 24 * 60 * 60 * 1000;

/** Config stub: maxAge=30d, idle=7d (mirrors the meetsy-api defaults). */
function config() {
  return {
    get: (k: string) => {
      if (k === "SESSION_MAX_AGE_DAYS") return 30;
      if (k === "SESSION_IDLE_TIMEOUT_DAYS") return 7;
      return undefined;
    },
  } as any;
}

/** Prisma stub with spied write methods so the read-only invariant is assertable. */
function prisma(row: any) {
  return {
    session: {
      findUnique: jest.fn(async () => row),
      delete: jest.fn(),
      update: jest.fn(),
    },
  } as any;
}

/** A healthy session row (joined ACTIVE user, recent activity, far-future expiry). */
function freshRow(over: Partial<any> = {}) {
  const now = Date.now();
  return {
    id: "sess1",
    tokenHash: "irrelevant",
    expiresAt: new Date(now + 10 * DAY),
    lastSeenAt: new Date(now - 1 * DAY),
    createdAt: new Date(now - 2 * DAY),
    user: { id: "u1", orgId: "org1", role: "ADMIN", email: "a@x.com", status: "ACTIVE" },
    ...over,
  };
}

describe("SessionService.validate", () => {
  it("returns the row for a valid, non-expired, recently-seen ACTIVE session", async () => {
    const row = freshRow();
    const db = prisma(row);
    const svc = new SessionService(db, config());

    await expect(svc.validate("tok")).resolves.toBe(row);
  });

  it("looks the token up by its shared sha256 hash", async () => {
    const db = prisma(freshRow());
    const svc = new SessionService(db, config());

    await svc.validate("plaintext-token");

    expect(db.session.findUnique).toHaveBeenCalledTimes(1);
    expect(db.session.findUnique.mock.calls[0][0].where.tokenHash).toBe(
      sha256("plaintext-token"),
    );
  });

  it("returns null for an unknown token (findUnique → null)", async () => {
    const db = prisma(null);
    const svc = new SessionService(db, config());

    await expect(svc.validate("nope")).resolves.toBeNull();
  });

  it("rejects an expired session WITHOUT writing (read-only invariant)", async () => {
    const expired = freshRow({ expiresAt: new Date(Date.now() - 1 * DAY) });
    const db = prisma(expired);
    const svc = new SessionService(db, config());

    await expect(svc.validate("tok")).resolves.toBeNull();
    // The read-only role must never delete or touch the row.
    expect(db.session.delete).not.toHaveBeenCalled();
    expect(db.session.update).not.toHaveBeenCalled();
  });

  it("rejects an idle session (last activity older than 7 days)", async () => {
    const now = Date.now();
    const idle = freshRow({
      // Not absolutely expired, but no activity inside the idle window.
      expiresAt: new Date(now + 10 * DAY),
      lastSeenAt: new Date(now - 8 * DAY),
      createdAt: new Date(now - 9 * DAY),
    });
    const db = prisma(idle);
    const svc = new SessionService(db, config());

    await expect(svc.validate("tok")).resolves.toBeNull();
    expect(db.session.delete).not.toHaveBeenCalled();
    expect(db.session.update).not.toHaveBeenCalled();
  });

  it("falls back to createdAt for idle when lastSeenAt is null", async () => {
    const now = Date.now();
    const idle = freshRow({
      lastSeenAt: null,
      createdAt: new Date(now - 8 * DAY),
    });
    const svc = new SessionService(prisma(idle), config());

    await expect(svc.validate("tok")).resolves.toBeNull();
  });

  it("rejects a DISABLED user", async () => {
    const disabled = freshRow({
      user: { id: "u1", orgId: "org1", role: "ADMIN", email: "a@x.com", status: "DISABLED" },
    });
    const svc = new SessionService(prisma(disabled), config());

    await expect(svc.validate("tok")).resolves.toBeNull();
  });
});
