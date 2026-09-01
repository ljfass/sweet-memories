import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';

import type { SessionService } from '../auth/session-service.js';
import {
  ApiHttpError,
  requireAuthenticatedRequest,
  requireCsrf,
  requireExactOrigin,
} from '../http/security.js';
import {
  normalizePhotoEditBody,
  type PhotoService,
} from '../services/photo-service.js';
import type { UploadPhotoService } from '../services/upload-photo.js';

export interface AdminPhotoRouteDependencies {
  readonly publicOrigin: string;
  readonly sessionService: SessionService;
  readonly photoService: PhotoService;
  readonly uploadPhotoService: UploadPhotoService;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MULTIPART_LIMITS = Object.freeze({
  files: 1,
  fields: 0,
  fileSize: 10 * 1024 * 1024,
  parts: 1,
});

function invalidMultipart(): ApiHttpError {
  return new ApiHttpError(
    400,
    'INVALID_MULTIPART_UPLOAD',
    '请只上传一个 photo 文件',
  );
}

function uploadTooLarge(): ApiHttpError {
  return new ApiHttpError(413, 'UPLOAD_TOO_LARGE', '单张图片不能超过 10MB');
}

function multipartError(app: FastifyInstance, error: unknown): ApiHttpError | unknown {
  if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
    return uploadTooLarge();
  }
  if (
    error instanceof app.multipartErrors.FilesLimitError
    || error instanceof app.multipartErrors.FieldsLimitError
    || error instanceof app.multipartErrors.PartsLimitError
    || error instanceof app.multipartErrors.PrematureCloseError
  ) {
    return invalidMultipart();
  }
  if (
    typeof error === 'object'
    && error !== null
    && Reflect.get(error, 'code') === 'ERR_STREAM_PREMATURE_CLOSE'
  ) {
    return invalidMultipart();
  }
  return error;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !CANONICAL_UUID.test(value)) {
    throw new ApiHttpError(400, 'INVALID_IDEMPOTENCY_KEY', '上传请求 ID 无效');
  }
  return value;
}

function photoUploadStream(app: FastifyInstance, request: FastifyRequest): Readable {
  return Readable.from((async function* () {
    if (!request.isMultipart()) {
      throw new ApiHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 multipart/form-data 上传');
    }

    const parts = request.parts({ limits: MULTIPART_LIMITS });
    let first;
    try {
      first = await parts.next();
    } catch (error) {
      throw multipartError(app, error);
    }
    if (first.done || first.value.type !== 'file') {
      throw invalidMultipart();
    }
    const part = first.value;
    if (part.fieldname !== 'photo') {
      for await (const _chunk of part.file) {
        // Consume the bounded invalid part so the multipart parser can finish safely.
        void _chunk;
      }
      throw invalidMultipart();
    }

    for await (const chunk of part.file) {
      yield chunk;
    }

    let tail;
    try {
      tail = await parts.next();
    } catch (error) {
      throw multipartError(app, error);
    }
    if (part.file.truncated) {
      throw uploadTooLarge();
    }
    if (!tail.done) {
      if (tail.value.type === 'file') {
        for await (const _chunk of tail.value.file) {
          // Drain before rejecting the extra part.
          void _chunk;
        }
      }
      throw invalidMultipart();
    }
  })());
}

function preventAdminCaching(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

function photoId(request: FastifyRequest): string {
  const params = request.params;
  if (params === null || typeof params !== 'object') {
    return '';
  }
  const id = Reflect.get(params, 'id');
  return typeof id === 'string' ? id : '';
}

export function registerAdminPhotoRoutes(
  app: FastifyInstance,
  dependencies: AdminPhotoRouteDependencies,
): void {
  app.get('/api/admin/photos', async (request, reply) => {
    preventAdminCaching(reply);
    requireAuthenticatedRequest(request, dependencies.sessionService);
    return dependencies.photoService.listAdminPhotos();
  });

  app.post('/api/admin/photos', async (request, reply) => {
    preventAdminCaching(reply);
    requireExactOrigin(request, dependencies.publicOrigin);
    const authenticated = requireAuthenticatedRequest(request, dependencies.sessionService);
    requireCsrf(request, dependencies.sessionService, authenticated.session);
    const requestId = idempotencyKey(request);
    try {
      const result = await dependencies.uploadPhotoService.upload({
        requestId,
        stream: photoUploadStream(app, request),
      });
      return reply.code(result.replayed ? 200 : 201).send({ photo: result.photo });
    } catch (error) {
      throw multipartError(app, error);
    }
  });

  app.patch('/api/admin/photos/:id', async (request, reply) => {
    preventAdminCaching(reply);
    requireExactOrigin(request, dependencies.publicOrigin);
    const authenticated = requireAuthenticatedRequest(request, dependencies.sessionService);
    requireCsrf(request, dependencies.sessionService, authenticated.session);
    const edit = normalizePhotoEditBody(request.body);
    return dependencies.photoService.updatePhoto({ id: photoId(request), ...edit });
  });
}
