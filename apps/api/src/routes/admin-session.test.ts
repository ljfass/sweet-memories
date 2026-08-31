// @vitest-environment node

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AuthenticationError,
  type AuthenticatedSession,
  type SessionService,
} from '../auth/session-service.js';
import { buildApp } from '../app.js';

const publicOrigin = 'https://huangjianfen.cn';
const rawSessionToken = 'A'.repeat(43);
const initialCsrfToken = 'B'.repeat(43);
const rotatedCsrfToken = 'C'.repeat(43);
const cookieName = '__Host-sweet_memories_session';
const cookieHeader = `${cookieName}=${rawSessionToken}`;
const session: AuthenticatedSession = {
  adminId: 'admin-1',
  username: 'alice',
  tokenHash: 'a'.repeat(64),
  csrfHash: 'b'.repeat(64),
  createdAt: '2026-09-01T00:00:00.000Z',
  lastActivityAt: '2026-09-01T00:10:00.000Z',
  idleExpiresAt: '2026-09-01T12:10:00.000Z',
  absoluteExpiresAt: '2026-09-08T00:00:00.000Z',
};
const applications: FastifyInstance[] = [];

interface SessionSpies {
  readonly service: SessionService;
  readonly login: ReturnType<typeof vi.fn<SessionService['login']>>;
  readonly authenticate: ReturnType<typeof vi.fn<SessionService['authenticate']>>;
  readonly rotateCsrf: ReturnType<typeof vi.fn<SessionService['rotateCsrf']>>;
  readonly verifyCsrf: ReturnType<typeof vi.fn<SessionService['verifyCsrf']>>;
  readonly logout: ReturnType<typeof vi.fn<SessionService['logout']>>;
}

function createSessionSpies(): SessionSpies {
  const login = vi.fn<SessionService['login']>(async () => ({
    rawToken: rawSessionToken,
    csrfToken: initialCsrfToken,
    idleExpiresAt: '2026-09-01T12:00:00.000Z',
    absoluteExpiresAt: '2026-09-08T00:00:00.000Z',
  }));
  const authenticate = vi.fn<SessionService['authenticate']>(() => session);
  const rotateCsrf = vi.fn<SessionService['rotateCsrf']>(() => rotatedCsrfToken);
  const verifyCsrf = vi.fn<SessionService['verifyCsrf']>(
    (_session, candidate) => candidate === rotatedCsrfToken,
  );
  const logout = vi.fn<SessionService['logout']>(() => undefined);

  return {
    service: {
      login,
      authenticate,
      rotateCsrf,
      verifyCsrf,
      logout,
      cleanupExpired: () => 0,
    },
    login,
    authenticate,
    rotateCsrf,
    verifyCsrf,
    logout,
  };
}

function createApp(spies: SessionSpies): FastifyInstance {
  const app = buildApp({ publicOrigin, sessionService: spies.service, logger: false });
  applications.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (app) => app.close()));
});

describe('POST /api/admin/session', () => {
  it.each([undefined, 'https://www.huangjianfen.cn', `${publicOrigin}/`, 'HTTPS://huangjianfen.cn']) (
    'rejects a missing or non-exact Origin before checking credentials: %s',
    async (origin) => {
      const spies = createSessionSpies();
      const app = createApp(spies);

      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/session',
        headers: origin === undefined ? undefined : { origin },
        payload: { username: 'alice', password: 'correct-password' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: { code: 'ORIGIN_FORBIDDEN', message: '请求来源无效' },
      });
      expect(spies.login).not.toHaveBeenCalled();
    },
  );

  it('sets the exact host-only secure cookie without echoing the session token', async () => {
    const spies = createSessionSpies();
    const app = createApp(spies);

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/session',
      headers: { origin: publicOrigin },
      payload: { username: 'alice', password: 'correct-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(spies.login).toHaveBeenCalledWith({
      username: 'alice',
      password: 'correct-password',
      ip: '127.0.0.1',
    });
    expect(response.cookies).toHaveLength(1);
    expect(response.cookies[0]).toMatchObject({
      name: cookieName,
      value: rawSessionToken,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
    });
    expect(response.cookies[0]?.domain).toBeUndefined();
    expect(response.json()).toEqual({
      authenticated: true,
      csrfToken: initialCsrfToken,
      idleExpiresAt: '2026-09-01T12:00:00.000Z',
      absoluteExpiresAt: '2026-09-08T00:00:00.000Z',
    });
    expect(response.body).not.toContain(rawSessionToken);
    expect(response.body).not.toContain('correct-password');
  });

  it('maps all credential failures to one stable 401 response', async () => {
    const spies = createSessionSpies();
    spies.login.mockRejectedValue(new AuthenticationError());
    const app = createApp(spies);

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/session',
      headers: { origin: publicOrigin },
      payload: { username: 'missing', password: 'wrong-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'AUTHENTICATION_FAILED', message: '用户名或密码错误' },
    });
    expect(response.body).not.toContain('missing');
    expect(response.body).not.toContain('wrong-password');
  });

  it('rejects malformed login bodies without calling the password service', async () => {
    const spies = createSessionSpies();
    const app = createApp(spies);

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/session',
      headers: { origin: publicOrigin },
      payload: { username: 'alice', password: 123 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'INVALID_REQUEST', message: '请求内容无效' },
    });
    expect(spies.login).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/session', () => {
  it('parses the session cookie, refreshes activity, and rotates the CSRF secret', async () => {
    const spies = createSessionSpies();
    const app = createApp(spies);

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/session',
      headers: { cookie: cookieHeader },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(spies.authenticate).toHaveBeenCalledWith(rawSessionToken);
    expect(spies.rotateCsrf).toHaveBeenCalledWith(rawSessionToken);
    expect(response.json()).toEqual({
      authenticated: true,
      username: 'alice',
      csrfToken: rotatedCsrfToken,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    });
    expect(response.body).not.toContain(rawSessionToken);
  });

  it('does not expose an implicit HEAD route that rotates the CSRF secret', async () => {
    const spies = createSessionSpies();
    const app = createApp(spies);

    const response = await app.inject({
      method: 'HEAD',
      url: '/api/admin/session',
      headers: { cookie: cookieHeader },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: '请求的资源不存在' },
    });
    expect(spies.authenticate).not.toHaveBeenCalled();
    expect(spies.rotateCsrf).not.toHaveBeenCalled();
  });

  it.each([undefined, null])('returns the same 401 for a missing or invalid session', async (value) => {
    const spies = createSessionSpies();
    spies.authenticate.mockReturnValue(value === null ? null : session);
    const app = createApp(spies);

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/session',
      headers: value === undefined ? undefined : { cookie: cookieHeader },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'AUTHENTICATION_REQUIRED', message: '请重新登录' },
    });
  });

  it('returns the session-expired 401 when CSRF rotation loses a valid session race', async () => {
    const spies = createSessionSpies();
    spies.rotateCsrf.mockImplementation(() => {
      throw new AuthenticationError();
    });
    const app = createApp(spies);

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/session',
      headers: { cookie: cookieHeader },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'AUTHENTICATION_REQUIRED', message: '请重新登录' },
    });
  });
});

