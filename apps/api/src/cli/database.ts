import { chmodSync, closeSync, lstatSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import type Database from 'better-sqlite3';

import type { AdminCommandOutput } from './admin.js';

export const databaseHelp = `用法:
  sweet-memories database backup <absolute-output-file>
  sweet-memories database migrate
`;

export interface DatabaseCommandOptions {
  readonly argv: readonly string[];
  readonly db: Database.Database;
  readonly dataRoot: string;
  readonly migrationsRoot: string;
  readonly output: AdminCommandOutput;
  readonly migrate: (db: Database.Database, migrationsRoot: string) => void;
}

type DatabaseAction = 'backup' | 'migrate';

function databaseAction(argv: readonly string[]): DatabaseAction | undefined {
  if (argv[0] !== 'database') return undefined;
  if (argv.length === 2 && argv[1] === 'migrate') return 'migrate';
  if (argv.length === 3 && argv[1] === 'backup') return 'backup';
  return undefined;
}

export function isDatabaseCommand(argv: readonly string[]): boolean {
  return databaseAction(argv) !== undefined;
}

export function isDatabaseCommandNamespace(argv: readonly string[]): boolean {
  return argv[0] === 'database';
}

function writeLine(output: AdminCommandOutput, message: string): void {
  output.write(`${message}\n`);
}

async function backupDatabase(
  db: Database.Database,
  dataRoot: string,
  destination: string,
): Promise<void> {
  if (!isAbsolute(destination)) {
    throw new Error('备份目标必须是绝对路径');
  }

  const backupRoot = normalize(join(dataRoot, 'backups', 'deploy'));
  const normalizedDestination = normalize(destination);
  if (dirname(normalizedDestination) !== backupRoot) {
    throw new Error('备份目标必须位于部署备份目录');
  }
  const rootStat = lstatSync(backupRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(backupRoot) !== backupRoot) {
    throw new Error('部署备份目录无效');
  }

  let descriptor: number | undefined;
  let ownsDestination = false;
  try {
    descriptor = openSync(normalizedDestination, 'wx', 0o600);
    ownsDestination = true;
    closeSync(descriptor);
    descriptor = undefined;
    await db.backup(normalizedDestination);
    const destinationStat = lstatSync(normalizedDestination);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
      throw new Error('数据库备份不是普通文件');
    }
    chmodSync(normalizedDestination, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (ownsDestination) {
      try {
        unlinkSync(normalizedDestination);
      } catch {
        // The original backup failure remains the actionable error.
      }
    }
    throw error;
  }
}

export async function runDatabaseCommand(options: DatabaseCommandOptions): Promise<number> {
  const action = databaseAction(options.argv);
  if (action === undefined) {
    options.output.write(databaseHelp);
    return 1;
  }

  try {
    if (action === 'backup') {
      await backupDatabase(options.db, options.dataRoot, options.argv[2] as string);
      writeLine(options.output, '数据库在线备份完成');
    } else {
      options.migrate(options.db, options.migrationsRoot);
      writeLine(options.output, '数据库迁移完成');
    }
    return 0;
  } catch {
    writeLine(options.output, action === 'backup' ? '数据库在线备份失败' : '数据库迁移失败');
    return 1;
  }
}
