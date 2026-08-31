// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  hashPassword,
  passwordPolicy,
  validatePassword,
  verifyPassword,
} from './passwords.js';

describe('password policy', () => {
  it('exports the immutable 12 through 256 character limits', () => {
    expect(passwordPolicy).toEqual({ minLength: 12, maxLength: 256 });
    expect(Object.isFrozen(passwordPolicy)).toBe(true);
  });

  it.each([12, 256])('accepts a password containing %i characters', (length) => {
    expect(validatePassword('x'.repeat(length))).toBe(true);
  });

  it.each([11, 257])('rejects a password containing %i characters', (length) => {
    expect(validatePassword('x'.repeat(length))).toBe(false);
  });
});

describe('password hashing', () => {
  it('uses the fixed Argon2id parameters without embedding the plaintext', async () => {
    const password = 'correct horse battery staple';

    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(hash.split('$')[3]?.split(',').sort()).toEqual(['m=65536', 'p=1', 't=3']);
    expect(hash).not.toContain(password);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
  });

  it.each([
    'not-a-password-hash',
    '$argon2id$malformed',
    '$argon2i$v=19$m=65536,t=3,p=1$c2FsdA$ZGlnaWVzdA',
  ])('turns malformed or unsupported hash verification into false for %s', async (hash) => {
    await expect(verifyPassword('any password', hash)).resolves.toBe(false);
  });
});
