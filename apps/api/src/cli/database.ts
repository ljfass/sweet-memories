import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
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

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isOrdinarySingleLink(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
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

  try {
    lstatSync(normalizedDestination);
    throw new Error('数据库备份目标已存在');
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }

  let descriptor: number | undefined;
  let workspace = '';
  let temporary = '';
  let workspaceIdentity: Stats | undefined;
  let temporaryIdentity: Stats | undefined;
  let publishedIdentity: Stats | undefined;
  let completed = false;
  try {
    workspace = mkdtempSync(join(backupRoot, '.incoming-'));
    chmodSync(workspace, 0o700);
    workspaceIdentity = lstatSync(workspace);
    if (
      !workspaceIdentity.isDirectory() ||
      workspaceIdentity.isSymbolicLink() ||
      realpathSync(workspace) !== workspace
    ) {
      throw new Error('数据库备份临时目录无效');
    }

    temporary = join(workspace, 'database.sqlite3');
    descriptor = openSync(temporary, 'wx', 0o600);
    temporaryIdentity = lstatSync(temporary);
    if (!isOrdinarySingleLink(temporaryIdentity)) {
      throw new Error('数据库备份临时文件无效');
    }
    closeSync(descriptor);
    descriptor = undefined;

    await db.backup(temporary);
    let temporaryStat = lstatSync(temporary);
    if (!isOrdinarySingleLink(temporaryStat) || !sameIdentity(temporaryIdentity, temporaryStat)) {
      throw new Error('数据库备份不是普通文件');
    }
    chmodSync(temporary, 0o600);
    temporaryStat = lstatSync(temporary);
    if (!isOrdinarySingleLink(temporaryStat) || !sameIdentity(temporaryIdentity, temporaryStat)) {
      throw new Error('数据库备份文件身份发生变化');
    }

    linkSync(temporary, normalizedDestination);
    const publishedStat = lstatSync(normalizedDestination);
    if (!publishedStat.isFile() || publishedStat.isSymbolicLink() || !sameIdentity(temporaryStat, publishedStat)) {
      throw new Error('数据库备份发布身份无效');
    }
    publishedIdentity = publishedStat;
    unlinkSync(temporary);
    temporary = '';
    rmdirSync(workspace);
    workspace = '';

    const finalStat = lstatSync(normalizedDestination);
    if (!isOrdinarySingleLink(finalStat) || !sameIdentity(publishedStat, finalStat)) {
      throw new Error('数据库备份发布结果无效');
    }
    completed = true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!completed && publishedIdentity !== undefined) {
      try {
        const current = lstatSync(normalizedDestination);
        if (sameIdentity(publishedIdentity, current)) unlinkSync(normalizedDestination);
      } catch {
        // Preserve the original backup failure.
      }
    }
    if (workspace && workspaceIdentity !== undefined) {
      try {
        const currentWorkspace = lstatSync(workspace);
        if (sameIdentity(workspaceIdentity, currentWorkspace)) {
          if (temporary) {
            try {
              unlinkSync(temporary);
            } catch {
              // Preserve the original backup failure.
            }
          }
          rmdirSync(workspace);
        }
      } catch {
        // Preserve the original backup failure.
      }
    }
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
