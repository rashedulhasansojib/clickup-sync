import { createCipheriv, randomBytes } from "node:crypto";
import { parseEncryptionKey } from "@clicksy/shared";
import { ClickUpTokenService } from "./clickup-token.service";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "../config/config.service";

const KEY_RAW = "a".repeat(64); // 64 hex
function encrypt(plain: string): string {
  const key = parseEncryptionKey(KEY_RAW);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function makeService(opts: {
  workspace: any;
  env?: Record<string, string>;
}): ClickUpTokenService {
  const prisma = {
    workspace: { findUnique: jest.fn().mockResolvedValue(opts.workspace) },
  } as unknown as PrismaService;
  const config = {
    get: (k: string) => opts.env?.[k] ?? "",
  } as unknown as ConfigService;
  return new ClickUpTokenService(prisma, config);
}

describe("ClickUpTokenService", () => {
  it("decrypts a stored per-workspace token with APP_ENCRYPTION_KEY", async () => {
    const svc = makeService({
      workspace: { id: "ws1", clickupTeamId: "t1", clickupApiTokenEnc: encrypt("pk_SECRET") },
      env: { APP_ENCRYPTION_KEY: KEY_RAW },
    });
    await expect(svc.resolve("ws1")).resolves.toEqual({ token: "pk_SECRET", teamId: "t1" });
  });

  it("falls back to CLICKUP_API_TOKEN when no stored token", async () => {
    const svc = makeService({
      workspace: { id: "ws1", clickupTeamId: "t1", clickupApiTokenEnc: null },
      env: { CLICKUP_API_TOKEN: "pk_ENV" },
    });
    await expect(svc.resolve("ws1")).resolves.toEqual({ token: "pk_ENV", teamId: "t1" });
  });

  it("throws when neither a stored token nor an env fallback exists", async () => {
    const svc = makeService({
      workspace: { id: "ws1", clickupTeamId: "t1", clickupApiTokenEnc: null },
      env: {},
    });
    await expect(svc.resolve("ws1")).rejects.toThrow(/No ClickUp token/);
  });

  it("throws a clear error when the key cannot decrypt the stored token", async () => {
    const svc = makeService({
      workspace: { id: "ws1", clickupTeamId: "t1", clickupApiTokenEnc: encrypt("pk_SECRET") },
      env: { APP_ENCRYPTION_KEY: "b".repeat(64) }, // wrong key
    });
    await expect(svc.resolve("ws1")).rejects.toThrow(/Failed to decrypt/);
  });

  it("throws when the workspace is unknown", async () => {
    const svc = makeService({ workspace: null });
    await expect(svc.resolve("nope")).rejects.toThrow(/not found/);
  });
});
