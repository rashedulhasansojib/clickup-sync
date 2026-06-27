import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import { IS_PUBLIC_KEY } from "./decorators";

const ADMIN_KEY = "machine-key-value-min-32-characters-long";

function reflector(isPublic = false) {
  return {
    getAllAndOverride: (k: string) => (k === IS_PUBLIC_KEY ? isPublic : undefined),
  } as any;
}

/** ConfigService stub; ADMIN_API_KEY defaults to "" (machine branch off). */
function config(adminKey = "") {
  return { get: (k: string) => (k === "ADMIN_API_KEY" ? adminKey : undefined) } as any;
}

function req(opts: Partial<{ cookies: any; headers: any; method: string }> = {}) {
  return { cookies: {}, headers: {}, method: "GET", ...opts };
}

function execCtx(request: any) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

/** A validated session row as SessionService.validate() would return it. */
function sessionRow(over: Partial<any> = {}) {
  return {
    user: { id: "u1", orgId: "org1", role: "ADMIN", email: "a@x.com", ...over },
  };
}

describe("AuthGuard.canActivate", () => {
  it("allows @Public routes without touching SessionService", async () => {
    const sessions = { validate: jest.fn() } as any;
    const guard = new AuthGuard(reflector(true), sessions, config());

    expect(await guard.canActivate(execCtx(req()))).toBe(true);
    expect(sessions.validate).not.toHaveBeenCalled();
  });

  it("accepts a valid cookie and sets req.user to the principal", async () => {
    const sessions = { validate: jest.fn(async () => sessionRow()) } as any;
    const guard = new AuthGuard(reflector(false), sessions, config());
    const r = req({ cookies: { clickup_sync_sid: "tok" } });

    expect(await guard.canActivate(execCtx(r))).toBe(true);
    expect(sessions.validate).toHaveBeenCalledWith("tok");
    expect((r as any).user).toEqual({
      userId: "u1",
      orgId: "org1",
      role: "ADMIN",
      email: "a@x.com",
      isMachine: false,
    });
  });

  it("throws Unauthorized when no session cookie is present", async () => {
    const guard = new AuthGuard(reflector(false), { validate: jest.fn() } as any, config());

    await expect(guard.canActivate(execCtx(req()))).rejects.toThrow(UnauthorizedException);
  });

  it("throws Unauthorized when validate() returns null", async () => {
    const sessions = { validate: jest.fn(async () => null) } as any;
    const guard = new AuthGuard(reflector(false), sessions, config());
    const r = req({ cookies: { clickup_sync_sid: "bad" } });

    await expect(guard.canActivate(execCtx(r))).rejects.toThrow(UnauthorizedException);
  });

  it("throws Forbidden on a mutating request with a mismatched CSRF token", async () => {
    const sessions = { validate: jest.fn(async () => sessionRow()) } as any;
    const guard = new AuthGuard(reflector(false), sessions, config());
    const r = req({
      method: "POST",
      cookies: { clickup_sync_sid: "tok", csrf: "aaa" },
      headers: { "x-csrf-token": "bbb" },
    });

    await expect(guard.canActivate(execCtx(r))).rejects.toThrow(ForbiddenException);
  });

  it("throws Forbidden on a mutating request with a missing CSRF header", async () => {
    const sessions = { validate: jest.fn(async () => sessionRow()) } as any;
    const guard = new AuthGuard(reflector(false), sessions, config());
    const r = req({ method: "POST", cookies: { clickup_sync_sid: "tok", csrf: "aaa" } });

    await expect(guard.canActivate(execCtx(r))).rejects.toThrow(ForbiddenException);
  });

  it("allows a mutating request when the CSRF header equals the cookie", async () => {
    const sessions = { validate: jest.fn(async () => sessionRow()) } as any;
    const guard = new AuthGuard(reflector(false), sessions, config());
    const r = req({
      method: "POST",
      cookies: { clickup_sync_sid: "tok", csrf: "match" },
      headers: { "x-csrf-token": "match" },
    });

    expect(await guard.canActivate(execCtx(r))).toBe(true);
    expect((r as any).user.isMachine).toBe(false);
  });

  it("accepts a matching x-admin-key as a synthetic OWNER machine principal", async () => {
    const sessions = { validate: jest.fn() } as any;
    const guard = new AuthGuard(reflector(false), sessions, config(ADMIN_KEY));
    const r = req({ headers: { "x-admin-key": ADMIN_KEY } });

    expect(await guard.canActivate(execCtx(r))).toBe(true);
    expect(sessions.validate).not.toHaveBeenCalled();
    expect((r as any).user).toEqual({
      userId: "machine",
      orgId: "",
      role: "OWNER",
      email: null,
      isMachine: true,
    });
  });
});
