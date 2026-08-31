import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { MigrationError } from './errors.js';

const MIGRATION_NAME = /^(\d{3})_([a-z0-9_]+)\.sql$/;

interface MigrationFile {
  readonly filename: string;
  readonly version: string;
}

function listMigrations(migrationsRoot: string): MigrationFile[] {
  let filenames: string[];
  try {
    filenames = readdirSync(migrationsRoot);
  } catch (cause) {
    throw new MigrationError('读取迁移目录失败', { cause });
  }

  const migrations = filenames
    .filter((filename) => /\.sql$/i.test(filename))
    .map((filename) => {
      const match = MIGRATION_NAME.exec(filename);
      if (!match?.[1]) {
        throw new MigrationError(`迁移文件名无效: ${filename}`);
      }
      return { filename, version: match[1] };
    })
    .sort((left, right) => left.filename.localeCompare(right.filename));

  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new MigrationError(`迁移版本重复: ${migration.version}`);
    }
    seen.add(migration.version);
  }
  return migrations;
}

function hasMigrationTable(db: Database.Database): boolean {
  return (
    db
      .prepare(
        `SELECT 1
         FROM sqlite_master
         WHERE type = 'table' AND name = 'schema_migrations'`,
      )
      .get() !== undefined
  );
}

function appliedVersions(db: Database.Database): Set<string> {
  if (!hasMigrationTable(db)) {
    return new Set();
  }
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: string;
  }>;
  return new Set(rows.map(({ version }) => version));
}

export function runMigrations(db: Database.Database, migrationsRoot: string): void {
  const migrations = listMigrations(migrationsRoot);
  const applied = appliedVersions(db);

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }

    let sql: string;
    try {
      sql = readFileSync(join(migrationsRoot, migration.filename), 'utf8');
    } catch (cause) {
      throw new MigrationError(`读取迁移文件失败: ${migration.filename}`, { cause });
    }

    try {
      db.transaction(() => {
        db.exec(sql);
        db.prepare(
          `INSERT INTO schema_migrations(version, applied_at)
           VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        ).run(migration.version);
      })();
    } catch (cause) {
      throw new MigrationError(`执行迁移失败: ${migration.filename}`, { cause });
    }
    applied.add(migration.version);
  }
}
