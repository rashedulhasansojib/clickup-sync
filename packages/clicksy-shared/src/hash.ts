import { createHash } from 'node:crypto';

/**
 * SHA-256 hex digest. MUST stay byte-for-byte identical to Clicksy's
 * `src/common/utils/hash.ts` so both services hash the same session token to the
 * same `public.sessions.token_hash` value. (Clicksy's variant accepts `unknown`
 * and JSON-stringifies non-strings; session tokens are always strings, so the
 * narrowed `string` signature here produces identical output for that use.)
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
