// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../migrations.js';
import { createDeletePhotoService } from './delete-photo.js';
import {
  MAINTENANCE_BUDGET,
  createMaintenanceService,
  type RemoveMaintenanceTree,
} from './maintenance.js';

const migrationsRoot = fileURLToPath(new URL('../../migrations', import.meta.url));
const now = new Date('2026-09-01T12:00:00.000Z');
const stale = new Date(now.getTime() - 24 * 60 * 60 * 1_000 - 1);
const exactly24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
const fresh = new Date(now.getTime() - 60_000);
const roots: string[] = [];
const databases: Database.Database[] = [];

let root: string;
let mediaRoot: string;
let stagingRoot: string;
let deletingRoot: string;
let db: Database.Database;

function uuid(index: number): string {
  return `0195c681-9c63-7db0-8000-${String(index).padStart(12, '0')}`;
}

async function directory(path: string, age: Date, contents = 'residual'): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, 'entry.bin'), contents);
  await utimes(join(path, 'entry.bin'), age, age);
  await utimes(path, age, age);
}

function seedPhoto(id: string): void {
  db.prepare(
    `INSERT INTO photos(
       id, title, description, captured_date, status, rotation, offset_x, offset_y,
       request_id, version, created_at, updated_at
     ) VALUES (?, ?, NULL, '2026-01-02', 'published', 0, 0, 0, ?, 1, ?, ?)`,
  ).run(id, `Photo ${id}`, `request-${id}`, now.toISOString(), now.toISOString());
}

