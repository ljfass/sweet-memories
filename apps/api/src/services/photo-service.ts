import type Database from 'better-sqlite3';

import { ApiHttpError } from '../http/security.js';
import {
  listAdminPhotoRecords,
  listPublicPhotoRecords,
  updatePhotoRecord,
  type PhotoAssetRecord,
  type PhotoRecord,
} from '../repositories/photos.js';

export interface PublicPhotoDto {
  readonly id: string;
  readonly title: string;
  readonly alt: string;
  readonly capturedDate: string;
  readonly transform: { readonly rotation: number; readonly x: number; readonly y: number };
  readonly sources: {
    readonly avif: ReadonlyArray<{ readonly url: string; readonly width: number }>;
    readonly webp: ReadonlyArray<{ readonly url: string; readonly width: number }>;
    readonly jpeg: ReadonlyArray<{ readonly url: string; readonly width: number }>;
    readonly fallback: {
      readonly url: string;
      readonly width: number;
      readonly height: number;
    };
  };
}

export interface AdminPhotoDto extends Omit<PublicPhotoDto, 'capturedDate'> {
  readonly description: string | null;
  readonly capturedDate: string | null;
  readonly status: 'migration_pending' | 'published';
  readonly version: number;
}

export interface UpdatePhotoInput {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly capturedDate: string;
  readonly version: number;
}

export interface PhotoService {
  listPublicPhotos(): readonly PublicPhotoDto[];
  listAdminPhotos(): readonly AdminPhotoDto[];
  updatePhoto(input: UpdatePhotoInput): AdminPhotoDto;
}

export interface CreatePhotoServiceOptions {
  readonly db: Database.Database;
  readonly now?: () => Date;
}

interface PublicSources {
  readonly avif: Array<{ readonly url: string; readonly width: number }>;
  readonly webp: Array<{ readonly url: string; readonly width: number }>;
  readonly jpeg: Array<{ readonly url: string; readonly width: number }>;
  readonly fallback: {
    readonly url: string;
    readonly width: number;
    readonly height: number;
  };
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CANONICAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCanonicalCalendarDate(value: string): boolean {
  const match = CANONICAL_DATE.exec(value);
  if (match === null || Number(match[1]) === 0) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function mediaUrl(photoId: string, relativePath: string): string {
  if (
    !SAFE_PATH_SEGMENT.test(photoId) ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\')
  ) {
    throw new Error('Unsafe media path');
  }
  const segments = relativePath.split('/');
  if (
    segments.length !== 2 ||
    segments[0] !== photoId ||
    segments[1] === undefined ||
    !SAFE_PATH_SEGMENT.test(segments[1]) ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('Unsafe media path');
  }
  return `/media/${relativePath}`;
}

function assertAssetDimensions(asset: PhotoAssetRecord): void {
  if (
    !Number.isSafeInteger(asset.width) ||
    !Number.isSafeInteger(asset.height) ||
    asset.width <= 0 ||
    asset.height <= 0
  ) {
    throw new Error('Invalid media dimensions');
  }
}

function publicSources(photo: PhotoRecord): PublicSources {
  for (const asset of photo.assets) {
    assertAssetDimensions(asset);
    mediaUrl(photo.id, asset.relativePath);
  }
  const responsive = photo.assets.filter((asset) => asset.kind === 'responsive');
  const source = (format: 'avif' | 'webp' | 'jpeg') =>
    responsive
      .filter((asset) => asset.format === format)
      .sort((left, right) => left.width - right.width)
      .map((asset) => {
        assertAssetDimensions(asset);
        return { url: mediaUrl(photo.id, asset.relativePath), width: asset.width };
      });
  const avif = source('avif');
  const webp = source('webp');
  const jpeg = source('jpeg');
  const fallbackAsset = responsive
    .filter((asset) => asset.format === 'jpeg')
    .sort((left, right) => right.width - left.width)[0];
  if (fallbackAsset === undefined) {
    throw new Error('Photo has no JPEG fallback');
  }
  assertAssetDimensions(fallbackAsset);

  return {
    avif,
    webp,
    jpeg,
    fallback: {
      url: mediaUrl(photo.id, fallbackAsset.relativePath),
      width: fallbackAsset.width,
      height: fallbackAsset.height,
    },
  };
}

function publicPhoto(photo: PhotoRecord): PublicPhotoDto {
  if (photo.capturedDate === null || !isCanonicalCalendarDate(photo.capturedDate)) {
    throw new Error('Published photo has no valid captured date');
  }
  const description = photo.description?.trim();
  return {
    id: photo.id,
    title: photo.title,
    alt: description === undefined || description.length === 0 ? photo.title : description,
    capturedDate: photo.capturedDate,
    transform: { rotation: photo.rotation, x: photo.offsetX, y: photo.offsetY },
    sources: publicSources(photo),
  };
}

function adminPhoto(photo: PhotoRecord): AdminPhotoDto {
  const description = photo.description?.trim();
  return {
    id: photo.id,
    title: photo.title,
    alt: description === undefined || description.length === 0 ? photo.title : description,
    description: photo.description,
    capturedDate: photo.capturedDate,
    status: photo.status,
    version: photo.version,
    transform: { rotation: photo.rotation, x: photo.offsetX, y: photo.offsetY },
    sources: publicSources(photo),
  };
}

class SqlitePhotoService implements PhotoService {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date,
  ) {}

  listPublicPhotos(): readonly PublicPhotoDto[] {
    return listPublicPhotoRecords(this.db).map(publicPhoto);
  }

  listAdminPhotos(): readonly AdminPhotoDto[] {
    return listAdminPhotoRecords(this.db).map(adminPhoto);
  }

  updatePhoto(input: UpdatePhotoInput): AdminPhotoDto {
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('Invalid clock value');
    }
    const result = updatePhotoRecord(this.db, {
      id: input.id,
      title: input.title,
      description: input.description,
      capturedDate: input.capturedDate,
      expectedVersion: input.version,
      updatedAt: now.toISOString(),
    });
    if (result.kind === 'not_found') {
      throw new ApiHttpError(404, 'PHOTO_NOT_FOUND', '照片不存在');
    }
    if (result.kind === 'conflict') {
      throw new ApiHttpError(409, 'PHOTO_VERSION_CONFLICT', '照片已被更新，请刷新后重试');
    }
    return adminPhoto(result.photo);
  }
}

