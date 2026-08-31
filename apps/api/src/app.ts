import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyLoggerOptions,
} from 'fastify';

import {
  AuthenticationError,
  type SessionService,
} from './auth/session-service.js';
import {
  apiErrorBody,
  ApiHttpError,
  type ApiErrorBody,
} from './http/security.js';
import { registerAdminSessionRoutes } from './routes/admin-session.js';
import { registerHealthRoute } from './routes/health.js';

export type { ApiErrorBody } from './http/security.js';

export interface AppDependencies {
  readonly publicOrigin: string;
  readonly sessionService: SessionService;
  readonly logger?: false | FastifyLoggerOptions;
}

function isBadRequestError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'statusCode') === 400
  );
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({
    trustProxy: ['127.0.0.1', '::1'],
    logger: dependencies.logger ?? { level: 'info' },
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.register(cookie);
  app.register(multipart);

  app.setNotFoundHandler(async (_request, reply) => {
    return reply
      .code(404)
      .send(apiErrorBody('NOT_FOUND', '请求的资源不存在'));
  });

  app.setErrorHandler(async (error, request, reply) => {
    let statusCode: number;
    let body: ApiErrorBody;

    if (error instanceof ApiHttpError) {
      statusCode = error.statusCode;
      body = apiErrorBody(error.code, error.publicMessage);
    } else if (error instanceof AuthenticationError) {
      statusCode = 401;
      body = apiErrorBody(error.code, error.message);
    } else if (isBadRequestError(error)) {
      statusCode = 400;
      body = apiErrorBody('INVALID_REQUEST', '请求内容无效');
    } else {
      statusCode = 500;
      body = apiErrorBody('INTERNAL_ERROR', '服务器暂时无法处理请求');
      request.log.error(
        { requestId: request.id, errorCode: 'INTERNAL_ERROR' },
        '请求处理失败',
      );
    }

    return reply.code(statusCode).send(body);
  });

  registerHealthRoute(app);
  registerAdminSessionRoutes(app, dependencies);

  return app;
}
