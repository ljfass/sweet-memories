// @vitest-environment node

import { mkdir, readFile, readdir, rename, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../migrations.js';
import {
  createDeletePhotoService,
  type RemoveMediaTree,
} from './delete-photo.js';

const migrationsRoot = fileURLToPath(new URL('../../migrations', import.meta.url));
const photoId = '0195c681-9c63-7db0-8000-000000000201';
const deleteId = '0195c681-9c63-7db0-8000-000000000901';
const roots: string[] = [];
const databases: Database.Database[] = [];

let db: Database.Database;
let mediaRoot: string;

function seedPhoto(id = photoId, version = 1): void {
  db.prepare(
    `INSERT INTO photos(
       id, title, description, captured_date, status, rotation, offset_x, offset_y,
       request_id, version, created_at, updated_at
     ) VALUES (?, ?, NULL, '2026-01-02', 'published', 0, 0, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    `Photo ${id}`,
    `request-${id}`,
    version,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );
}

function photoExists(id = photoId): boolean {
  return db.prepare('SELECT 1 FROM photos WHERE id = ?').get(id) !== undefined;
}

async function createMedia(id = photoId): Promise<string> {
  const directory = join(mediaRoot, id);
  await mkdir(directory, { mode: 0o750 });
  await writeFile(join(directory, 'master.jpg'), 'private-photo-media');
  return directory;
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'sweet-memories-delete-'));
  roots.push(root);
  mediaRoot = join(root, 'media');
  await mkdir(mediaRoot);
  db = new Database(join(root, 'database.sqlite3'));
  databases.push(db);
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsRoot);
});

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('DeletePhotoService', () => {
  it('moves media into a private deleting directory before deleting the matching version', async () => {
    seedPhoto();
    const directory = await createMedia();
    const observations: Array<{ sourceExists: boolean; databaseExists: boolean; deletingMode: number }> = [];
    db.exec(`
      CREATE TEMP TRIGGER observe_delete BEFORE DELETE ON photos
      BEGIN
        SELECT CASE WHEN filesystem_observation() = 1 THEN 1 ELSE RAISE(ABORT, 'media not isolated') END;
      END;
    `);
    db.function('filesystem_observation', () => {
      const sourceExists = (() => {
        try { statSync(directory); return true; } catch { return false; }
      })();
      return sourceExists ? 0 : 1;
    });
    const remove: RemoveMediaTree = async (path, options) => {
      const sourceExists = await stat(directory).then(() => true, () => false);
      const deletingMode = (await stat(join(mediaRoot, '.deleting'))).mode & 0o777;
      observations.push({ sourceExists, databaseExists: photoExists(), deletingMode });
      const { rm } = await import('node:fs/promises');
      await rm(path, options);
    };
    const service = createDeletePhotoService({
      db,
      mediaRoot,
      createUuid: () => deleteId,
      remove,
    });

    await expect(service.delete({ id: photoId, version: 1 })).resolves.toEqual({ deleted: true });

    expect(photoExists()).toBe(false);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(mediaRoot, '.deleting'))).toEqual([]);
    expect(observations).toEqual([
      { sourceExists: false, databaseExists: false, deletingMode: 0o700 },
    ]);
  });

  it('refreshes an old media directory after rename before deleting its database row', async () => {
    seedPhoto();
    const directory = await createMedia();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await utimes(directory, old, old);
    const target = join(mediaRoot, '.deleting', `${photoId}-${deleteId}`);
    db.function('deleting_target_is_fresh', () => {
      try {
        return statSync(target).mtimeMs > Date.now() - 5_000 ? 1 : 0;
      } catch {
        return 0;
      }
    });
    db.exec(`
      CREATE TEMP TRIGGER require_fresh_delete_target BEFORE DELETE ON photos
      BEGIN
        SELECT CASE WHEN deleting_target_is_fresh() = 1
          THEN 1 ELSE RAISE(ABORT, 'delete target was immediately stale') END;
      END;
    `);
    const service = createDeletePhotoService({ db, mediaRoot, createUuid: () => deleteId });

    await expect(service.delete({ id: photoId, version: 1 })).resolves.toEqual({ deleted: true });

    expect(photoExists()).toBe(false);
  });

  it('restores media and preserves the database row when refreshing the delete target fails', async () => {
    seedPhoto();
    const directory = await createMedia();
    const service = createDeletePhotoService({
      db,
      mediaRoot,
      createUuid: () => deleteId,
      touch: async () => {
        throw new Error('simulated timestamp failure');
      },
    });

    await expect(service.delete({ id: photoId, version: 1 })).rejects.toMatchObject({
      code: 'UNSAFE_MEDIA_PATH',
    });

    expect(photoExists()).toBe(true);
    await expect(readFile(join(directory, 'master.jpg'), 'utf8')).resolves.toBe('private-photo-media');
    expect(await readdir(join(mediaRoot, '.deleting'))).toEqual([]);
  });

  it('stops database deletion when another worker restores the original media during touch', async () => {
    seedPhoto();
    const directory = await createMedia();
    const service = createDeletePhotoService({
      db,
      mediaRoot,
      createUuid: () => deleteId,
      touch: async (target) => {
        await rename(target, directory);
      },
    });

    await expect(service.delete({ id: photoId, version: 1 })).rejects.toMatchObject({
      code: 'UNSAFE_MEDIA_PATH',
    });

    expect(photoExists()).toBe(true);
    await expect(readFile(join(directory, 'master.jpg'), 'utf8')).resolves.toBe('private-photo-media');
    expect(await readdir(join(mediaRoot, '.deleting'))).toEqual([]);
  });

  it('retains private media and a competing source when the post-touch source check fails', async () => {
    seedPhoto();
    const directory = await createMedia();
    const target = join(mediaRoot, '.deleting', `${photoId}-${deleteId}`);
    const service = createDeletePhotoService({
      db,
      mediaRoot,
      createUuid: () => deleteId,
      touch: async () => {
        await mkdir(directory);
        await writeFile(join(directory, 'competitor.jpg'), 'competitor');
      },
    });

    await expect(service.delete({ id: photoId, version: 1 })).rejects.toBeInstanceOf(AggregateError);

    expect(photoExists()).toBe(true);
    await expect(readFile(join(directory, 'competitor.jpg'), 'utf8')).resolves.toBe('competitor');
    await expect(readFile(join(target, 'master.jpg'), 'utf8')).resolves.toBe('private-photo-media');
  });

  it('restores the original media atomically when the database transaction fails', async () => {
    seedPhoto();
    const directory = await createMedia();
    db.exec(`
      CREATE TRIGGER fail_photo_delete BEFORE DELETE ON photos
      BEGIN SELECT RAISE(ABORT, 'database delete failed'); END;
    `);
    const service = createDeletePhotoService({ db, mediaRoot, createUuid: () => deleteId });

    await expect(service.delete({ id: photoId, version: 1 })).rejects.toThrow(
      /database delete failed/u,
    );

    expect(photoExists()).toBe(true);
    await expect(readFile(join(directory, 'master.jpg'), 'utf8')).resolves.toBe('private-photo-media');
    expect(await readdir(join(mediaRoot, '.deleting'))).toEqual([]);
  });

  it('restores media and reports 409 when a newer version wins', async () => {
    seedPhoto(photoId, 2);
    const directory = await createMedia();
    const service = createDeletePhotoService({ db, mediaRoot, createUuid: () => deleteId });

    await expect(service.delete({ id: photoId, version: 1 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHOTO_VERSION_CONFLICT',
    });

    expect(photoExists()).toBe(true);
    await expect(stat(directory)).resolves.toBeDefined();
    expect(await readdir(join(mediaRoot, '.deleting'))).toEqual([]);
  });

  it('keeps a private retry directory and still succeeds after the database committed', async () => {
    seedPhoto();
    await createMedia();
    const remove = vi.fn<RemoveMediaTree>(async () => {
      throw new Error('simulated cleanup failure');
    });
    const service = createDeletePhotoService({
      db,
      mediaRoot,
      createUuid: () => deleteId,
      remove,
    });

    await expect(service.delete({ id: photoId, version: 1 })).resolves.toEqual({ deleted: true });

    expect(photoExists()).toBe(false);
    expect(remove).toHaveBeenCalledOnce();
    expect(await readdir(join(mediaRoot, '.deleting'))).toEqual([`${photoId}-${deleteId}`]);
  });

  it('returns idempotent not-deleted without touching media for an already deleted photo', async () => {
    const unrelated = '0195c681-9c63-7db0-8000-000000000202';
    seedPhoto(unrelated);
    await createMedia(unrelated);
    const service = createDeletePhotoService({ db, mediaRoot, createUuid: () => deleteId });

    await expect(service.delete({ id: photoId, version: 1 })).resolves.toEqual({ deleted: false });

    expect(photoExists(unrelated)).toBe(true);
    await expect(stat(join(mediaRoot, unrelated))).resolves.toBeDefined();
    expect(await readdir(mediaRoot)).toEqual([unrelated]);
  });

  it.each([
    ['', 1],
    ['../escape', 1],
    [photoId.toUpperCase(), 1],
    [photoId, 0],
    [photoId, 1.5],
    [photoId, Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a noncanonical server id/version without filesystem changes', async (id, version) => {
    seedPhoto();
    await createMedia();
    const service = createDeletePhotoService({ db, mediaRoot, createUuid: () => deleteId });

    await expect(service.delete({ id, version })).rejects.toMatchObject({ statusCode: 400 });

    expect(photoExists()).toBe(true);
    expect(await readdir(mediaRoot)).toEqual([photoId]);
  });

  it.each(['source symlink', 'file instead of directory', 'symlink nested in directory'])(
    'fails closed for an unsafe media tree: %s',
    async (kind) => {
      seedPhoto();
      const outside = join(mediaRoot, '..', 'outside.txt');
      await writeFile(outside, 'must survive');
      if (kind === 'source symlink') {
        await symlink(outside, join(mediaRoot, photoId));
      } else if (kind === 'file instead of directory') {
        await writeFile(join(mediaRoot, photoId), 'not a directory');
      } else {
        await mkdir(join(mediaRoot, photoId));
        await symlink(outside, join(mediaRoot, photoId, 'master.jpg'));
      }
      const service = createDeletePhotoService({ db, mediaRoot, createUuid: () => deleteId });

      await expect(service.delete({ id: photoId, version: 1 })).rejects.toMatchObject({
        statusCode: 500,
        code: 'UNSAFE_MEDIA_PATH',
      });

      expect(photoExists()).toBe(true);
      await expect(readFile(outside, 'utf8')).resolves.toBe('must survive');
      expect((await readdir(mediaRoot)).sort()).toEqual([photoId].sort());
    },
  );

  it('never overwrites a competing source during database-failure restoration', async () => {
    seedPhoto();
    await createMedia();
    db.function('create_competing_source', () => {
      const source = join(mediaRoot, photoId);
      mkdirSync(source);
      writeFileSync(join(source, 'competitor.jpg'), 'competitor');
      return 1;
    });
    db.exec(`
      CREATE TRIGGER fail_photo_delete BEFORE DELETE ON photos
      BEGIN
        SELECT create_competing_source();
        SELECT RAISE(ABORT, 'database delete failed');
      END;
    `);
    const service = createDeletePhotoService({
      db,
      mediaRoot,
      createUuid: () => deleteId,
    });

    await expect(service.delete({ id: photoId, version: 1 })).rejects.toBeInstanceOf(AggregateError);

    expect(photoExists()).toBe(true);
    await expect(readFile(join(mediaRoot, photoId, 'competitor.jpg'), 'utf8')).resolves.toBe('competitor');
    expect(await readdir(join(mediaRoot, '.deleting'))).toEqual([`${photoId}-${deleteId}`]);
  });
});
