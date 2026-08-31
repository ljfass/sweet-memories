// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { runMigrations } from './migrations.js';

const initialMigrationsRoot = resolve(import.meta.dirname, '../migrations');
const temporaryRoots: string[] = [];
const openDatabases: Database.Database[] = [];

function createTemporaryRoot(prefix = 'sweet-memories-database-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function createDatabase() {
  const dataRoot = createTemporaryRoot();
  const config = loadConfig({
    NODE_ENV: 'test',
    SWEET_MEMORIES_DATA_ROOT: dataRoot,
    SWEET_MEMORIES_MIGRATIONS_ROOT: initialMigrationsRoot,
  });
  const db = openDatabase(config);
  openDatabases.push(db);
  return { config, db };
}

function writeMigration(root: string, name: string, sql: string): void {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, sql, 'utf8');
}

function migrationVersions(db: Database.Database): string[] {
  return db
    .prepare('SELECT version FROM schema_migrations ORDER BY rowid')
    .all()
    .map((row) => (row as { version: string }).version);
}

function columnDefinitions(
  db: Database.Database,
  table: string,
): Array<{ name: string; type: string; defaultValue: string | null }> {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      type: string;
      dflt_value: string | null;
    }>
  ).map(({ name, type, dflt_value: defaultValue }) => ({ name, type, defaultValue }));
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    db.close();
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('openDatabase', () => {
  it('creates data directories and enables durable SQLite settings', () => {
    const dataRoot = createTemporaryRoot();
    const config = loadConfig({
      NODE_ENV: 'test',
      SWEET_MEMORIES_DATA_ROOT: dataRoot,
      SWEET_MEMORIES_MIGRATIONS_ROOT: initialMigrationsRoot,
      SWEET_MEMORIES_DATABASE_PATH: join(dataRoot, 'database', 'app.sqlite3'),
    });

    const db = openDatabase(config);
    openDatabases.push(db);

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    for (const path of [
      config.dataRoot,
      config.mediaRoot,
      config.stagingRoot,
      config.backupRoot,
      dirname(config.databasePath),
    ]) {
      expect(() => mkdirSync(path, { recursive: false })).toThrow();
    }
  });
});

describe('runMigrations', () => {
  it('builds the complete initial schema in an empty database', () => {
    const { db } = createDatabase();

    runMigrations(db, initialMigrationsRoot);

    const objects = db
      .prepare(
        `SELECT type, name FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all() as Array<{ type: string; name: string }>;
    expect(objects.filter(({ type }) => type === 'table').map(({ name }) => name)).toEqual([
      'admins',
      'login_attempts',
      'photo_assets',
      'photos',
      'schema_migrations',
      'sessions',
      'settings',
    ]);
    expect(objects.filter(({ type }) => type === 'index').map(({ name }) => name)).toEqual([
      'photos_public_order_idx',
      'sessions_admin_id_idx',
    ]);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'uploads_enabled'").get()).toEqual({
      value: 'false',
    });
    expect(columnDefinitions(db, 'admins')).toContainEqual({
      name: 'id',
      type: 'TEXT',
      defaultValue: null,
    });
    expect(columnDefinitions(db, 'sessions')).toContainEqual({
      name: 'admin_id',
      type: 'TEXT',
      defaultValue: null,
    });
    expect(columnDefinitions(db, 'login_attempts')).toContainEqual({
      name: 'failure_count',
      type: 'INTEGER',
      defaultValue: null,
    });
    expect(columnDefinitions(db, 'photos')).toEqual(
      expect.arrayContaining([
        { name: 'id', type: 'TEXT', defaultValue: null },
        { name: 'rotation', type: 'INTEGER', defaultValue: null },
        { name: 'offset_x', type: 'INTEGER', defaultValue: null },
        { name: 'offset_y', type: 'INTEGER', defaultValue: null },
        { name: 'version', type: 'INTEGER', defaultValue: '1' },
      ]),
    );
    expect(columnDefinitions(db, 'photo_assets')).toContainEqual({
      name: 'photo_id',
      type: 'TEXT',
      defaultValue: null,
    });
    expect(migrationVersions(db)).toEqual(['001']);
  });

  it('does not change migration versions when run repeatedly', () => {
    const { db } = createDatabase();

    runMigrations(db, initialMigrationsRoot);
    const first = db.prepare('SELECT version, applied_at FROM schema_migrations').all();
    runMigrations(db, initialMigrationsRoot);

    expect(db.prepare('SELECT version, applied_at FROM schema_migrations').all()).toEqual(first);
  });

  it('accepts only NNN_name.sql files and applies them in numeric filename order', () => {
    const { db } = createDatabase();
    const migrationsRoot = createTemporaryRoot('sweet-memories-migrations-');
    writeMigration(
      migrationsRoot,
      '010_finish.sql',
      "INSERT INTO migration_order(step) VALUES ('010');",
    );
    writeMigration(
      migrationsRoot,
      '001_start.sql',
      `CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
       CREATE TABLE migration_order(step TEXT NOT NULL);
       INSERT INTO migration_order(step) VALUES ('001');`,
    );
    writeMigration(
      migrationsRoot,
      '002_continue.sql',
      "INSERT INTO migration_order(step) VALUES ('002');",
    );
    writeFileSync(join(migrationsRoot, 'README.md'), 'ignored', 'utf8');

    runMigrations(db, migrationsRoot);

    expect(migrationVersions(db)).toEqual(['001', '002', '010']);
    expect(db.prepare('SELECT step FROM migration_order ORDER BY rowid').all()).toEqual([
      { step: '001' },
      { step: '002' },
      { step: '010' },
    ]);
  });

  it.each(['1_short.sql', '000.sql', '001_bad-name.sql', '001_UPPER.sql', '001_name.SQL']) (
    'rejects invalid SQL migration filename %s',
    (filename) => {
      const { db } = createDatabase();
      const migrationsRoot = createTemporaryRoot('sweet-memories-invalid-migration-');
      writeMigration(migrationsRoot, filename, 'SELECT 1;');

      expect(() => runMigrations(db, migrationsRoot)).toThrow('迁移文件名无效');
    },
  );

  it('keeps prior versions unchanged when a migration cannot be read', () => {
    const { db } = createDatabase();
    const migrationsRoot = createTemporaryRoot('sweet-memories-unreadable-migration-');
    writeMigration(
      migrationsRoot,
      '001_start.sql',
      'CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
    );
    mkdirSync(join(migrationsRoot, '002_unreadable.sql'));

    expect(() => runMigrations(db, migrationsRoot)).toThrow('读取迁移文件失败');
    expect(migrationVersions(db)).toEqual(['001']);
  });

  it('rolls back failed SQL and keeps prior versions unchanged', () => {
    const { db } = createDatabase();
    const migrationsRoot = createTemporaryRoot('sweet-memories-broken-migration-');
    writeMigration(
      migrationsRoot,
      '001_start.sql',
      `CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
       CREATE TABLE retained(value TEXT NOT NULL);
       INSERT INTO retained(value) VALUES ('yes');`,
    );
    writeMigration(
      migrationsRoot,
      '002_broken.sql',
      `INSERT INTO retained(value) VALUES ('rolled-back');
       INSERT INTO table_that_does_not_exist(value) VALUES ('no');`,
    );

    expect(() => runMigrations(db, migrationsRoot)).toThrow('执行迁移失败: 002_broken.sql');
    expect(migrationVersions(db)).toEqual(['001']);
    expect(db.prepare('SELECT value FROM retained').all()).toEqual([{ value: 'yes' }]);
  });
});
