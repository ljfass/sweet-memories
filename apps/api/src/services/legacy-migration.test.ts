// @vitest-environment node

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runCli, type CliRuntime } from '../cli.js';
import { runMigrations } from '../migrations.js';
import { listPublicPhotoRecords } from '../repositories/photos.js';
import { migrationHelp, runMigrationCommand } from '../cli/migration.js';
import {
  activateLegacyPhotos,
  checkLegacyReadiness,
  getUploadsEnabled,
  importLegacyPhotos,
  setUploadsEnabled,
} from './legacy-migration.js';

const apiRoot = resolve(import.meta.dirname, '../..');
const repositoryRoot = resolve(apiRoot, '../..');
const migrationsRoot = join(apiRoot, 'migrations');
const seedScriptPath = join(repositoryRoot, 'scripts/api/prepare-legacy-seed.mjs');
const builtCliPath = join(apiRoot, 'dist/cli.js');
const roots: string[] = [];
const databases: Database.Database[] = [];
let seedRoot: string;

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function createDatabase(): Database.Database {
  const db = new Database(join(temporaryRoot('sweet-memories-migration-db-'), 'db.sqlite3'));
  databases.push(db);
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsRoot);
  return db;
}

function datesReady(db: Database.Database, date = '2024-01-02'): void {
  db.prepare("UPDATE photos SET captured_date = ? WHERE request_id LIKE 'legacy-photo-%'").run(date);
}

function migrationOptions(db: Database.Database) {
  return { db, seedRoot, mediaRoot: temporaryRoot('sweet-memories-migration-media-') };
}

