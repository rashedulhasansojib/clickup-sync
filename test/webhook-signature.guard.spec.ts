import * as crypto from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { WebhookSignatureGuard } from '../src/webhooks/webhook-signature.guard';

describe('WebhookSignatureGuard', () => {
  const SECRET = 'test-secret-key';
  const body = Buffer.from('{"event":"taskCreated","task_id":"abc"}');

  function makeGuard(secret: string) {
    return new WebhookSignatureGuard({ hasWorkspace: () => true, getWebhookSecret: () => secret } as any);
  }

  function makeCtx(rawBody: Buffer | undefined, signature: string | undefined) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'x-signature': signature }, rawBody, params: { workspaceId: 'ws1' } }),
      }),
    } as any;
  }

  it('passes with correct HMAC-SHA256 signature', () => {
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(makeGuard(SECRET).canActivate(makeCtx(body, sig))).toBe(true);
  });

  it('throws UnauthorizedException when signature header is missing', () => {
    expect(() => makeGuard(SECRET).canActivate(makeCtx(body, undefined))).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when signature is wrong', () => {
    expect(() => makeGuard(SECRET).canActivate(makeCtx(body, 'badsig'))).toThrow(UnauthorizedException);
  });

  it('passes and warns when the webhook secret is empty (dev mode)', () => {
    expect(makeGuard('').canActivate(makeCtx(undefined, undefined))).toBe(true);
  });

  it('throws InternalServerErrorException in production when secret is empty', () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => makeGuard('').canActivate(makeCtx(undefined, undefined)))
        .toThrow(/Webhook secret not configured/);
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }
  });
});
