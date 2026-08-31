// @vitest-environment node

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionService } from './auth/session-service.js';
import { buildApp } from './app.js';
import type { PhotoService } from './services/photo-service.js';

const publicOrigin = 'https://huangjianfen.cn';
const rawSessionToken = 'A'.repeat(43);
const rawCsrfToken = 'B'.repeat(43);
const applications: FastifyInstance[] = [];

function createSessionService(overrides: Partial<SessionService> = {}): SessionService {
  return {
    login: async () => ({
      rawToken: rawSessionToken,
      csrfToken: rawCsrfToken,
      idleExpiresAt: '2026-09-01T12:00:00.000Z',
      absoluteExpiresAt: '2026-09-08T00:00:00.000Z',
    }),
    authenticate: () => null,
    rotateCsrf: () => rawCsrfToken,
    verifyCsrf: () => false,
    logout: () => undefined,
    cleanupExpired: () => 0,
    ...overrides,
  };
}

function createPhotoService(overrides: Partial<PhotoService> = {}): PhotoService {
  return {
    listPublicPhotos: () => [],
    listAdminPhotos: () => [],
    updatePhoto: () => {
      throw new Error('Unexpected photo update');
    },
    ...overrides,
  };
}

function track(app: FastifyInstance): FastifyInstance {
  applications.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (app) => app.close()));
});

describe('buildApp security boundary', () => {
  it('requires and registers the production photo catalog dependency', async () => {
    const listPublicPhotos = vi.fn<PhotoService['listPublicPhotos']>(() => []);
    const app = track(buildApp({
      publicOrigin,
      sessionService: createSessionService(),
      photoService: createPhotoService({ listPublicPhotos }),
      logger: false,
    }));

    const response = await app.inject({ method: 'GET', url: '/api/photos' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(listPublicPhotos).toHaveBeenCalledOnce();
  });

  it('returns only the minimal health status and registers multipart parsing', async () => {
    const app = track(buildApp({
      publicOrigin,
      sessionService: createSessionService(),
      photoService: createPhotoService(),
      logger: false,
    }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.body).not.toMatch(/version|dependency|environment|\/var\//i);
    expect(app.hasContentTypeParser('multipart/form-data')).toBe(true);
  });

  it('trusts forwarded client addresses only through the loopback proxy configuration', async () => {
    const login = vi.fn<SessionService['login']>(async () => ({
      rawToken: rawSessionToken,
      csrfToken: rawCsrfToken,
      idleExpiresAt: '2026-09-01T12:00:00.000Z',
      absoluteExpiresAt: '2026-09-08T00:00:00.000Z',
    }));
    const app = track(buildApp({
      publicOrigin,
      sessionService: createSessionService({ login }),
      photoService: createPhotoService(),
      logger: false,
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/session',
      headers: {
        origin: publicOrigin,
        'x-forwarded-for': '203.0.113.7',
      },
      payload: { username: 'admin', password: 'a-secure-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(login).toHaveBeenCalledWith({
      username: 'admin',
      password: 'a-secure-password',
      ip: '203.0.113.7',
    });
  });

  it('uses the stable API error envelope for malformed JSON and unknown routes', async () => {
    const app = track(buildApp({
      publicOrigin,
      sessionService: createSessionService(),
      photoService: createPhotoService(),
      logger: false,
    }));

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/admin/session',
      headers: {
        origin: publicOrigin,
        'content-type': 'application/json',
      },
      payload: '{',
    });
    const missing = await app.inject({ method: 'GET', url: '/missing' });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      error: { code: 'INVALID_REQUEST', message: '请求内容无效' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: 'NOT_FOUND', message: '请求的资源不存在' },
    });
  });

  it('preserves a sanitized 413 for an oversized JSON request without logging it as internal', async () => {
    const sensitiveValue = 'oversized-private-password';
    const lines: string[] = [];
    const app = track(buildApp({
      publicOrigin,
      sessionService: createSessionService(),
      photoService: createPhotoService(),
      logger: {
        level: 'error',
        stream: { write: (line) => lines.push(line) },
      },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/session',
      headers: { origin: publicOrigin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        username: 'admin',
        password: `${sensitiveValue}${'x'.repeat(1_100_000)}`,
      }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: '请求内容过大' },
    });
    const externallyVisible = `${response.body}\n${lines.join('\n')}`;
    expect(externallyVisible).not.toContain(sensitiveValue);
    expect(externallyVisible).not.toMatch(
      /INTERNAL_ERROR|FST_ERR|node_modules|\/var\/|stack|fastify/i,
    );
    expect(lines).toHaveLength(0);
  });

  it('preserves a sanitized 415 for unsupported media without logging it as internal', async () => {
    const sensitiveValue = 'private-unsupported-payload';
    const lines: string[] = [];
    const app = track(buildApp({
      publicOrigin,
      sessionService: createSessionService(),
      photoService: createPhotoService(),
      logger: {
        level: 'error',
        stream: { write: (line) => lines.push(line) },
      },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/session',
      headers: {
        origin: publicOrigin,
        'content-type': 'application/x-private-upload',
      },
      payload: sensitiveValue,
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '不支持的内容类型' },
    });
    const externallyVisible = `${response.body}\n${lines.join('\n')}`;
    expect(externallyVisible).not.toContain(sensitiveValue);
    expect(externallyVisible).not.toMatch(
      /INTERNAL_ERROR|FST_ERR|node_modules|\/var\/|stack|fastify/i,
    );
    expect(lines).toHaveLength(0);
  });

  it('logs an unknown failure by request id without exposing request or error secrets', async () => {
    const password = 'do-not-log-password';
    const cookie = '__Host-sweet_memories_session=do-not-log-cookie';
    const leakedSession = 'S'.repeat(43);
    const leakedCsrf = 'C'.repeat(43);
    const originalFilename = 'private-original-photo.jpg';
    const absolutePath = '/var/lib/sweet-memories/staging/private-original-photo.jpg';
    const lines: string[] = [];
    const login = vi.fn<SessionService['login']>(async () => {
      const error = new Error(
        `${password} ${cookie} ${leakedSession} ${leakedCsrf} ${originalFilename} ${absolutePath}`,
      );
      Object.assign(error, {
        code: 'FST_ERR_CTP_BODY_TOO_LARGE',
        statusCode: 413,
      });
      throw error;
    });
    const app = track(buildApp({
      publicOrigin,
      sessionService: createSessionService({ login }),
      photoService: createPhotoService(),
      logger: {
        level: 'error',
        stream: { write: (line) => lines.push(line) },
      },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/session',
      headers: { origin: publicOrigin, cookie },
      payload: { username: 'admin', password },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: '服务器暂时无法处理请求' },
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      requestId: expect.any(String),
      errorCode: 'INTERNAL_ERROR',
      msg: '请求处理失败',
    });

    const externallyVisible = `${response.body}\n${lines.join('\n')}`;
    for (const secret of [
      password,
      cookie,
      leakedSession,
      leakedCsrf,
      originalFilename,
      absolutePath,
      'node_modules',
    ]) {
      expect(externallyVisible).not.toContain(secret);
    }
    expect(externallyVisible).not.toContain('Error:');
  });
});
