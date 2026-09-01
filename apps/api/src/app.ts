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
import { registerAdminPhotoRoutes } from './routes/admin-photos.js';
import { registerHealthRoute } from './routes/health.js';
import { registerPublicPhotoRoutes } from './routes/public-photos.js';
import type { DeletePhotoService } from './services/delete-photo.js';
import type { PhotoService } from './services/photo-service.js';
import type { UploadPhotoService } from './services/upload-photo.js';

export type { ApiErrorBody } from './http/security.js';

export interface AppDependencies {
  readonly publicOrigin: string;
  readonly sessionService: SessionService;
  readonly photoService: PhotoService;
  readonly uploadPhotoService: UploadPhotoService;
  readonly deletePhotoService: DeletePhotoService;
  readonly logger?: false | FastifyLoggerOptions;
}

interface KnownClientError {
  readonly statusCode: 400 | 413 | 415;
  readonly code: string;
  readonly message: string;
}

function knownFastifyClientError(error: unknown): KnownClientError | null {
  if (
    (error instanceof Fastify.errorCodes.FST_ERR_CTP_INVALID_JSON_BODY ||
      error instanceof Fastify.errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY ||
      error instanceof Fastify.errorCodes.FST_ERR_CTP_INVALID_CONTENT_LENGTH ||
      error instanceof Fastify.errorCodes.FST_ERR_VALIDATION) &&
    error.statusCode === 400
  ) {
    return { statusCode: 400, code: 'INVALID_REQUEST', message: '请求内容无效' };
  }

  if (
    error instanceof Fastify.errorCodes.FST_ERR_CTP_BODY_TOO_LARGE &&
    error.statusCode === 413
  ) {
    return { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: '请求内容过大' };
  }

  if (
    error instanceof Fastify.errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE &&
    error.statusCode === 415
  ) {
    return {
      statusCode: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: '不支持的内容类型',
    };
  }

  return null;
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({
    trustProxy: ['127.0.0.1', '::1'],
    exposeHeadRoutes: false,
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
    const clientError = knownFastifyClientError(error);

    if (error instanceof ApiHttpError) {
      statusCode = error.statusCode;
      body = apiErrorBody(error.code, error.publicMessage);
    } else if (error instanceof AuthenticationError) {
      statusCode = 401;
      body = apiErrorBody(error.code, error.message);
    } else if (clientError !== null) {
      statusCode = clientError.statusCode;
      body = apiErrorBody(clientError.code, clientError.message);
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
  registerPublicPhotoRoutes(app, dependencies);
  registerAdminPhotoRoutes(app, dependencies);

  return app;
}
