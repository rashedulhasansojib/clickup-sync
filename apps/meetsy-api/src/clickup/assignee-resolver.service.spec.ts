import { AssigneeResolverService } from "./assignee-resolver.service";
import { AssignableMember } from "./clickup.types";

describe("AssigneeResolverService", () => {
  const svc = new AssigneeResolverService();
  const members: AssignableMember[] = [
    { clickupUserId: "1", name: "Sarah Khan", email: "sarah@x.com" },
    { clickupUserId: "2", name: "Ahmad Ali" },
    { clickupUserId: "3", name: "Fahim" },
  ];

  it("matches case-insensitive exact full name", () => {
    expect(svc.resolve("sarah khan", members)).toBe("1");
    expect(svc.resolve("AHMAD ALI", members)).toBe("2");
  });

  it("matches on first name", () => {
    expect(svc.resolve("Sarah", members)).toBe("1");
    expect(svc.resolve("Ahmad", members)).toBe("2");
  });

  it("matches a single-token member exactly by name", () => {
    expect(svc.resolve("Fahim", members)).toBe("3");
  });

  it("matches when only the first name is given (first-token match)", () => {
    expect(svc.resolve("Sarah K", members)).toBe("1"); // first token 'sarah' matches
  });

  it("returns null for an unknown name (never matches outside the allowlist)", () => {
    expect(svc.resolve("Rejaur", members)).toBe(null);
    expect(svc.resolve("Someone Else", members)).toBe(null);
  });

  it("returns null for null/empty input", () => {
    expect(svc.resolve(null, members)).toBe(null);
    expect(svc.resolve("", members)).toBe(null);
    expect(svc.resolve("   ", members)).toBe(null);
  });

  it("returns null when the allowlist is empty", () => {
    expect(svc.resolve("Sarah Khan", [])).toBe(null);
  });
});