beforeAll(() => {
  seedRoot = temporaryRoot('sweet-memories-built-seed-');
  const result = spawnSync(process.execPath, [seedScriptPath, '--output', seedRoot], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`无法构建迁移测试 seed: ${result.stdout}${result.stderr}`);
  }
});

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('legacy migration service', () => {
  it('imports the fixed five photos once as migration_pending with stable identity and media', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);

    await expect(importLegacyPhotos(options)).resolves.toEqual({ imported: 5, reused: 0 });
    await expect(importLegacyPhotos(options)).resolves.toEqual({ imported: 0, reused: 5 });

    const photos = db.prepare(
      `SELECT id, request_id, status, captured_date, created_at, updated_at
       FROM photos ORDER BY created_at`,
    ).all() as Array<Record<string, unknown>>;
    expect(photos).toHaveLength(5);
    expect(photos.map((photo) => photo.request_id)).toEqual([
      'legacy-photo-1', 'legacy-photo-2', 'legacy-photo-3', 'legacy-photo-4', 'legacy-photo-5',
    ]);
    expect(photos.map((photo) => photo.created_at)).toEqual([
      '2000-01-01T00:00:01.000Z', '2000-01-01T00:00:02.000Z',
      '2000-01-01T00:00:03.000Z', '2000-01-01T00:00:04.000Z',
      '2000-01-01T00:00:05.000Z',
    ]);
    expect(photos.every((photo) => photo.status === 'migration_pending')).toBe(true);
    expect(photos.every((photo) => photo.captured_date === null)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM photo_assets').get()).toEqual({ count: 50 });
    expect(listPublicPhotoRecords(db)).toEqual([]);
    expect(getUploadsEnabled(db)).toBe(false);
  });

  it('reuses imports after preserving administrator metadata and version edits', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    await importLegacyPhotos(options);
    datesReady(db);
    db.prepare(
      `UPDATE photos
       SET title = '管理员修改的标题', description = '管理员修改的描述', version = 7
       WHERE request_id = 'legacy-photo-2'`,
    ).run();

    await expect(importLegacyPhotos(options)).resolves.toEqual({ imported: 0, reused: 5 });
    expect(db.prepare(
      "SELECT title, description, captured_date, version FROM photos WHERE request_id = 'legacy-photo-2'",
    ).get()).toEqual({
      title: '管理员修改的标题',
      description: '管理员修改的描述',
      captured_date: '2024-01-02',
      version: 7,
    });
    await expect(checkLegacyReadiness(options)).resolves.toEqual({ ready: true, photoCount: 5 });

    db.prepare("UPDATE photos SET title = '　 ' WHERE request_id = 'legacy-photo-2'").run();
    await expect(checkLegacyReadiness(options)).rejects.toThrow();
  });

  it('safely resumes complete or partial exact seed media left before the database commit', async () => {
    const firstDb = createDatabase();
    const completeOptions = migrationOptions(firstDb);
    cpSync(join(seedRoot, 'media'), completeOptions.mediaRoot, { recursive: true });

    await expect(importLegacyPhotos(completeOptions)).resolves.toEqual({ imported: 5, reused: 0 });
    expect(firstDb.prepare('SELECT COUNT(*) AS count FROM photos').get()).toEqual({ count: 5 });

    const secondDb = createDatabase();
    const partialOptions = migrationOptions(secondDb);
    const firstIds = [
      '9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1',
      '58efb95e-2a98-45be-bbe4-acde6c34f7cd',
    ];
    for (const id of firstIds) {
      cpSync(join(seedRoot, 'media', id), join(partialOptions.mediaRoot, id), { recursive: true });
    }

    await expect(importLegacyPhotos(partialOptions)).resolves.toEqual({ imported: 5, reused: 0 });
    expect(secondDb.prepare('SELECT COUNT(*) AS count FROM photos').get()).toEqual({ count: 5 });
  });

  it('fails closed without deleting pre-existing orphan media when its contents drift', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    const firstId = '9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1';
    const target = join(options.mediaRoot, firstId);
    cpSync(join(seedRoot, 'media', firstId), target, { recursive: true });
    writeFileSync(join(target, 'unexpected.txt'), 'do not delete');

    await expect(importLegacyPhotos(options)).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM photos').get()).toEqual({ count: 0 });
    expect(readFileSync(join(target, 'unexpected.txt'), 'utf8')).toBe('do not delete');
  });

  it('fails closed before media or database mutation on conflicting ids and request ids', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    db.prepare(
      `INSERT INTO photos(
         id, title, description, captured_date, status, rotation, offset_x, offset_y,
         request_id, version, created_at, updated_at
       ) VALUES (?, 'conflict', NULL, NULL, 'migration_pending', 0, 0, 0,
                 'legacy-photo-1', 1, ?, ?)`,
    ).run('unrelated-id', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');

    await expect(importLegacyPhotos(options)).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM photos').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM photo_assets').get()).toEqual({ count: 0 });
    expect(readFileSync(join(seedRoot, 'media-manifest.json'), 'utf8')).toContain('9a9a60f7');
  });

  it('compensates media publication when the database transaction fails', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    db.exec(`CREATE TRIGGER reject_legacy BEFORE INSERT ON photos
             BEGIN SELECT RAISE(ABORT, 'private database detail'); END;`);

    await expect(importLegacyPhotos(options)).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM photos').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM photo_assets').get()).toEqual({ count: 0 });
    expect((await import('node:fs/promises')).readdir(options.mediaRoot)).resolves.toEqual([]);
  });

  it('requires complete exact metadata, valid dates, expected ordering, and verified media', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    await importLegacyPhotos(options);

    await expect(checkLegacyReadiness(options)).rejects.toThrow();
    datesReady(db);
    await expect(checkLegacyReadiness(options)).resolves.toEqual({ ready: true, photoCount: 5 });

    db.prepare("UPDATE photos SET captured_date = '2023-02-29' WHERE request_id = 'legacy-photo-2'").run();
    await expect(checkLegacyReadiness(options)).rejects.toThrow();
    db.prepare("UPDATE photos SET captured_date = '2024-01-02' WHERE request_id = 'legacy-photo-2'").run();
    db.prepare("UPDATE photos SET created_at = '1999-01-01T00:00:00.000Z' WHERE request_id = 'legacy-photo-5'").run();
    await expect(checkLegacyReadiness(options)).rejects.toThrow();
  });

  it('ignores unrelated records but rejects missing, extra, unsafe, or drifted legacy media', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    await importLegacyPhotos(options);
    datesReady(db);
    db.prepare(
      `INSERT INTO photos(
         id, title, description, captured_date, status, rotation, offset_x, offset_y,
         request_id, version, created_at, updated_at
       ) VALUES ('other', 'Other', NULL, '2024-01-01', 'published', 0, 0, 0,
                 'other-request', 1, '1990-01-01T00:00:00.000Z', '1990-01-01T00:00:00.000Z')`,
    ).run();
    await expect(checkLegacyReadiness(options)).resolves.toEqual({ ready: true, photoCount: 5 });

    const firstId = '9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1';
    writeFileSync(join(options.mediaRoot, firstId, '320.jpg'), 'drift');
    await expect(checkLegacyReadiness(options)).rejects.toThrow();
  });

  it('activates exactly the fixed five idempotently without changing uploads', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    await importLegacyPhotos(options);
    datesReady(db);

    await expect(activateLegacyPhotos(options)).resolves.toEqual({ activated: 5 });
    await expect(activateLegacyPhotos(options)).resolves.toEqual({ activated: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM photos WHERE status = 'published'").get())
      .toEqual({ count: 5 });
    expect(getUploadsEnabled(db)).toBe(false);
    expect(listPublicPhotoRecords(db)).toHaveLength(5);
  });

  it('keeps upload status as a separate idempotent setting command', () => {
    const db = createDatabase();
    expect(setUploadsEnabled(db, true, '2026-09-01T00:00:00.000Z')).toBe(true);
    expect(setUploadsEnabled(db, true, '2026-09-01T00:00:01.000Z')).toBe(true);
    expect(getUploadsEnabled(db)).toBe(true);
    expect(setUploadsEnabled(db, false, '2026-09-01T00:00:02.000Z')).toBe(false);
    expect(getUploadsEnabled(db)).toBe(false);
  });
});

