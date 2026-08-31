import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  AuthenticationError,
  type SessionService,
} from '../auth/session-service.js';
import {
  ApiHttpError,
  requireAuthenticatedRequest,
  requireCsrf,
  requireExactOrigin,
  SESSION_COOKIE_NAME,
} from '../http/security.js';

const sessionCookieOptions = Object.freeze({
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
});

export interface AdminSessionRouteDependencies {
  readonly publicOrigin: string;
  readonly sessionService: SessionService;
}

interface LoginBody {
  readonly username: string;
  readonly password: string;
}

function readLoginBody(request: FastifyRequest): LoginBody {
  const body = request.body;
  if (
    body === null ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    typeof Reflect.get(body, 'username') !== 'string' ||
    typeof Reflect.get(body, 'password') !== 'string'
  ) {
    throw new ApiHttpError(400, 'INVALID_REQUEST', '请求内容无效');
  }

  return {
    username: Reflect.get(body, 'username') as string,
    password: Reflect.get(body, 'password') as string,
  };
}

function preventSessionCaching(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

export function registerAdminSessionRoutes(
  app: FastifyInstance,
  dependencies: AdminSessionRouteDependencies,
): void {
  const { publicOrigin, sessionService } = dependencies;

  app.post('/api/admin/session', async (request, reply) => {
    preventSessionCaching(reply);
    requireExactOrigin(request, publicOrigin);
    const body = readLoginBody(request);
    const result = await sessionService.login({
      username: body.username,
      password: body.password,
      ip: request.ip,
    });

    reply.setCookie(SESSION_COOKIE_NAME, result.rawToken, sessionCookieOptions);
    return {
      authenticated: true as const,
      csrfToken: result.csrfToken,
      idleExpiresAt: result.idleExpiresAt,
      absoluteExpiresAt: result.absoluteExpiresAt,
    };
  });

  app.get('/api/admin/session', async (request, reply) => {
    preventSessionCaching(reply);
    const authenticated = requireAuthenticatedRequest(request, sessionService);
    let csrfToken: string;
    try {
      csrfToken = sessionService.rotateCsrf(authenticated.rawToken);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw new ApiHttpError(401, 'AUTHENTICATION_REQUIRED', '请重新登录');
      }
      throw error;
    }

    return {
      authenticated: true as const,
      username: authenticated.session.username,
      csrfToken,
      idleExpiresAt: authenticated.session.idleExpiresAt,
      absoluteExpiresAt: authenticated.session.absoluteExpiresAt,
    };
  });

  app.delete('/api/admin/session', async (request, reply) => {
    preventSessionCaching(reply);
    requireExactOrigin(request, publicOrigin);
    const authenticated = requireAuthenticatedRequest(request, sessionService);
    requireCsrf(request, sessionService, authenticated.session);
    sessionService.logout(authenticated.rawToken);
    reply.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions);
    return reply.code(204).send();
  });
}