function seedSession(index: number, lastActivityAt: string, absoluteExpiresAt: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO admins(id, username, password_hash, created_at, updated_at)
     VALUES ('admin-1', 'admin', 'hash', ?, ?)`,
  ).run(now.toISOString(), now.toISOString());
  db.prepare(
    `INSERT INTO sessions(
       token_hash, admin_id, csrf_hash, created_at, last_activity_at, absolute_expires_at
     ) VALUES (?, 'admin-1', ?, ?, ?, ?)`,
  ).run(`token-${String(index).padStart(4, '0')}`, `csrf-${index}`, now.toISOString(), lastActivityAt, absoluteExpiresAt);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'sweet-memories-maintenance-'));
  roots.push(root);
  mediaRoot = join(root, 'media');
  stagingRoot = join(root, 'staging');
  deletingRoot = join(mediaRoot, '.deleting');
  await Promise.all([mkdir(mediaRoot), mkdir(stagingRoot)]);
  await mkdir(deletingRoot, { mode: 0o700 });
  db = new Database(join(root, 'database.sqlite3'));
  databases.push(db);
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsRoot);
});

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('MaintenanceService', () => {
  it('removes only stale orphan media, staging, deleting entries, and expired sessions', async () => {
    const retainedPhoto = uuid(1);
    const staleOrphan = uuid(2);
    const freshOrphan = uuid(3);
    const boundaryOrphan = uuid(4);
    const staleStaging = uuid(5);
    const staleDeleting = `${uuid(6)}-${uuid(7)}`;
    seedPhoto(retainedPhoto);
    await Promise.all([
      directory(join(mediaRoot, retainedPhoto), stale, 'database media'),
      directory(join(mediaRoot, staleOrphan), stale),
      directory(join(mediaRoot, freshOrphan), fresh),
      directory(join(mediaRoot, boundaryOrphan), exactly24Hours),
      directory(join(stagingRoot, staleStaging), stale),
      directory(join(deletingRoot, staleDeleting), stale),
    ]);
    seedSession(1, '2026-08-31T23:59:59.999Z', '2026-09-08T12:00:00.000Z');
    seedSession(2, '2026-09-01T11:00:00.000Z', '2026-09-01T11:59:59.999Z');
    seedSession(3, '2026-09-01T00:00:00.000Z', '2026-09-08T12:00:00.000Z');
    seedSession(4, '2026-09-01T00:00:00.001Z', '2026-09-08T12:00:00.000Z');
    const service = createMaintenanceService({ db, mediaRoot, stagingRoot, now: () => now });

    await expect(service.run()).resolves.toEqual({
      inspected: 9,
      removedMedia: 1,
      removedStaging: 1,
      removedDeleting: 1,
      expiredSessions: 3,
      failures: 0,
    });

    expect((await readdir(mediaRoot)).sort()).toEqual(
      ['.deleting', retainedPhoto, freshOrphan, boundaryOrphan].sort(),
    );
    expect(await readdir(stagingRoot)).toEqual([]);
    expect(await readdir(deletingRoot)).toEqual([]);
    expect(
      (db.prepare('SELECT token_hash FROM sessions ORDER BY token_hash').all() as Array<{ token_hash: string }>).map(
        ({ token_hash }) => token_hash,
      ),
    ).toEqual(['token-0004']);
  });

  it('never removes an old in-flight delete while its photo row still exists', async () => {
    const id = uuid(50);
    const deleteId = uuid(51);
    const source = join(mediaRoot, id);
    const target = join(deletingRoot, `${id}-${deleteId}`);
    seedPhoto(id);
    await directory(source, stale, 'in-flight media');
    let signalRenamed = (): void => undefined;
    let resumeRename = (): void => undefined;
    const renamed = new Promise<void>((resolve) => { signalRenamed = resolve; });
    const resume = new Promise<void>((resolve) => { resumeRename = resolve; });
    const deletionService = createDeletePhotoService({
      db,
      mediaRoot,
      createUuid: () => deleteId,
      rename: async (from, to) => {
        await rename(from, to);
        await utimes(to, stale, stale);
        signalRenamed();
        await resume;
      },
    });
    const deletion = deletionService.delete({ id, version: 1 });
    const settledDeletion = deletion.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await renamed;
    const maintenance = createMaintenanceService({ db, mediaRoot, stagingRoot, now: () => now });

    const summary = await maintenance.run();
    resumeRename();
    const deletionResult = await settledDeletion;

    expect(summary).toMatchObject({ removedDeleting: 0 });
    expect(deletionResult).toHaveProperty('error');
    expect(db.prepare('SELECT 1 FROM photos WHERE id = ?').get(id)).toBeDefined();
    await expect(readFile(join(source, 'entry.bin'), 'utf8')).resolves.toBe('in-flight media');
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores a stale crash residue when the photo row exists and its source is absent', async () => {
    const id = uuid(52);
    const target = join(deletingRoot, `${id}-${uuid(53)}`);
    seedPhoto(id);
    await directory(target, stale, 'crash residue');
    const service = createMaintenanceService({ db, mediaRoot, stagingRoot, now: () => now });

    const summary = await service.run();

    expect(summary).toMatchObject({ removedDeleting: 0, failures: 0 });
    await expect(readFile(join(mediaRoot, id, 'entry.bin'), 'utf8')).resolves.toBe('crash residue');
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a stale crash residue without overwriting an existing public source', async () => {
    const id = uuid(54);
    const source = join(mediaRoot, id);
    const target = join(deletingRoot, `${id}-${uuid(55)}`);
    seedPhoto(id);
    await directory(source, fresh, 'concurrent source');
    await directory(target, stale, 'private residue');
    const service = createMaintenanceService({ db, mediaRoot, stagingRoot, now: () => now });

    const summary = await service.run();

    expect(summary).toMatchObject({ removedDeleting: 0, failures: 1 });
    await expect(readFile(join(source, 'entry.bin'), 'utf8')).resolves.toBe('concurrent source');
    await expect(readFile(join(target, 'entry.bin'), 'utf8')).resolves.toBe('private residue');
  });

  it('retries a transient crash-recovery rename failure on a later run', async () => {
    const id = uuid(56);
    const target = join(deletingRoot, `${id}-${uuid(57)}`);
    seedPhoto(id);
    await directory(target, stale, 'retry residue');
    let attempts = 0;
    const service = createMaintenanceService({
      db,
      mediaRoot,
      stagingRoot,
      now: () => now,
      rename: async (from, to) => {
        attempts += 1;
        if (attempts === 1) throw new Error('simulated recovery failure');
        await rename(from, to);
      },
    });

    const first = await service.run();
    const second = await service.run();

    expect(first).toMatchObject({ removedDeleting: 0, failures: 1 });
    expect(second).toMatchObject({ removedDeleting: 0, failures: 0 });
    await expect(readFile(join(mediaRoot, id, 'entry.bin'), 'utf8')).resolves.toBe('retry residue');
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not publish a crash residue when its database row disappears during recovery', async () => {
    const id = uuid(58);
    const target = join(deletingRoot, `${id}-${uuid(59)}`);
    seedPhoto(id);
    await directory(target, stale, 'racing residue');
    let renames = 0;
    const service = createMaintenanceService({
      db,
      mediaRoot,
      stagingRoot,
      now: () => now,
      rename: async (from, to) => {
        renames += 1;
        if (renames === 1) {
          db.prepare('DELETE FROM photos WHERE id = ?').run(id);
        }
        await rename(from, to);
      },
    });

    const first = await service.run();

    expect(first).toMatchObject({ removedDeleting: 0, failures: 0 });
    expect(db.prepare('SELECT 1 FROM photos WHERE id = ?').get(id)).toBeUndefined();
    await expect(stat(join(mediaRoot, id))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(target, 'entry.bin'), 'utf8')).resolves.toBe('racing residue');

    const second = await service.run();
    expect(second).toMatchObject({ removedDeleting: 1, failures: 0 });
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite a source populated concurrently after recovery reservation', async () => {
    const id = uuid(60);
    const source = join(mediaRoot, id);
    const target = join(deletingRoot, `${id}-${uuid(61)}`);
    seedPhoto(id);
    await directory(target, stale, 'reserved residue');
    const service = createMaintenanceService({
      db,
      mediaRoot,
      stagingRoot,
      now: () => now,
      rename: async (from, to) => {
        await writeFile(join(to, 'competitor.bin'), 'concurrent media');
        await rename(from, to);
      },
    });

    const summary = await service.run();

    expect(summary).toMatchObject({ removedDeleting: 0, failures: 1 });
    await expect(readFile(join(source, 'competitor.bin'), 'utf8')).resolves.toBe('concurrent media');
    await expect(readFile(join(target, 'entry.bin'), 'utf8')).resolves.toBe('reserved residue');
  });

  it('re-quarantines a deleting target replaced immediately before recovery rename', async () => {
    const id = uuid(62);
    const source = join(mediaRoot, id);
    const target = join(deletingRoot, `${id}-${uuid(63)}`);
    seedPhoto(id);
    await directory(target, stale, 'original residue');
    let renames = 0;
    const service = createMaintenanceService({
      db,
      mediaRoot,
      stagingRoot,
      now: () => now,
      rename: async (from, to) => {
        renames += 1;
        if (renames === 1) {
          await rm(from, { recursive: true, force: false });
          await directory(from, fresh, 'replacement residue');
        }
        await rename(from, to);
      },
    });

    const summary = await service.run();

    expect(summary).toMatchObject({ removedDeleting: 0, failures: 1 });
    await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(target, 'entry.bin'), 'utf8')).resolves.toBe('replacement residue');
  });

  it('retains a deleting tree containing a special file without following or removing it', async () => {
    const id = uuid(64);
    const target = join(deletingRoot, `${id}-${uuid(65)}`);
    const fifoPath = join(target, 'media.fifo');
    seedPhoto(id);
    await mkdir(target);
    execFileSync('/usr/bin/mkfifo', [fifoPath]);
    await utimes(target, stale, stale);
    const service = createMaintenanceService({ db, mediaRoot, stagingRoot, now: () => now });

    const summary = await service.run();

    expect(summary).toMatchObject({ removedDeleting: 0, failures: 1 });
    await expect(stat(target)).resolves.toBeDefined();
  });

  it('uses one explicit budget of at most 100 across all filesystem scans and SQL items', async () => {
    for (let index = 1; index <= 40; index += 1) {
      await directory(join(mediaRoot, uuid(100 + index)), stale);
      await directory(join(stagingRoot, uuid(200 + index)), stale);
      await directory(join(deletingRoot, `${uuid(300 + index)}-${uuid(400 + index)}`), stale);
      seedSession(index, '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z');
    }
    const remove = vi.fn<RemoveMaintenanceTree>(async () => undefined);
    const service = createMaintenanceService({ db, mediaRoot, stagingRoot, now: () => now, remove });

    const summary = await service.run();

    expect(MAINTENANCE_BUDGET).toBe(100);
    expect(summary.inspected).toBe(MAINTENANCE_BUDGET);
    expect(remove).toHaveBeenCalledTimes(75);
    expect(summary.expiredSessions).toBe(25);
    expect(summary.removedMedia + summary.removedStaging + summary.removedDeleting + summary.expiredSessions)
      .toBe(MAINTENANCE_BUDGET);
  });

  it('orders each bounded source deterministically before using its 25-item share', async () => {
    const names = Array.from({ length: 30 }, (_, index) => uuid(900 - index));
    for (const name of names) {
      await directory(join(stagingRoot, name), stale);
    }
    const removed: string[] = [];
    const service = createMaintenanceService({
      db,
      mediaRoot,
      stagingRoot,
      now: () => now,
      remove: async (path) => { removed.push(path); },
    });

    await service.run();

    expect(removed).toEqual(names.slice().sort().slice(0, 25).map((name) => join(stagingRoot, name)));
  });

  it('rotates past 25 fresh staging entries so a later stale entry is inspected next run', async () => {
    const freshNames = Array.from({ length: 25 }, (_, index) => uuid(500 + index));
    const staleName = uuid(525);
    for (const name of freshNames) {
      await directory(join(stagingRoot, name), fresh);
    }
    await directory(join(stagingRoot, staleName), stale);
    const service = createMaintenanceService({ db, mediaRoot, stagingRoot, now: () => now });

    const first = await service.run();
    const second = await service.run();

    expect(first).toMatchObject({ inspected: 25, removedStaging: 0 });
    expect(second).toMatchObject({ inspected: 25, removedStaging: 1 });
    await expect(stat(join(stagingRoot, staleName))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const name of freshNames) {
      await expect(stat(join(stagingRoot, name))).resolves.toBeDefined();
    }
  });

  it('rotates past 25 database-owned media entries so a later stale orphan is inspected', async () => {
    const retainedNames = Array.from({ length: 25 }, (_, index) => uuid(600 + index));
    const orphanName = uuid(625);
    for (const name of retainedNames) {
      seedPhoto(name);
      await directory(join(mediaRoot, name), stale);
    }
    await directory(join(mediaRoot, orphanName), stale);
    const service = createMaintenanceService({ db, mediaRoot, stagingRoot, now: () => now });

    const first = await service.run();
    const second = await service.run();

    expect(first).toMatchObject({ inspected: 25, removedMedia: 0 });
    expect(second).toMatchObject({ inspected: 25, removedMedia: 1 });
    await expect(stat(join(mediaRoot, orphanName))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const name of retainedNames) {
      await expect(stat(join(mediaRoot, name))).resolves.toBeDefined();
    }
  });

  it('rotates past 25 failed expired-session deletions so later sessions are attempted', async () => {
    for (let index = 1; index <= 30; index += 1) {
      seedSession(index, '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z');
    }
    db.exec(`
      CREATE TEMP TRIGGER retain_first_expired_sessions BEFORE DELETE ON sessions
      WHEN OLD.token_hash <= 'token-0025'
      BEGIN SELECT RAISE(FAIL, 'simulated row failure'); END;
    `);
    const service = createMaintenanceService({ db, mediaRoot, stagingRoot, now: () => now });

    const first = await service.run();
    const second = await service.run();

    expect(first).toMatchObject({ inspected: 25, expiredSessions: 0, failures: 25 });
    expect(second).toMatchObject({ inspected: 25, expiredSessions: 5 });
    expect(
      (db.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count,
    ).toBe(25);
  });

  it('does not follow or remove symlinks, special entries, or noncanonical names', async () => {
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside survives');
    await symlink(outside, join(mediaRoot, uuid(10)));
    await symlink(outside, join(stagingRoot, uuid(11)));
    await symlink(outside, join(deletingRoot, `${uuid(12)}-${uuid(13)}`));
    await directory(join(mediaRoot, 'not-a-photo-id'), stale);
    await directory(join(stagingRoot, 'not-a-staging-id'), stale);
    await directory(join(deletingRoot, 'not-a-delete-id'), stale);
    const service = createMaintenanceService({ db, mediaRoot, stagingRoot, now: () => now });

    const summary = await service.run();

    expect(summary).toMatchObject({ removedMedia: 0, removedStaging: 0, removedDeleting: 0 });
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside survives');
    expect(summary.failures).toBeGreaterThanOrEqual(3);
  });

  it('fails one unsafe nested tree closed but continues with later entries', async () => {
    const unsafe = uuid(20);
    const safe = uuid(21);
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside survives');
    await mkdir(join(stagingRoot, unsafe));
    await symlink(outside, join(stagingRoot, unsafe, 'link'));
    await utimes(join(stagingRoot, unsafe), stale, stale);
    await directory(join(stagingRoot, safe), stale);
    const service = createMaintenanceService({ db, mediaRoot, stagingRoot, now: () => now });

    const summary = await service.run();

    expect(summary).toMatchObject({ removedStaging: 1, failures: 1 });
    await expect(stat(join(stagingRoot, unsafe))).resolves.toBeDefined();
    await expect(stat(join(stagingRoot, safe))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside survives');
  });

  it('continues after a single removal failure and returns only safe aggregate counts', async () => {
    const first = uuid(30);
    const second = uuid(31);
    await directory(join(stagingRoot, first), stale);
    await directory(join(stagingRoot, second), stale);
    let calls = 0;
    const { rm } = await import('node:fs/promises');
    const service = createMaintenanceService({
      db,
      mediaRoot,
      stagingRoot,
      now: () => now,
      remove: async (path, options) => {
        if (++calls === 1) throw new Error(`private ${path}`);
        await rm(path, options);
      },
    });

    const summary = await service.run();

    expect(summary).toEqual({
      inspected: 2,
      removedMedia: 0,
      removedStaging: 1,
      removedDeleting: 0,
      expiredSessions: 0,
      failures: 1,
    });
    expect(JSON.stringify(summary)).not.toContain(root);
  });

  it('fails closed without scanning when a configured root is a symlink', async () => {
    const actualStaging = join(root, 'actual-staging');
    const alias = join(root, 'staging-alias');
    await mkdir(actualStaging);
    await directory(join(actualStaging, uuid(40)), stale);
    await symlink(actualStaging, alias);
    const service = createMaintenanceService({ db, mediaRoot, stagingRoot: alias, now: () => now });

    await expect(service.run()).rejects.toMatchObject({ code: 'UNSAFE_MAINTENANCE_ROOT' });

    await expect(stat(join(actualStaging, uuid(40)))).resolves.toBeDefined();
  });
});
