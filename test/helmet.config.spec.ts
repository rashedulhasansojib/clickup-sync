import express from 'express';
import helmet from 'helmet';
import request from 'supertest';

import { helmetOptions } from '../src/config/helmet.config';

// Guards the production-only bug where ClickUp assignee avatars (external HTTPS
// images) were blocked by helmet's default `img-src 'self' data:` CSP and fell
// back to initials. We assert the emitted header, not just the config object, so
// a future helmet upgrade that changes merge behavior can't silently regress it.
describe('helmetOptions CSP', () => {
  const app = express();
  app.use(helmet(helmetOptions));
  app.get('/', (_req, res) => res.send('ok'));

  it('allows external HTTPS images in img-src', async () => {
    const res = await request(app).get('/');
    const csp = res.headers['content-security-policy'] ?? '';
    expect(csp).toContain("img-src 'self' data: https:");
  });

  it('keeps other default protections (default-src self, object-src none)', async () => {
    const res = await request(app).get('/');
    const csp = res.headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });
});
