import { argon2id, hash, verify } from 'argon2';

export const passwordPolicy = Object.freeze({
  minLength: 12,
  maxLength: 256,
});

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
  if (!passwordHash.startsWith('$argon2id$')) {
    return false;
  }

  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
