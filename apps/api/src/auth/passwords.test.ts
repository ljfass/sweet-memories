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

  it.each([
    [6, false],
    [11, false],
    [12, true],
    [256, true],
    [257, false],
  ])('counts %i emoji as Unicode code points', (length, accepted) => {
    expect(validatePassword('😀'.repeat(length))).toBe(accepted);
  });
});

describe('password hashing', () => {
  it('uses the fixed Argon2id parameters without embedding the plaintext', async () => {
    const password = 'correct horse battery staple';

    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(hash.split('$')[3]?.split(',').sort()).toEqual(['m=65536', 'p=1', 't=3']);
    expect(hash).not.toContain(password);
    await expect(verifyPassword(hash, password)).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('accepts the password hash first and plaintext password second', async () => {
    const password = 'a contract test password';
    const hash = await hashPassword(password);

    await expect(verifyPassword(hash, password)).resolves.toBe(true);
  });

  it.each([
    'not-a-password-hash',
    '$argon2id$malformed',
    '$argon2i$v=19$m=65536,t=3,p=1$c2FsdA$ZGlnaWVzdA',
  ])('turns malformed or unsupported hash verification into false for %s', async (hash) => {
    await expect(verifyPassword(hash, 'any password')).resolves.toBe(false);
  });
});
