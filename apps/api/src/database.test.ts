// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sqliteMock = vi.hoisted(() => ({
  close: vi.fn(),
  construct: vi.fn(),
  pragma: vi.fn(),
}));

vi.mock('better-sqlite3', () => ({
  default: class MockDatabase {
    open = true;

    constructor(path: string) {
      sqliteMock.construct(path);
    }

    pragma(statement: string, options?: unknown) {
      return sqliteMock.pragma(statement, options);
    }

    close(): void {
      this.open = false;
      sqliteMock.close();
    }
  },
}));

import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { DatabaseInitializationError } from './errors.js';

const temporaryRoots: string[] = [];

beforeEach(() => {
  sqliteMock.close.mockReset();
  sqliteMock.construct.mockReset();
  sqliteMock.pragma.mockReset();
  sqliteMock.pragma.mockImplementation((statement: string) =>
    statement === 'journal_mode = WAL' ? 'delete' : undefined,
  );
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('openDatabase WAL verification', () => {
  it('closes and wraps initialization when SQLite does not enable WAL', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'sweet-memories-wal-failure-'));
    temporaryRoots.push(dataRoot);
    const config = loadConfig({
      NODE_ENV: 'test',
      SWEET_MEMORIES_DATA_ROOT: dataRoot,
      SWEET_MEMORIES_MIGRATIONS_ROOT: resolve(import.meta.dirname, '../migrations'),
    });

    let caught: unknown;
    try {
      openDatabase(config);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DatabaseInitializationError);
    expect(caught).toMatchObject({ message: '数据库初始化失败' });
    expect(sqliteMock.pragma).toHaveBeenCalledWith('journal_mode = WAL', { simple: true });
    expect(sqliteMock.close).toHaveBeenCalledOnce();
  });
});
