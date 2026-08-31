// @vitest-environment node

import { argon2id, hash as argonHash, verify as argonVerify } from 'argon2';
import { describe, expect, it, vi } from 'vitest';

vi.mock('argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('argon2')>();
  return { ...actual, verify: vi.fn(actual.verify) };
});

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

  it('rejects a real Argon2id hash with weaker parameters', async () => {
    const password = 'a weak parameter password';
    const verifyMock = vi.mocked(argonVerify);
    const callsBefore = verifyMock.mock.calls.length;
    const weakHash = await argonHash(password, {
      type: argon2id,
      memoryCost: 4_096,
      timeCost: 1,
      parallelism: 1,
    });

    await expect(verifyPassword(weakHash, password)).resolves.toBe(false);
    expect(verifyMock).toHaveBeenCalledTimes(callsBefore);
  });

  it('accepts the supported PHC parameters in any order', async () => {
    const password = 'a reordered parameter password';
    const hash = await hashPassword(password);
    const reordered = hash.replace('m=65536,p=1,t=3', 't=3,m=65536,p=1');

    await expect(verifyPassword(reordered, password)).resolves.toBe(true);
  });

  it.each([
    '$argon2id$v=18$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '$argon2id$v=19$m=65536,t=3$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '$argon2id$v=19$m=65536,t=3,p=1,m=65536$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '$argon2id$v=19$m=65536,t=3,p=1,x=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAA!$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    `$argon2id$v=19$m=65536,t=3,p=1$${'A'.repeat(220)}$${'A'.repeat(430)}`,
  ])('rejects an unsupported or malformed PHC string before verification', async (hash) => {
    const verifyMock = vi.mocked(argonVerify);
    const callsBefore = verifyMock.mock.calls.length;

    await expect(verifyPassword(hash, 'any password')).resolves.toBe(false);
    expect(verifyMock).toHaveBeenCalledTimes(callsBefore);
  });

  it('short-circuits an oversized memory parameter before Argon2 verification', async () => {
    const verifyMock = vi.mocked(argonVerify);
    const callsBefore = verifyMock.mock.calls.length;
    const oversized =
      '$argon2id$v=19$m=4294967295,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    await expect(verifyPassword(oversized, 'any password')).resolves.toBe(false);
    expect(verifyMock).toHaveBeenCalledTimes(callsBefore);
  });

  it.each([
    'not-a-password-hash',
    '$argon2id$malformed',
    '$argon2i$v=19$m=65536,t=3,p=1$c2FsdA$ZGlnaWVzdA',
  ])('turns malformed or unsupported hash verification into false for %s', async (hash) => {
    await expect(verifyPassword(hash, 'any password')).resolves.toBe(false);
  });
});
