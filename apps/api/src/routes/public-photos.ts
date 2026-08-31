import type { FastifyInstance } from 'fastify';

import type { PhotoService } from '../services/photo-service.js';

export interface PublicPhotoRouteDependencies {
  readonly photoService: PhotoService;
}

export function registerPublicPhotoRoutes(
  app: FastifyInstance,
  dependencies: PublicPhotoRouteDependencies,
): void {
  app.get('/api/photos', async () => dependencies.photoService.listPublicPhotos());
}
