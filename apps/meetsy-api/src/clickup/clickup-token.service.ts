import { Injectable, Logger } from "@nestjs/common";
import { decryptSecret, parseEncryptionKey } from "@clicksy/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "../config/config.service";

export interface WorkspaceClickUpCreds {
  /** The raw ClickUp API token to put in the Authorization header. */
  token: string;
  /** The ClickUp team id for `/team/{teamId}/...` calls. */
  teamId: string;
}

/**
 * Resolves a workspace's ClickUp credentials from the `public.workspaces`
 * read-model (granted SELECT in Phase 0). The per-workspace token is stored
 * encrypted by Clicksy (`clickup_api_token_enc`); Meetsy decrypts it with the
 * shared APP_ENCRYPTION_KEY. Falls back to the CLICKUP_API_TOKEN env when a
 * workspace has no stored token (mirrors Clicksy).
 *
 * Decryption is decrypt-only and lives in `@clicksy/shared` so the AES-256-GCM
 * scheme stays byte-identical to Clicksy's `crypto.service`.
 */
@Injectable()
export class ClickUpTokenService {
  private readonly logger = new Logger(ClickUpTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async resolve(workspaceId: string): Promise<WorkspaceClickUpCreds> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    if (!ws.clickupTeamId) {
      throw new Error(`Workspace ${workspaceId} has no ClickUp team id configured`);
    }

    const token = this.resolveToken(ws.clickupApiTokenEnc, workspaceId);
    return { token, teamId: ws.clickupTeamId };
  }

  private resolveToken(enc: string | null, workspaceId: string): string {
    if (enc) {
      const rawKey = this.config.get("APP_ENCRYPTION_KEY");
      let key;
      try {
        key = parseEncryptionKey(rawKey);
      } catch (err) {
        throw new Error(
          `Cannot decrypt the ClickUp token for workspace ${workspaceId}: ${(err as Error).message}`,
        );
      }
      try {
        return decryptSecret(enc, key);
      } catch {
        throw new Error(
          `Failed to decrypt the ClickUp token for workspace ${workspaceId} — APP_ENCRYPTION_KEY may not match the key Clicksy used to encrypt it.`,
        );
      }
    }

    const fallback = this.config.get("CLICKUP_API_TOKEN");
    if (fallback) return fallback;

    throw new Error(
      `No ClickUp token available for workspace ${workspaceId}: the workspace has no stored token and CLICKUP_API_TOKEN is not set.`,
    );
  }
}
