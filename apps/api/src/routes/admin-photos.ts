import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { SessionService } from '../auth/session-service.js';
import {
  requireAuthenticatedRequest,
  requireCsrf,
  requireExactOrigin,
} from '../http/security.js';
import {
  normalizePhotoEditBody,
  type PhotoService,
} from '../services/photo-service.js';

export interface AdminPhotoRouteDependencies {
  readonly publicOrigin: string;
  readonly sessionService: SessionService;
  readonly photoService: PhotoService;
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

  app.patch('/api/admin/photos/:id', async (request, reply) => {
    preventAdminCaching(reply);
    requireExactOrigin(request, dependencies.publicOrigin);
    const authenticated = requireAuthenticatedRequest(request, dependencies.sessionService);
    requireCsrf(request, dependencies.sessionService, authenticated.session);
    const edit = normalizePhotoEditBody(request.body);
    return dependencies.photoService.updatePhoto({ id: photoId(request), ...edit });
  });
}
