import { createDecipheriv } from 'node:crypto';

/**
 * Decrypt-only port of Clicksy's `src/settings/crypto.service.ts` AES-256-GCM
 * scheme, used by Meetsy to read per-workspace ClickUp tokens stored at rest by
 * Clicksy. Meetsy NEVER encrypts — it only needs the inverse of Clicksy's
 * `encrypt()`. The algorithm/format MUST stay byte-for-byte identical to
 * Clicksy's, or token decryption silently drifts.
 *
 * Ciphertext format (same as Clicksy): base64( iv[12] | authTag[16] | ciphertext ).
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;

/**
 * Parse a raw APP_ENCRYPTION_KEY into a 32-byte key buffer, mirroring Clicksy's
 * accepted formats in the SAME precedence order:
 *   1. 64 hex chars
 *   2. base64 that decodes to exactly 32 bytes
 *   3. a raw 32-byte UTF-8 string
 *
 * Unlike Clicksy's internal `parseKey` (which returns null and disables
 * encryption), Meetsy needs a usable key whenever push is invoked, so this
 * THROWS a clear error on an invalid/missing key rather than returning null.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error(
      'APP_ENCRYPTION_KEY is not set. It is required to decrypt the workspace ClickUp token.',
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch {
    /* not base64 */
  }
  if (Buffer.byteLength(raw, 'utf8') === 32) return Buffer.from(raw, 'utf8');
  throw new Error(
    'APP_ENCRYPTION_KEY is not a valid 32-byte key (expected 64 hex chars, base64-encoded 32 bytes, or a raw 32-char string).',
  );
}

/**
 * Inverse of Clicksy's `CryptoService.encrypt`. Decrypts a base64
 * `iv | authTag | ciphertext` blob with the given 32-byte key. Throws if the
 * blob was tampered with (GCM auth-tag mismatch) or is malformed.
 */
export function decryptSecret(blob: string, key: Buffer): string {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('Encrypted secret is malformed (too short).');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
