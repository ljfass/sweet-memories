// @vitest-environment node

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { MigrationError } from './errors.js';
import { runMigrations } from './migrations.js';

const initialMigrationsRoot = resolve(import.meta.dirname, '../migrations');
const initialMigrationSql = readFileSync(join(initialMigrationsRoot, '001_initial.sql'), 'utf8');
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
      `${initialMigrationSql}
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
      initialMigrationSql,
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
      `${initialMigrationSql}
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

  it('rejects transaction control before COMMIT can escape the migration transaction', () => {
    const { db } = createDatabase();
    const migrationsRoot = createTemporaryRoot('sweet-memories-transaction-escape-');
    writeMigration(
      migrationsRoot,
      '001_escape.sql',
      `CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
       CREATE TABLE leaked(value TEXT NOT NULL);
       COMMIT;
       INSERT INTO table_that_does_not_exist(value) VALUES ('fail');`,
    );

    expect(() => runMigrations(db, migrationsRoot)).toThrow(
      '迁移文件包含禁止的事务控制关键字: COMMIT',
    );
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('schema_migrations', 'leaked')`,
        )
        .all(),
    ).toEqual([]);
  });

  it('allows transaction words inside quoted text, identifiers, and comments', () => {
    const { db } = createDatabase();
    const migrationsRoot = createTemporaryRoot('sweet-memories-quoted-words-');
    writeMigration(
      migrationsRoot,
      '001_quoted.sql',
      `${initialMigrationSql}
       CREATE TABLE quoted_words(
         "BEGIN" TEXT,
         \`COMMIT\` TEXT,
         [ROLLBACK] TEXT,
         "SAVEPOINT""escaped" TEXT,
         \`RELEASE\`\`escaped\` TEXT
       );
       INSERT INTO quoted_words("BEGIN", \`COMMIT\`, [ROLLBACK])
       VALUES ('END '' RELEASE', 'BEGIN COMMIT', 'SAVEPOINT');
       -- ROLLBACK; BEGIN;
       /* COMMIT; END; SAVEPOINT; RELEASE; */`,
    );

    runMigrations(db, migrationsRoot);

    expect(migrationVersions(db)).toEqual(['001']);
  });

  it.each(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'])(
    'rejects the standalone transaction keyword %s',
    (keyword) => {
      const { db } = createDatabase();
      const migrationsRoot = createTemporaryRoot('sweet-memories-transaction-keyword-');
      writeMigration(
        migrationsRoot,
        '001_keyword.sql',
        `CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
         ${keyword};`,
      );

      expect(() => runMigrations(db, migrationsRoot)).toThrow(
        `迁移文件包含禁止的事务控制关键字: ${keyword}`,
      );
    },
  );

  it('rejects an empty migration directory', () => {
    const { db } = createDatabase();
    const migrationsRoot = createTemporaryRoot('sweet-memories-empty-migrations-');

    expect(() => runMigrations(db, migrationsRoot)).toThrow('迁移目录不能为空');
  });

  it('rejects a migration set that does not start at version 001', () => {
    const { db } = createDatabase();
    const migrationsRoot = createTemporaryRoot('sweet-memories-missing-initial-');
    writeMigration(
      migrationsRoot,
      '002_later.sql',
      'CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
    );

    expect(() => runMigrations(db, migrationsRoot)).toThrow('迁移必须从 001 开始');
  });

  it('rejects a forged initial version when required schema objects are missing', () => {
    const { db } = createDatabase();
    db.exec(
      `CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
       INSERT INTO schema_migrations(version, applied_at)
       VALUES ('001', '2026-08-31T00:00:00.000Z');`,
    );

    expect(() => runMigrations(db, initialMigrationsRoot)).toThrow(
      '迁移后基础数据库对象缺失',
    );
  });

  it('wraps malformed migration state reads in MigrationError with their cause', () => {
    const { db } = createDatabase();
    db.exec('CREATE TABLE schema_migrations(applied_at TEXT NOT NULL);');

    let caught: unknown;
    try {
      runMigrations(db, initialMigrationsRoot);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationError);
    expect(caught).toMatchObject({ message: '读取迁移状态失败' });
    expect((caught as MigrationError).cause).toBeInstanceOf(Error);
  });

  it('allows a CREATE TRIGGER body with CASE and executes the trigger', () => {
    const { db } = createDatabase();
    const migrationsRoot = createTemporaryRoot('sweet-memories-trigger-migration-');
    writeMigration(migrationsRoot, '001_initial.sql', initialMigrationSql);
    writeMigration(
      migrationsRoot,
      '002_trigger.sql',
      `CREATE TABLE trigger_events(value TEXT NOT NULL);
       CREATE TRIGGER photos_after_insert
       AFTER INSERT ON photos
       BEGIN
         INSERT INTO trigger_events(value)
         VALUES (CASE WHEN NEW.status = 'published' THEN 'visible' ELSE 'hidden' END);
         UPDATE photos SET updated_at = NEW.updated_at WHERE id = NEW.id;
       END;`,
    );

    runMigrations(db, migrationsRoot);
    db.prepare(
      `INSERT INTO photos(
         id, title, status, rotation, offset_x, offset_y,
         request_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'photo-trigger',
      'Trigger photo',
      'published',
      0,
      0,
      0,
      'request-trigger',
      '2026-08-31T00:00:00.000Z',
      '2026-08-31T00:00:00.000Z',
    );

    expect(db.prepare('SELECT value FROM trigger_events').all()).toEqual([{ value: 'visible' }]);
    expect(migrationVersions(db)).toEqual(['001', '002']);
  });

  it('allows CASE expressions in ordinary migration statements', () => {
    const { db } = createDatabase();
    const migrationsRoot = createTemporaryRoot('sweet-memories-case-migration-');
    writeMigration(migrationsRoot, '001_initial.sql', initialMigrationSql);
    writeMigration(
      migrationsRoot,
      '002_case.sql',
      `INSERT INTO settings(key, value, updated_at)
       VALUES (
         'case_result',
         CASE WHEN 1 = 1 THEN 'matched' ELSE 'missed' END,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       );`,
    );

    runMigrations(db, migrationsRoot);

    expect(db.prepare("SELECT value FROM settings WHERE key = 'case_result'").get()).toEqual({
      value: 'matched',
    });
    expect(migrationVersions(db)).toEqual(['001', '002']);
  });

  it('rolls back an incomplete initial schema before recording version 001', () => {
    const { db } = createDatabase();
    const migrationsRoot = createTemporaryRoot('sweet-memories-incomplete-initial-');
    writeMigration(
      migrationsRoot,
      '001_incomplete.sql',
      'CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
    );

    expect(() => runMigrations(db, migrationsRoot)).toThrow(
      '执行迁移失败: 001_incomplete.sql',
    );
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'schema_migrations'`,
        )
        .get(),
    ).toBeUndefined();
  });

  it('rolls back a later migration that removes a required schema object', () => {
    const { db } = createDatabase();
    const migrationsRoot = createTemporaryRoot('sweet-memories-destructive-migration-');
    writeMigration(migrationsRoot, '001_initial.sql', initialMigrationSql);
    writeMigration(migrationsRoot, '002_drop_index.sql', 'DROP INDEX sessions_admin_id_idx;');

    expect(() => runMigrations(db, migrationsRoot)).toThrow(
      '执行迁移失败: 002_drop_index.sql',
    );
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name = 'sessions_admin_id_idx'`,
        )
        .get(),
    ).toEqual({ name: 'sessions_admin_id_idx' });
    expect(migrationVersions(db)).toEqual(['001']);
  });

  it('allows an older migration directory after a future additive version was applied', () => {
    const { db } = createDatabase();
    const futureRoot = createTemporaryRoot('sweet-memories-future-release-');
    writeMigration(futureRoot, '001_initial.sql', initialMigrationSql);
    writeMigration(
      futureRoot,
      '002_additive.sql',
      `CREATE TABLE future_data(value TEXT NOT NULL);
       INSERT INTO future_data(value) VALUES ('preserved');`,
    );
    runMigrations(db, futureRoot);

    const oldRoot = createTemporaryRoot('sweet-memories-old-release-');
    writeMigration(oldRoot, '001_initial.sql', initialMigrationSql);
    runMigrations(db, oldRoot);

    expect(migrationVersions(db)).toEqual(['001', '002']);
    expect(db.prepare('SELECT value FROM future_data').all()).toEqual([{ value: 'preserved' }]);
  });

  it('rejects applied known versions that are not an ordered prefix', () => {
    const { db } = createDatabase();
    runMigrations(db, initialMigrationsRoot);
    db.prepare(
      `INSERT INTO schema_migrations(version, applied_at)
       VALUES ('003', '2026-08-31T00:00:00.000Z')`,
    ).run();
    const migrationsRoot = createTemporaryRoot('sweet-memories-prefix-gap-');
    writeMigration(migrationsRoot, '001_initial.sql', initialMigrationSql);
    writeMigration(migrationsRoot, '002_additive.sql', 'CREATE TABLE migration_two(value TEXT);');
    writeMigration(migrationsRoot, '003_additive.sql', 'CREATE TABLE migration_three(value TEXT);');

    expect(() => runMigrations(db, migrationsRoot)).toThrow(
      '数据库迁移版本不是有序前缀',
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_two'").get(),
    ).toBeUndefined();
    expect(migrationVersions(db)).toEqual(['001', '003']);
  });

  it('does not backfill a current migration behind an applied future version', () => {
    const { db } = createDatabase();
    db.exec(initialMigrationSql);
    db.prepare(
      `INSERT INTO schema_migrations(version, applied_at)
       VALUES ('002', '2026-08-31T00:00:00.000Z')`,
    ).run();

    expect(() => runMigrations(db, initialMigrationsRoot)).toThrow(
      '未来迁移版本存在时不能补旧迁移',
    );
    expect(migrationVersions(db)).toEqual(['002']);
  });

  it('rejects applied versions that are not three digits', () => {
    const { db } = createDatabase();
    db.exec(initialMigrationSql);
    db.prepare(
      `INSERT INTO schema_migrations(version, applied_at)
       VALUES ('version-two', '2026-08-31T00:00:00.000Z')`,
    ).run();

    expect(() => runMigrations(db, initialMigrationsRoot)).toThrow(
      '数据库迁移版本无效: version-two',
    );
  });

  it('rejects an applied version missing on disk below the disk maximum', () => {
    const { db } = createDatabase();
    runMigrations(db, initialMigrationsRoot);
    db.prepare(
      `INSERT INTO schema_migrations(version, applied_at)
       VALUES ('002', '2026-08-31T00:00:00.000Z')`,
    ).run();
    const migrationsRoot = createTemporaryRoot('sweet-memories-missing-file-');
    writeMigration(migrationsRoot, '001_initial.sql', initialMigrationSql);
    writeMigration(migrationsRoot, '003_later.sql', 'CREATE TABLE migration_three(value TEXT);');

    expect(() => runMigrations(db, migrationsRoot)).toThrow(
      '数据库包含缺失的迁移文件版本: 002',
    );
  });
});
