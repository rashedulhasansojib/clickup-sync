import type { HelmetOptions } from 'helmet';

// Helmet's default Content-Security-Policy sets `img-src 'self' data:`, which
// blocks the SPA from loading ClickUp assignee avatars (served from an external
// HTTPS host, e.g. attachments.clickup.com). The avatars silently fall back to
// initials in production while working in dev (the Vite dev server applies no
// CSP). We keep every other helmet default and only widen `img-src` to permit
// external HTTPS images. `useDefaults` (on by default) merges this over the
// built-in directive set, so the rest of the policy is unchanged.
export const helmetOptions: HelmetOptions = {
  contentSecurityPolicy: {
    directives: {
      'img-src': ["'self'", 'data:', 'https:'],
    },
  },
};
