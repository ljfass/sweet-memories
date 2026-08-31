import type { FastifyRequest } from 'fastify';

import type {
  AuthenticatedSession,
  SessionService,
} from '../auth/session-service.js';

export const SESSION_COOKIE_NAME = '__Host-sweet_memories_session';

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export class ApiHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'ApiHttpError';
  }
}

export interface AuthenticatedRequest {
  readonly rawToken: string;
  readonly session: AuthenticatedSession;
}

export function apiErrorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export function requireExactOrigin(request: FastifyRequest, publicOrigin: string): void {
  if (request.headers.origin !== publicOrigin) {
    throw new ApiHttpError(403, 'ORIGIN_FORBIDDEN', '请求来源无效');
  }
}

export function requireAuthenticatedRequest(
  request: FastifyRequest,
  sessionService: SessionService,
): AuthenticatedRequest {
  const rawToken = request.cookies[SESSION_COOKIE_NAME];
  if (rawToken === undefined) {
    throw new ApiHttpError(401, 'AUTHENTICATION_REQUIRED', '请重新登录');
  }

  const session = sessionService.authenticate(rawToken);
  if (session === null) {
    throw new ApiHttpError(401, 'AUTHENTICATION_REQUIRED', '请重新登录');
  }

  return { rawToken, session };
}

export function requireCsrf(
  request: FastifyRequest,
  sessionService: SessionService,
  session: AuthenticatedSession,
): void {
  const rawCsrf = request.headers['x-csrf-token'];
  if (typeof rawCsrf !== 'string' || !sessionService.verifyCsrf(session, rawCsrf)) {
    throw new ApiHttpError(403, 'CSRF_FORBIDDEN', 'CSRF 校验失败');
  }
}
