import { isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigurationError } from './errors.js';
import type { NodeEnvironment } from './types.js';

export interface ApiConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly origin: string;
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly mediaRoot: string;
  readonly stagingRoot: string;
  readonly backupRoot: string;
  readonly migrationsRoot: string;
  readonly heifInfoPath: string;
  readonly heifConvertPath: string;
  readonly cookieSecure: boolean;
}

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_PORT = 3100;
const DEFAULT_DATA_ROOT = '/var/lib/sweet-memories';

function defaultMigrationsRoot(): string {
  return fileURLToPath(new URL('../migrations', import.meta.url));
}

function parseNodeEnvironment(value: string | undefined): NodeEnvironment {
  const nodeEnv = value ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new ConfigurationError('NODE_ENV 必须为 development、test 或 production');
  }
  return nodeEnv;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }
  if (!/^[1-9][0-9]{0,4}$/.test(value)) {
    throw new ConfigurationError('端口必须是 1 到 65535 的十进制整数');
  }
  const port = Number(value);
  if (port > 65_535) {
    throw new ConfigurationError('端口必须是 1 到 65535 的十进制整数');
  }
  return port;
}

function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new ConfigurationError('Origin 必须是有效的 HTTP(S) 源', { cause });
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
    throw new ConfigurationError('Origin 必须是有效的 HTTP(S) 源');
  }
  return url.origin;
}

function absolutePath(name: string, value: string): string {
  if (!isAbsolute(value)) {
    throw new ConfigurationError(`${name} 必须是绝对路径`);
  }
  return normalize(value);
}

function dataPath(name: string, value: string, dataRoot: string): string {
  const path = absolutePath(name, value);
  const fromRoot = relative(dataRoot, path);
  if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
    throw new ConfigurationError(`${name} 必须位于数据目录内`);
  }
  return path;
}

export function loadConfig(env: Environment = process.env): Readonly<ApiConfig> {
  const nodeEnv = parseNodeEnvironment(env.NODE_ENV);
  const host = env.SWEET_MEMORIES_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1') {
    throw new ConfigurationError('监听地址必须为 127.0.0.1');
  }

  const port = parsePort(env.SWEET_MEMORIES_PORT);
  const defaultOrigin =
    nodeEnv === 'production' ? 'https://huangjianfen.cn' : `http://127.0.0.1:${port}`;
  const origin = parseOrigin(env.SWEET_MEMORIES_ORIGIN ?? defaultOrigin);
  if (nodeEnv === 'production' && !origin.startsWith('https://')) {
    throw new ConfigurationError('生产环境 Origin 必须使用 HTTPS');
  }

  const dataRoot = absolutePath(
    'SWEET_MEMORIES_DATA_ROOT',
    env.SWEET_MEMORIES_DATA_ROOT ?? DEFAULT_DATA_ROOT,
  );
  const databasePath = dataPath(
    'SWEET_MEMORIES_DATABASE_PATH',
    env.SWEET_MEMORIES_DATABASE_PATH ?? join(dataRoot, 'database', 'sweet-memories.sqlite3'),
    dataRoot,
  );
  const mediaRoot = dataPath(
    'SWEET_MEMORIES_MEDIA_ROOT',
    env.SWEET_MEMORIES_MEDIA_ROOT ?? join(dataRoot, 'media'),
    dataRoot,
  );
  const stagingRoot = dataPath(
    'SWEET_MEMORIES_STAGING_ROOT',
    env.SWEET_MEMORIES_STAGING_ROOT ?? join(dataRoot, 'staging'),
    dataRoot,
  );
  const backupRoot = dataPath(
    'SWEET_MEMORIES_BACKUP_ROOT',
    env.SWEET_MEMORIES_BACKUP_ROOT ?? join(dataRoot, 'backup'),
    dataRoot,
  );

  return Object.freeze({
    nodeEnv,
    host,
    port,
    origin,
    dataRoot,
    databasePath,
    mediaRoot,
    stagingRoot,
    backupRoot,
    migrationsRoot: absolutePath(
      'SWEET_MEMORIES_MIGRATIONS_ROOT',
      env.SWEET_MEMORIES_MIGRATIONS_ROOT ?? defaultMigrationsRoot(),
    ),
    heifInfoPath: absolutePath(
      'SWEET_MEMORIES_HEIF_INFO_PATH',
      env.SWEET_MEMORIES_HEIF_INFO_PATH ?? '/usr/bin/heif-info',
    ),
    heifConvertPath: absolutePath(
      'SWEET_MEMORIES_HEIF_CONVERT_PATH',
      env.SWEET_MEMORIES_HEIF_CONVERT_PATH ?? '/usr/bin/heif-convert',
    ),
    cookieSecure: nodeEnv === 'production',
  });
}
