import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import type { Request } from 'express';
import { WorkspaceService } from '../workspaces/workspace.service';

@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);
  constructor(private readonly workspaces: WorkspaceService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer; params?: Record<string, string> }>();
    // The :workspaceId route param selects which workspace's signing secret to
    // verify against. Unknown/missing → no secret → handled below.
    const workspaceId = req.params?.workspaceId;
    const secret = workspaceId && this.workspaces.hasWorkspace(workspaceId) ? this.workspaces.getWebhookSecret(workspaceId) : '';

    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        // No secret anywhere (env or DB). Reject until a webhook is registered
        // (which persists the secret) so prod never accepts unsigned payloads.
        throw new InternalServerErrorException('Webhook secret not configured — register the ClickUp webhook first');
      }
      this.logger.warn('Webhook secret not set — skipping signature verification (dev mode)');
      return true;
    }

    const signature = req.headers['x-signature'] as string | undefined;
    if (!signature) throw new UnauthorizedException('Missing X-Signature header');

    const rawBody = req.rawBody;
    if (!rawBody) throw new UnauthorizedException('Raw body unavailable');

    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected);
    const signatureBuf = Buffer.from(signature);

    if (expectedBuf.length !== signatureBuf.length || !crypto.timingSafeEqual(expectedBuf, signatureBuf)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return true;
  }
}
