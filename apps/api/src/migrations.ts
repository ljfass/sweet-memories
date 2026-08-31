import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { MigrationError } from './errors.js';

const MIGRATION_NAME = /^(\d{3})_([a-z0-9_]+)\.sql$/;
const FORBIDDEN_TRANSACTION_WORDS = new Set([
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
]);
const IDENTIFIER_CHARACTER = /[\p{L}\p{N}_$]/u;
const REQUIRED_SCHEMA_OBJECTS = [
  ['table', 'schema_migrations'],
  ['table', 'admins'],
  ['table', 'sessions'],
  ['table', 'login_attempts'],
  ['table', 'settings'],
  ['table', 'photos'],
  ['table', 'photo_assets'],
  ['index', 'sessions_admin_id_idx'],
  ['index', 'photos_public_order_idx'],
] as const;

interface MigrationFile {
  readonly filename: string;
  readonly version: string;
}

type SqlToken = { readonly kind: 'word'; readonly value: string } | { readonly kind: 'semicolon' };

function skipQuoted(sql: string, start: number, closing: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== closing) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === closing) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return index;
}

function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') {
        index += 1;
      }
      continue;
    }
    if (character === '/' && next === '*') {
      const commentEnd = sql.indexOf('*/', index + 2);
      index = commentEnd === -1 ? sql.length : commentEnd + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      index = skipQuoted(sql, index, character);
      continue;
    }
    if (character === '[') {
      index = skipQuoted(sql, index, ']');
      continue;
    }
    if (character !== undefined && IDENTIFIER_CHARACTER.test(character)) {
      const start = index;
      do {
        index += 1;
      } while (
        index < sql.length &&
        sql[index] !== undefined &&
        IDENTIFIER_CHARACTER.test(sql[index] as string)
      );
      const word = sql.slice(start, index).toUpperCase();
      tokens.push({ kind: 'word', value: word });
      continue;
    }
    if (character === ';') {
      tokens.push({ kind: 'semicolon' });
    }
    index += 1;
  }
  return tokens;
}

function forbiddenTransactionWord(sql: string): string | undefined {
  let atStatementStart = true;
  let createPrefix: 'none' | 'create' | 'create-temp' = 'none';
  let isTrigger = false;
  let inTriggerBody = false;
  let triggerEnded = false;
  let caseDepth = 0;

  for (const token of tokenizeSql(sql)) {
    if (token.kind === 'semicolon') {
      if (isTrigger && inTriggerBody) {
        continue;
      }
      atStatementStart = true;
      createPrefix = 'none';
      isTrigger = false;
      inTriggerBody = false;
      triggerEnded = false;
      caseDepth = 0;
      continue;
    }

    const word = token.value;
    if (atStatementStart) {
      if (FORBIDDEN_TRANSACTION_WORDS.has(word)) {
        return word;
      }
      atStatementStart = false;
      createPrefix = word === 'CREATE' ? 'create' : 'none';
      continue;
    }

    if (!isTrigger && createPrefix !== 'none') {
      if (createPrefix === 'create' && (word === 'TEMP' || word === 'TEMPORARY')) {
        createPrefix = 'create-temp';
      } else if (word === 'TRIGGER') {
        isTrigger = true;
        createPrefix = 'none';
      } else {
        createPrefix = 'none';
      }
      continue;
    }

    if (!isTrigger || triggerEnded) {
      continue;
    }
    if (word === 'CASE') {
      caseDepth += 1;
    } else if (word === 'END') {
      if (caseDepth > 0) {
        caseDepth -= 1;
      } else if (inTriggerBody) {
        inTriggerBody = false;
        triggerEnded = true;
      }
    } else if (word === 'BEGIN' && !inTriggerBody && caseDepth === 0) {
      inTriggerBody = true;
    }
  }
  return undefined;
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

function readMigrationState<T>(read: () => T): T {
  try {
    return read();
  } catch (cause) {
    throw new MigrationError('读取迁移状态失败', { cause });
  }
}

function appliedVersions(db: Database.Database): Set<string> {
  return readMigrationState(() => {
    if (!hasMigrationTable(db)) {
      return new Set();
    }
    const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
      version: string;
    }>;
    return new Set(rows.map(({ version }) => version));
  });
}

function validateRequiredSchema(db: Database.Database): void {
  const existing = new Set(
    readMigrationState(
      () =>
        db
          .prepare(
            `SELECT type, name FROM sqlite_master
             WHERE type IN ('table', 'index')`,
          )
          .all() as Array<{ type: string; name: string }>,
    ).map(({ type, name }) => `${type}:${name}`),
  );
  const missing = REQUIRED_SCHEMA_OBJECTS.filter(
    ([type, name]) => !existing.has(`${type}:${name}`),
  ).map(([, name]) => name);
  if (missing.length > 0) {
    throw new MigrationError(`迁移后基础数据库对象缺失: ${missing.join(', ')}`);
  }
}

function validateAppliedVersions(
  migrations: readonly MigrationFile[],
  applied: ReadonlySet<string>,
): void {
  const knownVersions = migrations.map(({ version }) => version);
  const known = new Set(knownVersions);
  const maximumKnownVersion = knownVersions.at(-1) as string;
  const futureVersions: string[] = [];

  for (const version of applied) {
    if (!/^\d{3}$/.test(version)) {
      throw new MigrationError(`数据库迁移版本无效: ${version}`);
    }
    if (!known.has(version)) {
      if (version <= maximumKnownVersion) {
        throw new MigrationError(`数据库包含缺失的迁移文件版本: ${version}`);
      }
      futureVersions.push(version);
    }
  }

  let foundMissingKnownVersion = false;
  for (const version of knownVersions) {
    if (!applied.has(version)) {
      foundMissingKnownVersion = true;
    } else if (foundMissingKnownVersion) {
      throw new MigrationError('数据库迁移版本不是有序前缀');
    }
  }

  if (futureVersions.length > 0 && foundMissingKnownVersion) {
    throw new MigrationError('未来迁移版本存在时不能补旧迁移');
  }
}

export function runMigrations(db: Database.Database, migrationsRoot: string): void {
  const migrations = listMigrations(migrationsRoot);
  if (migrations.length === 0) {
    throw new MigrationError('迁移目录不能为空');
  }
  if (migrations[0]?.version !== '001') {
    throw new MigrationError('迁移必须从 001 开始');
  }

  const applied = appliedVersions(db);
  validateAppliedVersions(migrations, applied);

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

    const forbiddenWord = forbiddenTransactionWord(sql);
    if (forbiddenWord !== undefined) {
      throw new MigrationError(
        `迁移文件包含禁止的事务控制关键字: ${forbiddenWord} (${migration.filename})`,
      );
    }

    try {
      db.transaction(() => {
        db.exec(sql);
        validateRequiredSchema(db);
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

  validateRequiredSchema(db);
}
