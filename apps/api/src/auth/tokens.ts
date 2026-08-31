import { createHash, randomBytes as secureRandomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;
const RAW_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;

export type RandomBytesSource = (size: number) => Buffer;

export function createRawToken(randomBytes: RandomBytesSource = secureRandomBytes): string {
  const bytes = randomBytes(TOKEN_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== TOKEN_BYTES) {
    throw new Error('Random source must return exactly 32 bytes');
  }
  return bytes.toString('base64url');
}

export function isValidRawToken(value: unknown): value is string {
  if (typeof value !== 'string' || !RAW_TOKEN.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === TOKEN_BYTES && decoded.toString('base64url') === value;
}

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function tokenHashEquals(expectedHash: string, candidateHash: string): boolean {
  if (!TOKEN_HASH.test(expectedHash) || !TOKEN_HASH.test(candidateHash)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(candidateHash, 'hex'));
}
