// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../migrations.js';
import {
  listAdminPhotoRecords,
  listPublicPhotoRecords,
  updatePhotoRecord,
} from './photos.js';

const migrationsRoot = fileURLToPath(new URL('../../migrations', import.meta.url));
const temporaryRoots: string[] = [];
const databases: Database.Database[] = [];

interface SeedPhoto {
  readonly id: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly capturedDate?: string | null;
  readonly status?: 'migration_pending' | 'published';
  readonly createdAt?: string;
  readonly version?: number;
}

function createDatabase(): Database.Database {
  const root = mkdtempSync(join(tmpdir(), 'sweet-memories-photos-'));
  temporaryRoots.push(root);
  const db = new Database(join(root, 'catalog.sqlite3'));
  databases.push(db);
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsRoot);
  return db;
}

function seedPhoto(db: Database.Database, input: SeedPhoto): void {
  db.prepare(
    `INSERT INTO photos(
       id, title, description, captured_date, status, rotation, offset_x, offset_y,
       request_id, version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.title ?? `Title ${input.id}`,
    input.description ?? null,
    input.capturedDate ?? '2026-01-02',
    input.status ?? 'published',
    -2,
    3,
    4,
    `request-${input.id}`,
    input.version ?? 1,
    input.createdAt ?? '2026-02-01T00:00:00.000Z',
    input.createdAt ?? '2026-02-01T00:00:00.000Z',
  );
}

function seedAsset(
  db: Database.Database,
  input: {
    readonly photoId: string;
    readonly kind?: 'master' | 'responsive';
    readonly format: 'avif' | 'webp' | 'jpeg';
    readonly width: number;
    readonly height?: number;
    readonly relativePath?: string;
  },
): void {
  db.prepare(
    `INSERT INTO photo_assets(photo_id, kind, format, width, height, relative_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.photoId,
    input.kind ?? 'responsive',
    input.format,
    input.width,
    input.height ?? Math.round(input.width * 0.75),
    input.relativePath ?? `${input.photoId}/${input.width}.${input.format === 'jpeg' ? 'jpg' : input.format}`,
  );
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('photo repository reads', () => {
  it('lets SQL select only published rows in captured, created, id order', () => {
    const db = createDatabase();
    seedPhoto(db, {
      id: 'next-date',
      capturedDate: '2026-01-03',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    seedPhoto(db, {
      id: 'later-created',
      capturedDate: '2026-01-02',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    seedPhoto(db, {
      id: 'earlier-created',
      capturedDate: '2026-01-02',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    seedPhoto(db, {
      id: 'same-date-and-time-z',
      capturedDate: '2026-01-02',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    seedPhoto(db, {
      id: 'migration-only',
      capturedDate: null,
      status: 'migration_pending',
    });

    expect(listPublicPhotoRecords(db).map(({ id }) => id)).toEqual([
      'earlier-created',
      'later-created',
      'same-date-and-time-z',
      'next-date',
    ]);
    expect(listAdminPhotoRecords(db).map(({ id }) => id)).toContain('migration-only');
  });

  it('loads responsive assets in deterministic format and width order', () => {
    const db = createDatabase();
    seedPhoto(db, { id: 'photo-assets' });
    seedAsset(db, { photoId: 'photo-assets', format: 'webp', width: 960 });
    seedAsset(db, { photoId: 'photo-assets', format: 'avif', width: 640 });
    seedAsset(db, { photoId: 'photo-assets', format: 'jpeg', width: 320 });
    seedAsset(db, { photoId: 'photo-assets', format: 'avif', width: 320 });
    seedAsset(db, {
      photoId: 'photo-assets',
      kind: 'master',
      format: 'jpeg',
      width: 1400,
      relativePath: 'photo-assets/master.jpg',
    });

    expect(listPublicPhotoRecords(db)[0]?.assets.map((asset) => [
      asset.kind,
      asset.format,
      asset.width,
    ])).toEqual([
      ['master', 'jpeg', 1400],
      ['responsive', 'avif', 320],
      ['responsive', 'avif', 640],
      ['responsive', 'webp', 960],
      ['responsive', 'jpeg', 320],
    ]);
  });
});

describe('photo repository updates', () => {
  it('updates by id and version in one transaction and increments the version', () => {
    const db = createDatabase();
    seedPhoto(db, { id: 'editable', version: 3 });

    const result = updatePhotoRecord(db, {
      id: 'editable',
      title: 'Updated title',
      description: 'Updated description',
      capturedDate: '2026-02-28',
      expectedVersion: 3,
      updatedAt: '2026-09-01T12:00:00.000Z',
    });

    expect(result.kind).toBe('updated');
    if (result.kind === 'updated') {
      expect(result.photo).toMatchObject({
        id: 'editable',
        title: 'Updated title',
        description: 'Updated description',
        capturedDate: '2026-02-28',
        version: 4,
        updatedAt: '2026-09-01T12:00:00.000Z',
      });
    }
  });

  it('distinguishes a stale version from an unknown photo without changing either', () => {
    const db = createDatabase();
    seedPhoto(db, { id: 'editable', title: 'Original', version: 2 });
    const input = {
      title: 'Overwritten',
      description: null,
      capturedDate: '2026-03-01',
      expectedVersion: 1,
      updatedAt: '2026-09-01T12:00:00.000Z',
    } as const;

    expect(updatePhotoRecord(db, { id: 'editable', ...input })).toEqual({
      kind: 'conflict',
    });
    expect(updatePhotoRecord(db, { id: 'missing', ...input })).toEqual({
      kind: 'not_found',
    });
    expect(db.prepare('SELECT title, version FROM photos WHERE id = ?').get('editable')).toEqual({
      title: 'Original',
      version: 2,
    });
  });
});
