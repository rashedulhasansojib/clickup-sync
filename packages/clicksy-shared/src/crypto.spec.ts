import { createCipheriv, randomBytes } from 'node:crypto';
import { decryptSecret, parseEncryptionKey } from './crypto';

/**
 * Re-implements Clicksy's `CryptoService.encrypt` INLINE (same node:crypto
 * scheme) so the round-trip proves byte-parity: anything Clicksy encrypts,
 * Meetsy's `decryptSecret` must recover. If Clicksy's format ever drifts, this
 * test must drift with it.
 */
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
function clicksyEncrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

describe('parseEncryptionKey', () => {
  it('accepts 64 hex chars', () => {
    const raw = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
    expect(parseEncryptionKey(raw)).toEqual(Buffer.from(raw, 'hex'));
  });

  it('accepts base64 that decodes to 32 bytes', () => {
    const buf = randomBytes(32);
    expect(parseEncryptionKey(buf.toString('base64'))).toEqual(buf);
  });

  it('accepts a raw 32-char utf-8 string', () => {
    const raw = 'abcdefghijklmnopqrstuvwxyz012345'; // 32 chars
    expect(parseEncryptionKey(raw)).toEqual(Buffer.from(raw, 'utf8'));
  });

  it('throws on missing key', () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(/APP_ENCRYPTION_KEY/);
  });

  it('throws on an invalid-length key', () => {
    expect(() => parseEncryptionKey('too-short')).toThrow(/valid 32-byte key/);
  });
});

describe('decryptSecret (byte-parity with Clicksy encrypt)', () => {
  const key = parseEncryptionKey(
    'a'.repeat(64), // 64 hex
  );

  it('round-trips a secret encrypted with Clicksy’s scheme', () => {
    const plain = 'pk_12345678_SECRETCLICKUPTOKEN';
    const blob = clicksyEncrypt(plain, key);
    expect(decryptSecret(blob, key)).toBe(plain);
  });

  it('round-trips unicode/long payloads', () => {
    const plain = 'sécret-✓-' + 'x'.repeat(500);
    expect(decryptSecret(clicksyEncrypt(plain, key), key)).toBe(plain);
  });

  it('throws on a tampered blob (auth-tag mismatch)', () => {
    const blob = clicksyEncrypt('hello', key);
    const buf = Buffer.from(blob, 'base64');
    buf[buf.length - 1] ^= 0x01; // flip a ciphertext bit
    expect(() => decryptSecret(buf.toString('base64'), key)).toThrow();
  });

  it('throws on a malformed (too-short) blob', () => {
    expect(() => decryptSecret('AAAA', key)).toThrow(/malformed/);
  });
});
