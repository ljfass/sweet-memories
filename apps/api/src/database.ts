import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

import type { ApiConfig } from './config.js';
import { DatabaseInitializationError } from './errors.js';

export function openDatabase(config: ApiConfig): Database.Database {
  let db: Database.Database | undefined;

  try {
    for (const path of [
      config.dataRoot,
      config.mediaRoot,
      config.stagingRoot,
      config.backupRoot,
      dirname(config.databasePath),
    ]) {
      mkdirSync(path, { recursive: true });
    }

    db = new Database(config.databasePath);
    db.pragma('foreign_keys = ON');
    const journalMode = db.pragma('journal_mode = WAL', { simple: true });
    if (typeof journalMode !== 'string' || journalMode.toLowerCase() !== 'wal') {
      throw new Error('SQLite 未能启用 WAL 模式');
    }
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');
    return db;
  } catch (cause) {
    if (db?.open) {
      db.close();
    }
    throw new DatabaseInitializationError('数据库初始化失败', { cause });
  }
}
