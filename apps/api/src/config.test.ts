// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const temporaryRoots: string[] = [];
const migrationsRoot = resolve(import.meta.dirname, '../migrations');

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sweet-memories-config-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('loadConfig', () => {
  it('loads production defaults from an explicit data root', () => {
    const dataRoot = createTemporaryRoot();
    const config = loadConfig({
      NODE_ENV: 'production',
      SWEET_MEMORIES_DATA_ROOT: dataRoot,
      SWEET_MEMORIES_MIGRATIONS_ROOT: migrationsRoot,
    });

    expect(config).toMatchObject({
      nodeEnv: 'production',
      host: '127.0.0.1',
      port: 3100,
      origin: 'https://huangjianfen.cn',
      dataRoot,
      heifInfoPath: '/usr/bin/heif-info',
      heifConvertPath: '/usr/bin/heif-convert',
      cookieSecure: true,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('keeps derived writable paths absolute and inside dataRoot', () => {
    const dataRoot = createTemporaryRoot();
    const config = loadConfig({
      NODE_ENV: 'test',
      SWEET_MEMORIES_DATA_ROOT: dataRoot,
      SWEET_MEMORIES_MIGRATIONS_ROOT: migrationsRoot,
    });

    for (const path of [
      config.databasePath,
      config.mediaRoot,
      config.stagingRoot,
      config.backupRoot,
    ]) {
      expect(isAbsolute(path)).toBe(true);
      expect(relative(dataRoot, path)).not.toMatch(/^\.\.(?:\/|$)/);
    }
    expect(isAbsolute(config.migrationsRoot)).toBe(true);
    expect(config.backupRoot).toBe(join(dataRoot, 'backups'));
  });

  it('accepts strict explicit overrides', () => {
    const dataRoot = createTemporaryRoot();
    const config = loadConfig({
      NODE_ENV: 'test',
      SWEET_MEMORIES_HOST: '127.0.0.1',
      SWEET_MEMORIES_PORT: '4310',
      SWEET_MEMORIES_ORIGIN: 'http://127.0.0.1:4310',
      SWEET_MEMORIES_DATA_ROOT: dataRoot,
      SWEET_MEMORIES_DATABASE_PATH: join(dataRoot, 'database', 'app.sqlite3'),
      SWEET_MEMORIES_MEDIA_ROOT: join(dataRoot, 'public-media'),
      SWEET_MEMORIES_STAGING_ROOT: join(dataRoot, 'work'),
      SWEET_MEMORIES_BACKUP_ROOT: join(dataRoot, 'snapshots'),
      SWEET_MEMORIES_MIGRATIONS_ROOT: join(dataRoot, 'migrations'),
      SWEET_MEMORIES_HEIF_INFO_PATH: '/opt/heif/bin/heif-info',
      SWEET_MEMORIES_HEIF_CONVERT_PATH: '/opt/heif/bin/heif-convert',
    });

    expect(config).toMatchObject({
      port: 4310,
      origin: 'http://127.0.0.1:4310',
      databasePath: join(dataRoot, 'database', 'app.sqlite3'),
      mediaRoot: join(dataRoot, 'public-media'),
      stagingRoot: join(dataRoot, 'work'),
      backupRoot: join(dataRoot, 'snapshots'),
      migrationsRoot: join(dataRoot, 'migrations'),
      heifInfoPath: '/opt/heif/bin/heif-info',
      heifConvertPath: '/opt/heif/bin/heif-convert',
      cookieSecure: false,
    });
  });

  it('rejects a non-HTTPS production Origin', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        SWEET_MEMORIES_ORIGIN: 'http://huangjianfen.cn',
        SWEET_MEMORIES_DATA_ROOT: createTemporaryRoot(),
        SWEET_MEMORIES_MIGRATIONS_ROOT: migrationsRoot,
      }),
    ).toThrow('生产环境 Origin 必须使用 HTTPS');
  });

  it('rejects a listening address other than the IPv4 loopback', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        SWEET_MEMORIES_HOST: '0.0.0.0',
        SWEET_MEMORIES_DATA_ROOT: createTemporaryRoot(),
        SWEET_MEMORIES_MIGRATIONS_ROOT: migrationsRoot,
      }),
    ).toThrow('监听地址必须为 127.0.0.1');
  });

  it('rejects relative writable and executable paths', () => {
    const dataRoot = createTemporaryRoot();

    for (const [name, value] of [
      ['SWEET_MEMORIES_DATA_ROOT', 'data'],
      ['SWEET_MEMORIES_DATABASE_PATH', 'database/app.sqlite3'],
      ['SWEET_MEMORIES_MEDIA_ROOT', 'media'],
      ['SWEET_MEMORIES_STAGING_ROOT', 'staging'],
      ['SWEET_MEMORIES_BACKUP_ROOT', 'backup'],
      ['SWEET_MEMORIES_MIGRATIONS_ROOT', 'migrations'],
      ['SWEET_MEMORIES_HEIF_INFO_PATH', 'bin/heif-info'],
      ['SWEET_MEMORIES_HEIF_CONVERT_PATH', 'bin/heif-convert'],
    ] as const) {
      expect(() =>
        loadConfig({
          NODE_ENV: 'test',
          SWEET_MEMORIES_DATA_ROOT: dataRoot,
          SWEET_MEMORIES_MIGRATIONS_ROOT: migrationsRoot,
          [name]: value,
        }),
      ).toThrow('必须是绝对路径');
    }
  });

  it('rejects writable path overrides outside dataRoot', () => {
    const dataRoot = createTemporaryRoot();

    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        SWEET_MEMORIES_DATA_ROOT: dataRoot,
        SWEET_MEMORIES_MIGRATIONS_ROOT: migrationsRoot,
        SWEET_MEMORIES_MEDIA_ROOT: join(dataRoot, '..', 'escaped-media'),
      }),
    ).toThrow('必须位于数据目录内');
  });

  it.each([
    [{ NODE_ENV: 'staging' }, 'NODE_ENV'],
    [{ NODE_ENV: 'test', SWEET_MEMORIES_PORT: '3100.0' }, '端口'],
    [{ NODE_ENV: 'test', SWEET_MEMORIES_PORT: '0' }, '端口'],
    [{ NODE_ENV: 'test', SWEET_MEMORIES_PORT: ' 3100' }, '端口'],
    [{ NODE_ENV: 'test', SWEET_MEMORIES_ORIGIN: 'not-a-url' }, 'Origin'],
    [{ NODE_ENV: 'test', SWEET_MEMORIES_ORIGIN: 'https://example.com/path' }, 'Origin'],
    [{ NODE_ENV: 'test', SWEET_MEMORIES_ORIGIN: 'ftp://example.com' }, 'Origin'],
  ])('rejects invalid scalar input %j', (override, message) => {
    expect(() =>
      loadConfig({
        SWEET_MEMORIES_DATA_ROOT: createTemporaryRoot(),
        SWEET_MEMORIES_MIGRATIONS_ROOT: migrationsRoot,
        ...override,
      }),
    ).toThrow(message);
  });
});
