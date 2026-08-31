import { randomBytes as secureRandomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

import { findAdminByUsername } from '../repositories/admins.js';
import {
  clearLoginFailures,
  isLoginBlocked,
  recordLoginFailure,
} from '../repositories/login-attempts.js';
import {
  cleanupExpiredSessions,
  deleteSession,
  findSessionByTokenHash,
  insertSession,
  updateSessionActivity,
  updateSessionCsrf,
  type SessionRecord,
} from '../repositories/sessions.js';
import { hashPassword as productionHashPassword, verifyPassword as productionVerifyPassword } from './passwords.js';
import {
  createRawToken,
  hashToken,
  isValidRawToken,
  tokenHashEquals,
  type RandomBytesSource,
} from './tokens.js';

const IDLE_MILLISECONDS = 12 * 60 * 60 * 1_000;
const ABSOLUTE_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const LOGIN_POLICY = Object.freeze({
  maximumFailures: 5,
  blockMilliseconds: 15 * 60 * 1_000,
});
const AUTHENTICATION_ERROR_CODE = 'AUTHENTICATION_FAILED';
const AUTHENTICATION_ERROR_MESSAGE = '用户名或密码错误';
const DUMMY_PASSWORD = 'dummy-password-for-session-authentication';

export class AuthenticationError extends Error {
  readonly code = AUTHENTICATION_ERROR_CODE;

  constructor() {
    super(AUTHENTICATION_ERROR_MESSAGE);
    this.name = 'AuthenticationError';
  }
}

export interface AuthenticatedSession {
  readonly adminId: string;
  readonly username: string;
  readonly tokenHash: string;
  readonly csrfHash: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export interface SessionService {
  login(input: {
    username: string;
    password: string;
    ip: string;
  }): Promise<{
    rawToken: string;
    csrfToken: string;
    idleExpiresAt: string;
    absoluteExpiresAt: string;
  }>;
  authenticate(rawToken: string): AuthenticatedSession | null;
  rotateCsrf(rawToken: string): string;
  verifyCsrf(session: AuthenticatedSession, rawCsrf: string): boolean;
  logout(rawToken: string): void;
  cleanupExpired(): number;
}

export interface CreateSessionServiceOptions {
  readonly db: Database.Database;
  readonly now?: () => Date;
  readonly randomBytes?: RandomBytesSource;
  readonly verifyPassword?: (passwordHash: string, password: string) => Promise<boolean>;
  readonly dummyHashFactory?: () => Promise<string>;
}

function addMilliseconds(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}

function minimumIso(left: string, right: string): string {
  return left < right ? left : right;
}

class SqliteSessionService implements SessionService {
  private readonly ipTails = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Database.Database,
    private readonly dummyPasswordHash: string,
    private readonly now: () => Date,
    private readonly randomBytes: RandomBytesSource,
    private readonly verifyPasswordValue: (
      passwordHash: string,
      password: string,
    ) => Promise<boolean>,
  ) {}

  async login(input: {
    username: string;
    password: string;
    ip: string;
  }): Promise<{
    rawToken: string;
    csrfToken: string;
    idleExpiresAt: string;
    absoluteExpiresAt: string;
  }> {
    return this.withIpLock(input.ip, async () => {
      const now = this.currentTime();
      const timestamp = now.toISOString();
      if (isLoginBlocked(this.db, { ip: input.ip, now: timestamp })) {
        throw new AuthenticationError();
      }

      const admin = findAdminByUsername(this.db, input.username);
      const passwordAccepted = await this.verifyPasswordValue(
        admin?.passwordHash ?? this.dummyPasswordHash,
        input.password,
      );
      if (admin === undefined || !passwordAccepted) {
        recordLoginFailure(this.db, { ip: input.ip, now: timestamp }, LOGIN_POLICY);
        throw new AuthenticationError();
      }

      return this.db
        .transaction(() => {
          const currentAdmin = findAdminByUsername(this.db, input.username);
          if (
            currentAdmin === undefined ||
            currentAdmin.id !== admin.id ||
            currentAdmin.passwordHash !== admin.passwordHash
          ) {
            throw new AuthenticationError();
          }

          clearLoginFailures(this.db, input.ip);
          const rawToken = createRawToken(this.randomBytes);
          const csrfToken = createRawToken(this.randomBytes);
          const idleExpiresAt = addMilliseconds(now, IDLE_MILLISECONDS).toISOString();
          const absoluteExpiresAt = addMilliseconds(now, ABSOLUTE_MILLISECONDS).toISOString();
          insertSession(this.db, {
            tokenHash: hashToken(rawToken),
            adminId: currentAdmin.id,
            csrfHash: hashToken(csrfToken),
            createdAt: timestamp,
            lastActivityAt: timestamp,
            absoluteExpiresAt,
          });
          return { rawToken, csrfToken, idleExpiresAt, absoluteExpiresAt };
        })
        .immediate();
    });
  }

  authenticate(rawToken: string): AuthenticatedSession | null {
    if (!isValidRawToken(rawToken)) {
      return null;
    }
    const tokenHash = hashToken(rawToken);
    const now = this.currentTime();
    const timestamp = now.toISOString();

    return this.db.transaction(() => {
      const session = findSessionByTokenHash(this.db, tokenHash);
      if (session === undefined) {
        return null;
      }
      if (this.isExpired(session, now)) {
        deleteSession(this.db, tokenHash);
        return null;
      }
      if (!updateSessionActivity(this.db, tokenHash, timestamp)) {
        return null;
      }
      return this.authenticatedSession(session, timestamp);
    })();
  }

  rotateCsrf(rawToken: string): string {
    if (!isValidRawToken(rawToken)) {
      throw new AuthenticationError();
    }
    const tokenHash = hashToken(rawToken);
    const now = this.currentTime();
    const timestamp = now.toISOString();

    return this.db.transaction(() => {
      const session = findSessionByTokenHash(this.db, tokenHash);
      if (session === undefined || this.isExpired(session, now)) {
        if (session !== undefined) {
          deleteSession(this.db, tokenHash);
        }
        throw new AuthenticationError();
      }
      const rawCsrf = createRawToken(this.randomBytes);
      if (!updateSessionCsrf(this.db, tokenHash, hashToken(rawCsrf), timestamp)) {
        throw new AuthenticationError();
      }
      return rawCsrf;
    })();
  }

  verifyCsrf(session: AuthenticatedSession, rawCsrf: string): boolean {
    if (
      !isValidRawToken(rawCsrf) ||
      !tokenHashEquals(session.tokenHash, session.tokenHash)
    ) {
      return false;
    }
    const now = this.currentTime();

    return this.db.transaction(() => {
      const currentSession = findSessionByTokenHash(this.db, session.tokenHash);
      if (currentSession === undefined) {
        return false;
      }
      if (this.isExpired(currentSession, now)) {
        deleteSession(this.db, session.tokenHash);
        return false;
      }
      return tokenHashEquals(currentSession.csrfHash, hashToken(rawCsrf));
    })();
  }

  logout(rawToken: string): void {
    if (isValidRawToken(rawToken)) {
      deleteSession(this.db, hashToken(rawToken));
    }
  }

  cleanupExpired(): number {
    const now = this.currentTime();
    return cleanupExpiredSessions(this.db, {
      now: now.toISOString(),
      idleCutoff: addMilliseconds(now, -IDLE_MILLISECONDS).toISOString(),
    });
  }

  private currentTime(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error('Invalid clock value');
    }
    return value;
  }

  private isExpired(session: SessionRecord, now: Date): boolean {
    const absoluteExpiresAt = new Date(session.absoluteExpiresAt).getTime();
    const idleExpiresAt = new Date(session.lastActivityAt).getTime() + IDLE_MILLISECONDS;
    return (
      !Number.isFinite(absoluteExpiresAt) ||
      !Number.isFinite(idleExpiresAt) ||
      now.getTime() >= absoluteExpiresAt ||
      now.getTime() >= idleExpiresAt
    );
  }

  private authenticatedSession(
    session: SessionRecord,
    lastActivityAt: string,
  ): AuthenticatedSession {
    const idleExpiresAt = minimumIso(
      addMilliseconds(new Date(lastActivityAt), IDLE_MILLISECONDS).toISOString(),
      session.absoluteExpiresAt,
    );
    return {
      adminId: session.adminId,
      username: session.username,
      tokenHash: session.tokenHash,
      csrfHash: session.csrfHash,
      createdAt: session.createdAt,
      lastActivityAt,
      idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }

  private async withIpLock<T>(ip: string, action: () => Promise<T>): Promise<T> {
    const previous = this.ipTails.get(ip) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.ipTails.set(ip, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.ipTails.get(ip) === tail) {
        this.ipTails.delete(ip);
      }
    }
  }
}

export async function createSessionService(
  options: CreateSessionServiceOptions,
): Promise<SessionService> {
  const dummyHashFactory =
    options.dummyHashFactory ?? (() => productionHashPassword(DUMMY_PASSWORD));
  const dummyPasswordHash = await dummyHashFactory();
  return new SqliteSessionService(
    options.db,
    dummyPasswordHash,
    options.now ?? (() => new Date()),
    options.randomBytes ?? secureRandomBytes,
    options.verifyPassword ?? productionVerifyPassword,
  );
}
