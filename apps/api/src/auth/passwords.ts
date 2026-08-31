import { argon2id, hash, verify } from 'argon2';

export const passwordPolicy = Object.freeze({
  minLength: 12,
  maxLength: 256,
});

const supportedParameters = new Set(['m=65536', 't=3', 'p=1']);
const maximumPhcLength = 128;

function isCanonicalBase64(value: string, decodedLength: number): boolean {
  if (!/^[A-Za-z0-9+/]+$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  return (
    decoded.length === decodedLength &&
    decoded.toString('base64').replace(/=+$/, '') === value
  );
}

function isSupportedPasswordHash(passwordHash: string): boolean {
  if (passwordHash.length > maximumPhcLength) {
    return false;
  }
  const parts = passwordHash.split('$');
  if (parts.length !== 6) {
    return false;
  }
  const [prefix, algorithm, version, parameters, salt, digest] = parts;
  if (prefix !== '' || algorithm !== 'argon2id' || version !== 'v=19') {
    return false;
  }
  if (parameters === undefined || salt === undefined || digest === undefined) {
    return false;
  }
  const parameterEntries = parameters.split(',');
  const parameterSet = new Set(parameterEntries);
  if (
    parameterEntries.length !== supportedParameters.size ||
    parameterSet.size !== supportedParameters.size ||
    [...supportedParameters].some((parameter) => !parameterSet.has(parameter))
  ) {
    return false;
  }
  return isCanonicalBase64(salt, 16) && isCanonicalBase64(digest, 32);
}

export function validatePassword(password: string): boolean {
  const length = Array.from(password).length;
  return length >= passwordPolicy.minLength && length <= passwordPolicy.maxLength;
}

export async function hashPassword(password: string): Promise<string> {
  if (!validatePassword(password)) {
    throw new Error('密码长度必须为 12 到 256 个字符');
  }

  return hash(password, {
    type: argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  if (!isSupportedPasswordHash(passwordHash)) {
    return false;
  }

  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