export function createPhotoService(options: CreatePhotoServiceOptions): PhotoService {
  return new SqlitePhotoService(options.db, options.now ?? (() => new Date()));
}

export function normalizePhotoEditBody(body: unknown): Omit<UpdatePhotoInput, 'id'> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiHttpError(400, 'INVALID_PHOTO_EDIT', '照片编辑内容无效');
  }
  const expectedKeys = ['capturedDate', 'description', 'title', 'version'];
  const keys = Object.keys(body).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ApiHttpError(400, 'INVALID_PHOTO_EDIT', '照片编辑内容无效');
  }

  const rawTitle = Reflect.get(body, 'title');
  const rawDescription = Reflect.get(body, 'description');
  const capturedDate = Reflect.get(body, 'capturedDate');
  const version = Reflect.get(body, 'version');
  if (
    typeof rawTitle !== 'string' ||
    (rawDescription !== null && typeof rawDescription !== 'string') ||
    typeof capturedDate !== 'string' ||
    !Number.isSafeInteger(version) ||
    (version as number) < 1
  ) {
    throw new ApiHttpError(400, 'INVALID_PHOTO_EDIT', '照片编辑内容无效');
  }

  const title = rawTitle.normalize('NFC').trim();
  const normalizedDescription = rawDescription?.normalize('NFC').trim() ?? null;
  const description = normalizedDescription === '' ? null : normalizedDescription;
  if (
    Array.from(title).length < 1 ||
    Array.from(title).length > 120 ||
    (description !== null && Array.from(description).length > 500) ||
    !isCanonicalCalendarDate(capturedDate)
  ) {
    throw new ApiHttpError(400, 'INVALID_PHOTO_EDIT', '照片编辑内容无效');
  }

  return { title, description, capturedDate, version: version as number };
}