describe('migration CLI commands', () => {
  it('exposes exact migration and upload commands with stable nonsecret output', async () => {
    const db = createDatabase();
    const mediaRoot = temporaryRoot('sweet-memories-cli-media-');
    const outputText: string[] = [];
    const output = { write: (text: string) => outputText.push(text) };
    const invoke = (argv: readonly string[]) => runMigrationCommand({
      argv, db, seedRoot, mediaRoot, output, now: () => '2026-09-01T00:00:00.000Z',
    });

    await expect(invoke(['migration', 'import-legacy'])).resolves.toBe(0);
    await expect(invoke(['migration', 'check-ready'])).resolves.toBe(1);
    datesReady(db);
    await expect(invoke(['migration', 'check-ready'])).resolves.toBe(0);
    await expect(invoke(['migration', 'activate'])).resolves.toBe(0);
    await expect(invoke(['uploads', 'status'])).resolves.toBe(0);
    await expect(invoke(['uploads', 'enable'])).resolves.toBe(0);
    await expect(invoke(['uploads', 'disable'])).resolves.toBe(0);
    expect(outputText.join('')).not.toContain(seedRoot);
    expect(outputText.join('')).not.toContain(mediaRoot);
  });

  it('routes migration commands through the database lifecycle and closes it', async () => {
    const close = vi.fn();
    const db = { close } as unknown as Database.Database;
    const command = vi.fn(async () => 0);
    const runtime = {
      input: { argv: [], readLine: vi.fn(async () => '') },
      output: { write: vi.fn() },
      hiddenInput: { read: vi.fn(async () => '') },
      loadConfig: vi.fn(() => ({ migrationsRoot: '/migrations', mediaRoot: '/media' })),
      openDatabase: vi.fn(() => db),
      runMigrations: vi.fn(),
      runAdminCommand: vi.fn(async () => 9),
      runMigrationCommand: command,
      seedRoot: '/seed',
      now: () => '2026-09-01T00:00:00.000Z',
      randomId: () => 'unused',
    } as unknown as CliRuntime;

    await expect(runCli(['migration', 'import-legacy'], runtime)).resolves.toBe(0);
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['migration', 'import-legacy'], db, seedRoot: '/seed', mediaRoot: '/media',
    }));
    expect(runtime.runAdminCommand).not.toHaveBeenCalled();
    expect(runtime.runMigrations).toHaveBeenCalledWith(db, '/migrations');
    expect(close).toHaveBeenCalledOnce();
  });

  it('routes unknown migration namespaces to fixed help without opening a database', async () => {
    const output = { write: vi.fn() };
    const runtime = {
      input: { argv: [], readLine: vi.fn(async () => '') },
      output,
      hiddenInput: { read: vi.fn(async () => '') },
      loadConfig: vi.fn(),
      openDatabase: vi.fn(),
      runMigrations: vi.fn(),
      runAdminCommand: vi.fn(async () => 9),
      now: () => '2026-09-01T00:00:00.000Z',
      randomId: () => 'unused',
    } as unknown as CliRuntime;

    await expect(runCli(['migration', 'unknown'], runtime)).resolves.toBe(1);
    expect(output.write).toHaveBeenCalledWith(migrationHelp);
    expect(runtime.runAdminCommand).not.toHaveBeenCalled();
    expect(runtime.openDatabase).not.toHaveBeenCalled();
  });

  it('keeps real CLI help and invalid management output stable without exposing paths', () => {
    const build = spawnSync('pnpm', ['--dir', apiRoot, 'build'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);
    const dataRoot = join(temporaryRoot('sweet-memories-real-migration-cli-'), 'data');
    const environment = { ...process.env, SWEET_MEMORIES_DATA_ROOT: dataRoot };

    const help = spawnSync(process.execPath, [builtCliPath, '--help'], {
      cwd: repositoryRoot,
      env: environment,
      encoding: 'utf8',
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('sweet-memories admin create');
    expect(help.stdout).not.toContain(repositoryRoot);

    const invalid = spawnSync(process.execPath, [builtCliPath, 'uploads', 'unknown'], {
      cwd: repositoryRoot,
      env: environment,
      encoding: 'utf8',
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe(migrationHelp);
    expect(invalid.stdout).not.toContain(repositoryRoot);
    expect(invalid.stderr).toBe('');
    expect(existsSync(dataRoot)).toBe(false);
  });
});
