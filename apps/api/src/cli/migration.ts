import type Database from 'better-sqlite3';

import {
  activateLegacyPhotos,
  checkLegacyReadiness,
  getUploadsEnabled,
  importLegacyPhotos,
  setUploadsEnabled,
} from '../services/legacy-migration.js';
import type { AdminCommandOutput } from './admin.js';

export const migrationHelp = `用法:
  sweet-memories migration import-legacy
  sweet-memories migration check-ready
  sweet-memories migration activate
  sweet-memories uploads status
  sweet-memories uploads enable
  sweet-memories uploads disable
`;

export interface MigrationCommandOptions {
  readonly argv: readonly string[];
  readonly db: Database.Database;
  readonly seedRoot: string;
  readonly mediaRoot: string;
  readonly output: AdminCommandOutput;
  readonly now: () => string;
}

type MigrationAction = 'import-legacy' | 'check-ready' | 'activate';
type UploadAction = 'status' | 'enable' | 'disable';

function migrationAction(argv: readonly string[]): MigrationAction | undefined {
  if (argv.length !== 2 || argv[0] !== 'migration') return undefined;
  return argv[1] === 'import-legacy' || argv[1] === 'check-ready' || argv[1] === 'activate'
    ? argv[1]
    : undefined;
}

function uploadAction(argv: readonly string[]): UploadAction | undefined {
  if (argv.length !== 2 || argv[0] !== 'uploads') return undefined;
  return argv[1] === 'status' || argv[1] === 'enable' || argv[1] === 'disable'
    ? argv[1]
    : undefined;
}

export function isDatabaseManagementCommand(argv: readonly string[]): boolean {
  return migrationAction(argv) !== undefined || uploadAction(argv) !== undefined;
}

export function isManagementCommandNamespace(argv: readonly string[]): boolean {
  return argv[0] === 'migration' || argv[0] === 'uploads';
}

function safeWrite(output: AdminCommandOutput, text: string): void {
  output.write(`${text}\n`);
}

export async function runMigrationCommand(options: MigrationCommandOptions): Promise<number> {
  const migration = migrationAction(options.argv);
  const uploads = uploadAction(options.argv);
  if (migration === undefined && uploads === undefined) {
    options.output.write(migrationHelp);
    return 1;
  }

  try {
    if (migration === 'import-legacy') {
      const result = await importLegacyPhotos(options);
      safeWrite(
        options.output,
        `旧照片导入完成：新增 ${result.imported} 张，复用 ${result.reused} 张`,
      );
      return 0;
    }
    if (migration === 'check-ready') {
      await checkLegacyReadiness(options);
      safeWrite(options.output, '旧照片迁移已就绪');
      return 0;
    }
    if (migration === 'activate') {
      const result = await activateLegacyPhotos(options);
      safeWrite(options.output, `旧照片激活完成：本次发布 ${result.activated} 张`);
      return 0;
    }
    if (uploads === 'status') {
      safeWrite(options.output, getUploadsEnabled(options.db) ? '图片上传：已启用' : '图片上传：已禁用');
      return 0;
    }
    const enabled = uploads === 'enable';
    setUploadsEnabled(options.db, enabled, options.now());
    safeWrite(options.output, enabled ? '图片上传已启用' : '图片上传已禁用');
    return 0;
  } catch {
    const failure = migration === 'import-legacy'
      ? '旧照片导入失败'
      : migration === 'check-ready'
        ? '旧照片迁移尚未就绪'
        : migration === 'activate'
          ? '旧照片激活失败'
          : '图片上传开关操作失败';
    safeWrite(options.output, failure);
    return 1;
  }
}
