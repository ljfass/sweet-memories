// @vitest-environment node

import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

function createSharedDatabases(): readonly [Database.Database, Database.Database] {
  const path = join(temporaryRoot('sweet-memories-shared-migration-db-'), 'db.sqlite3');
  const first = new Database(path);
  databases.push(first);
  first.pragma('foreign_keys = ON');
  first.pragma('journal_mode = WAL');
  first.pragma('busy_timeout = 1');
  runMigrations(first, migrationsRoot);
  const second = new Database(path);
  databases.push(second);
  second.pragma('foreign_keys = ON');
  second.pragma('journal_mode = WAL');
  second.pragma('busy_timeout = 1');
  return [first, second];
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

  it('resumes an individual UUID directory containing only an exact expected file subset', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    const firstId = '9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1';
    const target = join(options.mediaRoot, firstId);
    mkdirSync(target, { mode: 0o700 });
    copyFileSync(join(seedRoot, 'media', firstId, '320.jpg'), join(target, '320.jpg'));

    await expect(importLegacyPhotos(options)).resolves.toEqual({ imported: 5, reused: 0 });
    expect(readdirSync(target).sort()).toEqual([
      '320.avif', '320.jpg', '320.webp',
      '640.avif', '640.jpg', '640.webp',
      '960.avif', '960.jpg', '960.webp',
      'master.jpg',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM photos').get()).toEqual({ count: 5 });
  });

  it('normalizes verified adopted directory and file permissions before import', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    cpSync(join(seedRoot, 'media'), options.mediaRoot, { recursive: true });
    const firstId = '9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1';
    const target = join(options.mediaRoot, firstId);
    chmodSync(target, 0o700);
    for (const name of readdirSync(target)) chmodSync(join(target, name), 0o600);

    await importLegacyPhotos(options);

    expect(statSync(target).mode & 0o777).toBe(0o750);
    for (const name of readdirSync(target)) {
      expect(statSync(join(target, name)).mode & 0o777).toBe(0o640);
    }
  });

  it('removes a strictly named abandoned private temp copy and completes an empty fixed directory', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    const firstId = '9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1';
    mkdirSync(join(options.mediaRoot, firstId), { mode: 0o700 });
    const abandoned = join(
      options.mediaRoot,
      '.legacy-import-11111111-1111-4111-8111-111111111111',
    );
    mkdirSync(abandoned, { mode: 0o700 });
    const temporaryFile = join(abandoned, `${firstId}-320.jpg.tmp`);
    writeFileSync(temporaryFile, 'interrupted copy', { mode: 0o600 });

    await expect(importLegacyPhotos(options)).resolves.toEqual({ imported: 5, reused: 0 });
    expect(readdirSync(join(options.mediaRoot, firstId))).toHaveLength(10);
    expect(existsSync(abandoned)).toBe(false);
  });

  it('fails closed without deleting a symlinked or special interrupted temp node', async () => {
    const symlinkDb = createDatabase();
    const symlinkOptions = migrationOptions(symlinkDb);
    const outside = join(temporaryRoot('sweet-memories-temp-outside-'), 'outside');
    mkdirSync(outside);
    const symlinked = join(
      symlinkOptions.mediaRoot,
      '.legacy-import-22222222-2222-4222-8222-222222222222',
    );
    symlinkSync(outside, symlinked);

    await expect(importLegacyPhotos(symlinkOptions)).rejects.toThrow();
    expect(lstatSync(symlinked).isSymbolicLink()).toBe(true);

    const specialDb = createDatabase();
    const specialOptions = migrationOptions(specialDb);
    const specialRoot = join(
      specialOptions.mediaRoot,
      '.legacy-import-33333333-3333-4333-8333-333333333333',
    );
    mkdirSync(specialRoot, { mode: 0o700 });
    const fifo = join(
      specialRoot,
      '9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1-320.jpg.tmp',
    );
    const madeFifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    expect(madeFifo.status, madeFifo.stderr).toBe(0);

    await expect(importLegacyPhotos(specialOptions)).rejects.toThrow();
    expect(lstatSync(fifo).isFIFO()).toBe(true);
  });

  it('can rerun after a copy interruption without deleting a pre-existing exact subset', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    const firstId = '9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1';
    const target = join(options.mediaRoot, firstId);
    mkdirSync(target, { mode: 0o700 });
    const adopted = join(target, '320.jpg');
    copyFileSync(join(seedRoot, 'media', firstId, '320.jpg'), adopted);
    const adoptedInode = statSync(adopted).ino;
    let interrupted = false;

    await expect(importLegacyPhotos({
      ...options,
      fileOperations: {
        copyFile(source: string, destination: string): void {
          if (!interrupted) {
            interrupted = true;
            writeFileSync(destination, 'partial temp');
            throw new Error('simulated copy interruption');
          }
          copyFileSync(source, destination, constants.COPYFILE_EXCL);
        },
      },
    })).rejects.toThrow();
    expect(statSync(adopted).ino).toBe(adoptedInode);
    expect(readdirSync(target)).toEqual(['320.jpg']);

    await expect(importLegacyPhotos(options)).resolves.toEqual({ imported: 5, reused: 0 });
    expect(readdirSync(target)).toHaveLength(10);
  });

  it('adopts an exact file that wins the no-replace publish race', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    let raced = false;
    const link = vi.fn((source: string, destination: string) => {
      if (!raced) {
        raced = true;
        const fileName = destination.split('/').at(-1) as string;
        const photoId = destination.split('/').at(-2) as string;
        copyFileSync(join(seedRoot, 'media', photoId, fileName), destination, constants.COPYFILE_EXCL);
      }
      linkSync(source, destination);
    });

    await expect(importLegacyPhotos({
      ...options,
      fileOperations: { link },
    })).resolves.toEqual({ imported: 5, reused: 0 });
    expect(link).toHaveBeenCalled();
  });

  it('removes only this attempt files after chmod failure and then reruns cleanly', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    const firstId = '9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1';
    const target = join(options.mediaRoot, firstId);
    mkdirSync(target, { mode: 0o700 });
    const adopted = join(target, '320.jpg');
    copyFileSync(join(seedRoot, 'media', firstId, '320.jpg'), adopted);
    const adoptedInode = statSync(adopted).ino;
    let failed = false;

    await expect(importLegacyPhotos({
      ...options,
      fileOperations: {
        chmod(path: string, mode: number): void {
          if (!failed && path.endsWith('640.avif')) {
            failed = true;
            throw new Error('simulated chmod failure');
          }
          chmodSync(path, mode);
        },
      },
    })).rejects.toThrow();
    expect(statSync(adopted).ino).toBe(adoptedInode);
    expect(readdirSync(target)).toEqual(['320.jpg']);

    await expect(importLegacyPhotos(options)).resolves.toEqual({ imported: 5, reused: 0 });
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

  it('serializes media ownership across two database connections in either winner order', async () => {
    const lastPhotoId = 'c9608cd6-3480-43fb-84ab-623899262ff9';
    for (const winnerIndex of [0, 1]) {
      const connections = createSharedDatabases();
      const mediaRoot = temporaryRoot(`sweet-memories-concurrent-media-${winnerIndex}-`);
      const winner = connections[winnerIndex] as Database.Database;
      const contender = connections[1 - winnerIndex] as Database.Database;
      const contenderOptions = { db: contender, seedRoot, mediaRoot };
      let contenderAttempt: ReturnType<typeof importLegacyPhotos> | undefined;
      let triggered = false;

      await expect(importLegacyPhotos({
        db: winner,
        seedRoot,
        mediaRoot,
        fileOperations: {
          chmod(path: string, mode: number): void {
            chmodSync(path, mode);
            if (!triggered && path.endsWith(`/${lastPhotoId}`) && mode === 0o750) {
              triggered = true;
              contenderAttempt = importLegacyPhotos(contenderOptions);
            }
          },
        },
      })).resolves.toEqual({ imported: 5, reused: 0 });

      expect(contenderAttempt).toBeDefined();
      await expect(contenderAttempt).rejects.toThrow(/busy|locked/iu);
      await expect(importLegacyPhotos(contenderOptions)).resolves.toEqual({ imported: 0, reused: 5 });
      expect(winner.prepare('SELECT COUNT(*) AS count FROM photos').get()).toEqual({ count: 5 });
      expect(contender.prepare('SELECT COUNT(*) AS count FROM photo_assets').get())
        .toEqual({ count: 50 });
      expect(readdirSync(mediaRoot).filter((name) => name.startsWith('.legacy-import-')))
        .toEqual([]);
      for (const name of readdirSync(mediaRoot)) {
        expect(readdirSync(join(mediaRoot, name))).toHaveLength(10);
      }
    }
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

  it('rejects stored metadata outside the canonical admin edit contract without activation', async () => {
    const db = createDatabase();
    const options = migrationOptions(db);
    await importLegacyPhotos(options);
    datesReady(db);
    const targetRequest = 'legacy-photo-2';
    const canonical = (): void => {
      db.prepare(
        `UPDATE photos SET title = '规范标题', description = '规范描述',
                           captured_date = '2024-01-02', version = 7
         WHERE request_id = ?`,
      ).run(targetRequest);
    };
    const probes: readonly (() => void)[] = [
      () => db.prepare('UPDATE photos SET title = ? WHERE request_id = ?')
        .run('Cafe\u0301', targetRequest),
      () => db.prepare('UPDATE photos SET description = ? WHERE request_id = ?')
        .run('描述 ', targetRequest),
      () => db.prepare('UPDATE photos SET title = ? WHERE request_id = ?')
        .run('标题\u0000尾部', targetRequest),
      () => db.prepare('UPDATE photos SET version = ? WHERE request_id = ?')
        .run(Number.MAX_SAFE_INTEGER + 1, targetRequest),
      () => {
        db.pragma('ignore_check_constraints = ON');
        db.prepare('UPDATE photos SET title = ? WHERE request_id = ?')
          .run('x'.repeat(121), targetRequest);
        db.pragma('ignore_check_constraints = OFF');
      },
    ];

    for (const probe of probes) {
      canonical();
      probe();
      await expect(checkLegacyReadiness(options)).rejects.toThrow();
      await expect(activateLegacyPhotos(options)).rejects.toThrow();
      expect(listPublicPhotoRecords(db)).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM photos WHERE status = 'published'").get())
        .toEqual({ count: 0 });
    }
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
