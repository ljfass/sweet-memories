import type Database from 'better-sqlite3';

import type { PhotoAssetFormat, PhotoAssetKind, PhotoStatus } from '../types.js';

export interface PhotoAssetRecord {
  readonly photoId: string;
  readonly kind: PhotoAssetKind;
  readonly format: PhotoAssetFormat;
  readonly width: number;
  readonly height: number;
  readonly relativePath: string;
}

export interface PhotoRecord {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly capturedDate: string | null;
  readonly status: PhotoStatus;
  readonly rotation: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly assets: readonly PhotoAssetRecord[];
}

export interface UpdatePhotoRecordInput {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly capturedDate: string;
  readonly expectedVersion: number;
  readonly updatedAt: string;
}

export type UpdatePhotoRecordResult<T = PhotoRecord> =
  | { readonly kind: 'updated'; readonly photo: T }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'not_found' };

interface PhotoRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly captured_date: string | null;
  readonly status: PhotoStatus;
  readonly rotation: number;
  readonly offset_x: number;
  readonly offset_y: number;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PhotoAssetRow {
  readonly photo_id: string;
  readonly kind: PhotoAssetKind;
  readonly format: PhotoAssetFormat;
  readonly width: number;
  readonly height: number;
  readonly relative_path: string;
}

const PHOTO_COLUMNS = `
  id, title, description, captured_date, status, rotation, offset_x, offset_y,
  version, created_at, updated_at
`;

function listAssets(
  db: Database.Database,
  photoId: string,
): readonly PhotoAssetRecord[] {
  const rows = db.prepare(
    `SELECT photo_id, kind, format, width, height, relative_path
     FROM photo_assets
     WHERE photo_id = ?
     ORDER BY
       CASE kind WHEN 'master' THEN 0 ELSE 1 END ASC,
       CASE format WHEN 'avif' THEN 0 WHEN 'webp' THEN 1 ELSE 2 END ASC,
       width ASC,
       height ASC,
       relative_path ASC`,
  ).all(photoId) as PhotoAssetRow[];

  return rows.map((row) => ({
    photoId: row.photo_id,
    kind: row.kind,
    format: row.format,
    width: row.width,
    height: row.height,
    relativePath: row.relative_path,
  }));
}

function mapPhotoRow(db: Database.Database, row: PhotoRow): PhotoRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    capturedDate: row.captured_date,
    status: row.status,
    rotation: row.rotation,
    offsetX: row.offset_x,
    offsetY: row.offset_y,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assets: listAssets(db, row.id),
  };
}

function findPhotoRecord(
  db: Database.Database,
  id: string,
): PhotoRecord | undefined {
  const row = db.prepare(
    `SELECT ${PHOTO_COLUMNS}
     FROM photos
     WHERE id = ?`,
  ).get(id) as PhotoRow | undefined;
  return row === undefined ? undefined : mapPhotoRow(db, row);
}

export function listPublicPhotoRecords(
  db: Database.Database,
): readonly PhotoRecord[] {
  const rows = db.prepare(
    `SELECT ${PHOTO_COLUMNS}
     FROM photos
     WHERE status = 'published'
     ORDER BY captured_date ASC, created_at ASC, id ASC`,
  ).all() as PhotoRow[];
  return rows.map((row) => mapPhotoRow(db, row));
}

export function listAdminPhotoRecords(
  db: Database.Database,
): readonly PhotoRecord[] {
  const rows = db.prepare(
    `SELECT ${PHOTO_COLUMNS}
     FROM photos
     ORDER BY captured_date ASC, created_at ASC, id ASC`,
  ).all() as PhotoRow[];
  return rows.map((row) => mapPhotoRow(db, row));
}

export function updatePhotoRecord(
  db: Database.Database,
  input: UpdatePhotoRecordInput,
): UpdatePhotoRecordResult {
  return updatePhotoRecordAtomically(db, input, (photo) => photo);
}

export function updatePhotoRecordAtomically<T>(
  db: Database.Database,
  input: UpdatePhotoRecordInput,
  mapUpdatedPhoto: (photo: PhotoRecord) => T,
): UpdatePhotoRecordResult<T> {
  return db.transaction(() => {
    const update = db.prepare(
      `UPDATE photos
       SET title = ?, description = ?, captured_date = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    ).run(
      input.title,
      input.description,
      input.capturedDate,
      input.updatedAt,
      input.id,
      input.expectedVersion,
    );

    if (update.changes === 1) {
      const photo = findPhotoRecord(db, input.id);
      if (photo === undefined) {
        throw new Error('Updated photo disappeared inside transaction');
      }
      return { kind: 'updated' as const, photo: mapUpdatedPhoto(photo) };
    }

    const exists = db.prepare('SELECT 1 FROM photos WHERE id = ?').get(input.id);
    return exists === undefined
      ? { kind: 'not_found' as const }
      : { kind: 'conflict' as const };
  }).immediate();
}
