// @vitest-environment node

import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../migrations.js';
import { resetAdminPassword } from '../repositories/admins.js';
import { hashPassword, verifyPassword } from './passwords.js';
import {
  AuthenticationError,
  createSessionService,
  type AuthenticatedSession,
  type SessionService,
} from './session-service.js';
import { hashToken, tokenHashEquals } from './tokens.js';

const migrationsRoot = fileURLToPath(new URL('../../migrations', import.meta.url));
const authenticationFailure = {
  code: 'AUTHENTICATION_FAILED',
  message: '用户名或密码错误',
};

interface TestContext {
  readonly db: Database.Database;
  readonly service: SessionService;
  readonly verify: ReturnType<typeof vi.fn>;
  readonly dummyHashFactory: ReturnType<typeof vi.fn>;
  setNow(iso: string): void;
}

const databases: Database.Database[] = [];

function createDeferredVerifier(): {
  readonly started: Promise<void>;
  readonly verify: (passwordHash: string, password: string) => Promise<boolean>;
  resolve(accepted: boolean): void;
} {
  let markStarted = (): void => undefined;
  let resolveVerification!: (accepted: boolean) => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const result = new Promise<boolean>((resolve) => {
    resolveVerification = resolve;
  });
  return {
    started,
    async verify() {
      markStarted();
      return result;
    },
    resolve(accepted) {
      resolveVerification(accepted);
    },
  };
}

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsRoot);
  db.prepare(
    `INSERT INTO admins(id, username, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    'admin-1',
    'alice',
    'stored-password-hash',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );
  return db;
}

async function createContext(
  options: {
    readonly initialNow?: string;
    readonly verify?: (passwordHash: string, password: string) => Promise<boolean>;
    readonly randomBytes?: (size: number) => Buffer;
    readonly dummyHashFactory?: () => Promise<string>;
  } = {},
): Promise<TestContext> {
  const db = createDatabase();
  let currentNow = options.initialNow ?? '2026-06-01T00:00:00.000Z';
  let randomCall = 0;
  const verify = vi.fn(
    options.verify ??
      (async (passwordHash: string, password: string) =>
        passwordHash === 'stored-password-hash' && password === 'correct-password'),
  );
  const dummyHashFactory = vi.fn(
    options.dummyHashFactory ?? (async () => 'dummy-password-hash'),
  );
  const service = await createSessionService({
    db,
    now: () => new Date(currentNow),
    verifyPassword: verify,
    dummyHashFactory,
    randomBytes:
      options.randomBytes ??
      ((size) => {
        randomCall += 1;
        return Buffer.alloc(size, randomCall);
      }),
  });
  return {
    db,
    service,
    verify,
    dummyHashFactory,
    setNow(iso) {
      currentNow = iso;
    },
  };
}

async function expectAuthenticationFailure(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject(authenticationFailure);
  await expect(promise).rejects.toBeInstanceOf(AuthenticationError);
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
});

describe('token helpers', () => {
  it('uses one canonical SHA-256 representation and compares valid hashes', () => {
    const hash = hashToken('token-value');

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashToken('token-value'));
    expect(tokenHashEquals(hash, hashToken('token-value'))).toBe(true);
    expect(tokenHashEquals(hash, hashToken('different-token'))).toBe(false);
  });

  it.each(['', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(1_000_000)])(
    'safely rejects malformed attacker-controlled hashes',
    (candidate) => {
      expect(tokenHashEquals(hashToken('known'), candidate)).toBe(false);
    },
  );
});

describe('login sessions', () => {
  it('creates distinct 32-byte base64url session and CSRF secrets while storing only hashes', async () => {
    const { db, service } = await createContext();

    const first = await service.login({
      username: 'alice',
      password: 'correct-password',
      ip: '192.0.2.1',
    });
    const second = await service.login({
      username: 'alice',
      password: 'correct-password',
      ip: '192.0.2.1',
    });

    for (const secret of [first.rawToken, first.csrfToken, second.rawToken, second.csrfToken]) {
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    }
    expect(new Set([first.rawToken, first.csrfToken, second.rawToken, second.csrfToken]).size).toBe(
      4,
    );
    expect(first.idleExpiresAt).toBe('2026-06-01T12:00:00.000Z');
    expect(first.absoluteExpiresAt).toBe('2026-06-08T00:00:00.000Z');

    const rows = db.prepare('SELECT * FROM sessions ORDER BY token_hash').all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(2);
    const serializedRows = JSON.stringify(rows);
    for (const secret of [first.rawToken, first.csrfToken, second.rawToken, second.csrfToken]) {
      expect(serializedRows).not.toContain(secret);
    }
    expect(rows).toContainEqual({
      token_hash: hashToken(first.rawToken),
      admin_id: 'admin-1',
      csrf_hash: hashToken(first.csrfToken),
      created_at: '2026-06-01T00:00:00.000Z',
      last_activity_at: '2026-06-01T00:00:00.000Z',
      absolute_expires_at: '2026-06-08T00:00:00.000Z',
    });
  });

  it('generates the dummy hash once at service creation and never accepts it', async () => {
    const { service, verify, dummyHashFactory } = await createContext({
      verify: async (passwordHash) => passwordHash === 'dummy-password-hash',
    });

    await expectAuthenticationFailure(
      service.login({ username: 'missing', password: 'anything', ip: '192.0.2.2' }),
    );
    await expectAuthenticationFailure(
      service.login({ username: 'another-missing', password: 'anything', ip: '192.0.2.3' }),
    );

    expect(dummyHashFactory).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenNthCalledWith(1, 'dummy-password-hash', 'anything');
    expect(verify).toHaveBeenNthCalledWith(2, 'dummy-password-hash', 'anything');
  });

  it('makes unknown-user and wrong-password failures stable and indistinguishable', async () => {
    const { service, verify } = await createContext();

    const unknown = service.login({
      username: 'missing',
      password: 'wrong-password',
      ip: '192.0.2.4',
    });
    await expectAuthenticationFailure(unknown);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenLastCalledWith('dummy-password-hash', 'wrong-password');

    const wrong = service.login({
      username: 'alice',
      password: 'wrong-password',
      ip: '192.0.2.5',
    });
    await expectAuthenticationFailure(wrong);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenLastCalledWith('stored-password-hash', 'wrong-password');
  });

  it('rejects a verified password when its administrator hash changed during verification', async () => {
    const deferred = createDeferredVerifier();
    const { db, service, verify } = await createContext({ verify: deferred.verify });
    const login = service.login({
      username: 'alice',
      password: 'old-password',
      ip: '192.0.2.40',
    });
    await deferred.started;
    expect(verify).toHaveBeenCalledWith('stored-password-hash', 'old-password');

    resetAdminPassword(db, {
      username: 'alice',
      passwordHash: 'replacement-password-hash',
      timestamp: '2026-06-01T00:00:01.000Z',
    });
    deferred.resolve(true);

    await expectAuthenticationFailure(login);
    expect(db.prepare('SELECT 1 FROM sessions').get()).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM login_attempts').get()).toBeUndefined();
  });

  it('completes a deferred successful login when the administrator hash is unchanged', async () => {
    const deferred = createDeferredVerifier();
    const { db, service } = await createContext({ verify: deferred.verify });
    const login = service.login({
      username: 'alice',
      password: 'correct-password',
      ip: '192.0.2.41',
    });
    await deferred.started;

    deferred.resolve(true);

    await expect(login).resolves.toMatchObject({
      idleExpiresAt: '2026-06-01T12:00:00.000Z',
      absoluteExpiresAt: '2026-06-08T00:00:00.000Z',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
  });

  it('is compatible with the production Argon2id password helpers', async () => {
    const db = createDatabase();
    const realHash = await hashPassword('production-compatible-password');
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(realHash, 'admin-1');
    let randomCall = 0;
    const service = await createSessionService({
      db,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      verifyPassword,
      dummyHashFactory: async () => realHash,
      randomBytes: (size) => Buffer.alloc(size, ++randomCall),
    });

    await expect(
      service.login({
        username: 'alice',
        password: 'production-compatible-password',
        ip: '192.0.2.6',
      }),
    ).resolves.toMatchObject({
      idleExpiresAt: '2026-06-01T12:00:00.000Z',
      absoluteExpiresAt: '2026-06-08T00:00:00.000Z',
    });
  });
});

describe('login throttling', () => {
  it('returns the same failure through the fifth failure and blocks that IP for 15 minutes', async () => {
    const { db, service, verify } = await createContext();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expectAuthenticationFailure(
        service.login({ username: 'alice', password: 'wrong-password', ip: '198.51.100.1' }),
      );
    }

    expect(verify).toHaveBeenCalledTimes(5);
    expect(
      db.prepare('SELECT failure_count, blocked_until, updated_at FROM login_attempts WHERE ip = ?').get(
        '198.51.100.1',
      ),
    ).toEqual({
      failure_count: 5,
      blocked_until: '2026-06-01T00:15:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    });

    await expectAuthenticationFailure(
      service.login({ username: 'alice', password: 'correct-password', ip: '198.51.100.1' }),
    );
    expect(verify).toHaveBeenCalledTimes(5);
  });

  it('keeps the block at the last instant and permits verification at the exact expiry', async () => {
    const { service, setNow, verify } = await createContext();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expectAuthenticationFailure(
        service.login({ username: 'alice', password: 'wrong-password', ip: '198.51.100.2' }),
      );
    }

    setNow('2026-06-01T00:14:59.999Z');
    await expectAuthenticationFailure(
      service.login({ username: 'alice', password: 'correct-password', ip: '198.51.100.2' }),
    );
    expect(verify).toHaveBeenCalledTimes(5);

    setNow('2026-06-01T00:15:00.000Z');
    await expect(
      service.login({ username: 'alice', password: 'correct-password', ip: '198.51.100.2' }),
    ).resolves.toBeDefined();
    expect(verify).toHaveBeenCalledTimes(6);
  });

  it('tracks IP addresses independently and clears one IP after a successful login', async () => {
    const { db, service } = await createContext();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expectAuthenticationFailure(
        service.login({ username: 'alice', password: 'wrong-password', ip: '203.0.113.1' }),
      );
    }

    await expect(
      service.login({ username: 'alice', password: 'correct-password', ip: '203.0.113.2' }),
    ).resolves.toBeDefined();
    expect(
      db.prepare('SELECT failure_count FROM login_attempts WHERE ip = ?').get('203.0.113.1'),
    ).toEqual({ failure_count: 5 });
    expect(db.prepare('SELECT 1 FROM login_attempts WHERE ip = ?').get('203.0.113.2')).toBeUndefined();

    db.prepare(
      `INSERT INTO login_attempts(ip, failure_count, blocked_until, updated_at)
       VALUES (?, ?, NULL, ?)`,
    ).run('203.0.113.3', 2, '2026-06-01T00:00:00.000Z');
    await service.login({ username: 'alice', password: 'correct-password', ip: '203.0.113.3' });
    expect(db.prepare('SELECT 1 FROM login_attempts WHERE ip = ?').get('203.0.113.3')).toBeUndefined();
  });

  it('serializes concurrent failures so calls queued after the fifth do not verify', async () => {
    const { service, verify } = await createContext({
      verify: async () => {
        await Promise.resolve();
        return false;
      },
    });

    await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        service.login({ username: 'alice', password: 'wrong-password', ip: '203.0.113.4' }),
      ),
    );

    expect(verify).toHaveBeenCalledTimes(5);
  });
});

describe('session lifecycle', () => {
  async function login(context: TestContext) {
    return context.service.login({
      username: 'alice',
      password: 'correct-password',
      ip: '192.0.2.20',
    });
  }

  it('rejects malformed tokens without querying a secret and returns null for unknown tokens', async () => {
    const { service } = await createContext();

    expect(service.authenticate(null as unknown as string)).toBeNull();
    expect(service.authenticate('')).toBeNull();
    expect(service.authenticate('x'.repeat(1_000_000))).toBeNull();
    expect(service.authenticate(Buffer.alloc(32, 99).toString('base64url'))).toBeNull();
  });

  it('keeps a session valid one millisecond before the 12-hour idle boundary', async () => {
    const context = await createContext();
    const created = await login(context);
    context.setNow('2026-06-01T11:59:59.999Z');

    const session = context.service.authenticate(created.rawToken);

    expect(session).toEqual({
      adminId: 'admin-1',
      username: 'alice',
      tokenHash: hashToken(created.rawToken),
      csrfHash: hashToken(created.csrfToken),
      createdAt: '2026-06-01T00:00:00.000Z',
      lastActivityAt: '2026-06-01T11:59:59.999Z',
      idleExpiresAt: '2026-06-01T23:59:59.999Z',
      absoluteExpiresAt: '2026-06-08T00:00:00.000Z',
    } satisfies AuthenticatedSession);
  });

  it('deletes a session at the exact 12-hour idle boundary', async () => {
    const context = await createContext();
    const created = await login(context);
    context.setNow('2026-06-01T12:00:00.000Z');

    expect(context.service.authenticate(created.rawToken)).toBeNull();
    expect(context.db.prepare('SELECT 1 FROM sessions').get()).toBeUndefined();
  });

  it('treats the exact seven-day absolute boundary as expired and deletes the session', async () => {
    const context = await createContext();
    const created = await login(context);
    context.db
      .prepare('UPDATE sessions SET last_activity_at = ? WHERE token_hash = ?')
      .run('2026-06-07T23:00:00.000Z', hashToken(created.rawToken));
    context.setNow('2026-06-08T00:00:00.000Z');

    expect(context.service.authenticate(created.rawToken)).toBeNull();
    expect(context.db.prepare('SELECT 1 FROM sessions').get()).toBeUndefined();
  });

  it('never extends idle expiry beyond the absolute expiry', async () => {
    const context = await createContext();
    const created = await login(context);
    context.db
      .prepare('UPDATE sessions SET last_activity_at = ? WHERE token_hash = ?')
      .run('2026-06-07T10:00:00.000Z', hashToken(created.rawToken));
    context.setNow('2026-06-07T13:00:00.000Z');

    expect(context.service.authenticate(created.rawToken)).toMatchObject({
      lastActivityAt: '2026-06-07T13:00:00.000Z',
      idleExpiresAt: '2026-06-08T00:00:00.000Z',
      absoluteExpiresAt: '2026-06-08T00:00:00.000Z',
    });
  });

  it('rotates CSRF only for a valid session and invalidates the old secret immediately', async () => {
    const context = await createContext();
    const created = await login(context);
    const originalSession = context.service.authenticate(created.rawToken) as AuthenticatedSession;

    expect(context.service.verifyCsrf(originalSession, created.csrfToken)).toBe(true);
    expect(context.service.verifyCsrf(originalSession, '')).toBe(false);
    expect(context.service.verifyCsrf(originalSession, 'x'.repeat(1_000_000))).toBe(false);

    const newCsrf = context.service.rotateCsrf(created.rawToken);
    const rotatedSession = context.service.authenticate(created.rawToken) as AuthenticatedSession;
    expect(newCsrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newCsrf).not.toBe(created.csrfToken);
    expect(context.service.verifyCsrf(originalSession, created.csrfToken)).toBe(false);
    expect(context.service.verifyCsrf(originalSession, newCsrf)).toBe(true);
    expect(context.service.verifyCsrf(rotatedSession, newCsrf)).toBe(true);
    expect(JSON.stringify(context.db.prepare('SELECT * FROM sessions').get())).not.toContain(newCsrf);
  });

  it('rejects CSRF against a logged-out session snapshot', async () => {
    const context = await createContext();
    const created = await login(context);
    const session = context.service.authenticate(created.rawToken) as AuthenticatedSession;

    context.service.logout(created.rawToken);

    expect(context.service.verifyCsrf(session, created.csrfToken)).toBe(false);
  });

  it('rejects CSRF against an expired session snapshot', async () => {
    const context = await createContext();
    const created = await login(context);
    const session = context.service.authenticate(created.rawToken) as AuthenticatedSession;
    context.setNow('2026-06-01T12:00:00.000Z');

    expect(context.service.verifyCsrf(session, created.csrfToken)).toBe(false);
  });

  it('rejects CSRF against a snapshot with an unknown token hash', async () => {
    const context = await createContext();
    const created = await login(context);
    const session = context.service.authenticate(created.rawToken) as AuthenticatedSession;
    const unknownSession = {
      ...session,
      tokenHash: hashToken(Buffer.alloc(32, 120).toString('base64url')),
    };

    expect(context.service.verifyCsrf(unknownSession, created.csrfToken)).toBe(false);
  });

  it('rejects CSRF rotation for unknown and expired sessions with one generic auth error', async () => {
    const context = await createContext();
    const created = await login(context);
    context.setNow('2026-06-01T12:00:00.001Z');

    expect(() => context.service.rotateCsrf(created.rawToken)).toThrowError(
      expect.objectContaining(authenticationFailure),
    );
    expect(() =>
      context.service.rotateCsrf(Buffer.alloc(32, 100).toString('base64url')),
    ).toThrowError(expect.objectContaining(authenticationFailure));
  });

  it('logs out idempotently and cleans both kinds of expired sessions', async () => {
    const context = await createContext();
    const first = await login(context);
    const second = await login(context);
    const third = await login(context);

    context.service.logout(first.rawToken);
    context.service.logout(first.rawToken);
    expect(context.service.authenticate(first.rawToken)).toBeNull();

    context.db
      .prepare('UPDATE sessions SET absolute_expires_at = ? WHERE token_hash = ?')
      .run('2026-06-01T00:00:00.000Z', hashToken(second.rawToken));
    context.db
      .prepare('UPDATE sessions SET last_activity_at = ? WHERE token_hash = ?')
      .run('2026-05-31T12:00:00.000Z', hashToken(third.rawToken));

    expect(context.service.cleanupExpired()).toBe(2);
    expect(context.db.prepare('SELECT 1 FROM sessions').get()).toBeUndefined();
  });

  it('rejects an invalid injected clock value before writing data', async () => {
    const db = createDatabase();
    const service = await createSessionService({
      db,
      now: () => new Date(Number.NaN),
      verifyPassword: async () => true,
      dummyHashFactory: async () => 'dummy-password-hash',
      randomBytes: (size) => Buffer.alloc(size),
    });

    await expect(
      service.login({ username: 'alice', password: 'correct-password', ip: '192.0.2.30' }),
    ).rejects.toThrow('Invalid clock value');
    expect(db.prepare('SELECT 1 FROM sessions').get()).toBeUndefined();
  });
});