describe('DELETE /api/admin/session', () => {
  it('requires exact Origin before reading the ambient session cookie', async () => {
    const spies = createSessionSpies();
    const app = createApp(spies);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/admin/session',
      headers: { cookie: cookieHeader, 'x-csrf-token': rotatedCsrfToken },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: 'ORIGIN_FORBIDDEN', message: '请求来源无效' },
    });
    expect(spies.authenticate).not.toHaveBeenCalled();
    expect(spies.logout).not.toHaveBeenCalled();
  });

  it('requires an authenticated cookie before checking CSRF', async () => {
    const spies = createSessionSpies();
    spies.authenticate.mockReturnValue(null);
    const app = createApp(spies);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/admin/session',
      headers: { origin: publicOrigin, cookie: cookieHeader, 'x-csrf-token': rotatedCsrfToken },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'AUTHENTICATION_REQUIRED', message: '请重新登录' },
    });
    expect(spies.verifyCsrf).not.toHaveBeenCalled();
    expect(spies.logout).not.toHaveBeenCalled();
  });

  it.each([undefined, 'wrong-csrf-token'])(
    'rejects a missing or invalid CSRF token without logging out: %s',
    async (csrfToken) => {
      const spies = createSessionSpies();
      spies.verifyCsrf.mockReturnValue(false);
      const app = createApp(spies);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/admin/session',
        headers: {
          origin: publicOrigin,
          cookie: cookieHeader,
          ...(csrfToken === undefined ? {} : { 'x-csrf-token': csrfToken }),
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: { code: 'CSRF_FORBIDDEN', message: 'CSRF 校验失败' },
      });
      if (csrfToken === undefined) {
        expect(spies.verifyCsrf).not.toHaveBeenCalled();
      } else {
        expect(spies.verifyCsrf).toHaveBeenCalledWith(session, csrfToken);
      }
      expect(spies.logout).not.toHaveBeenCalled();
    },
  );

  it('rejects multiple CSRF header values instead of choosing one', async () => {
    const spies = createSessionSpies();
    const app = createApp(spies);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/admin/session',
      headers: {
        origin: publicOrigin,
        cookie: cookieHeader,
        'x-csrf-token': [rotatedCsrfToken, rotatedCsrfToken],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: 'CSRF_FORBIDDEN', message: 'CSRF 校验失败' },
    });
    expect(spies.verifyCsrf).toHaveBeenCalledTimes(1);
    expect(spies.logout).not.toHaveBeenCalled();
  });

  it('logs out the server session and expires the same host-only cookie', async () => {
    const spies = createSessionSpies();
    const app = createApp(spies);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/admin/session',
      headers: {
        origin: publicOrigin,
        cookie: cookieHeader,
        'x-csrf-token': rotatedCsrfToken,
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toBe('');
    expect(spies.authenticate).toHaveBeenCalledWith(rawSessionToken);
    expect(spies.verifyCsrf).toHaveBeenCalledWith(session, rotatedCsrfToken);
    expect(spies.logout).toHaveBeenCalledWith(rawSessionToken);
    expect(response.cookies).toHaveLength(1);
    expect(response.cookies[0]).toMatchObject({
      name: cookieName,
      value: '',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
    });
    expect(response.cookies[0]?.domain).toBeUndefined();
  });
});
