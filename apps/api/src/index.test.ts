// @vitest-environment node

import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppDependencies } from './app.js';
import type { ApiConfig } from './config.js';
import { ProcessingQueue } from './media/processing-queue.js';
import type { MaintenanceService } from './services/maintenance.js';
import { startApi, type ApiSignalSource, type ApiTimers } from './index.js';

const temporaryRoots: string[] = [];

function testConfig(): Readonly<ApiConfig> {
  const dataRoot = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'sweet-memories-runtime-')),
  );
  temporaryRoots.push(dataRoot);
  return Object.freeze({
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 43100,
    origin: 'https://huangjianfen.cn',
    dataRoot,
    databasePath: join(dataRoot, 'database', 'sweet-memories.sqlite3'),
    mediaRoot: join(dataRoot, 'media'),
    stagingRoot: join(dataRoot, 'staging'),
    backupRoot: join(dataRoot, 'backup'),
    migrationsRoot: resolve(import.meta.dirname, '../migrations'),
    heifInfoPath: '/fixture/bin/heif-info',
    heifConvertPath: '/fixture/bin/heif-convert',
    cookieSecure: true,
  });
}

interface FakeApplication {
  readonly app: FastifyInstance;
  readonly close: ReturnType<typeof vi.fn>;
  readonly listen: ReturnType<typeof vi.fn>;
  readonly stopAccepting: ReturnType<typeof vi.fn>;
}

function fakeApplication(order: string[]): FakeApplication {
  const close = vi.fn(async () => { order.push('app.close'); });
  const listen = vi.fn(async (options: unknown) => { order.push(`listen:${JSON.stringify(options)}`); });
  const stopAccepting = vi.fn((callback?: (error?: Error) => void) => {
    order.push('server.close');
    callback?.();
  });
  const app = {
    close,
    listen,
    server: {
      listening: true,
      close: stopAccepting,
      closeAllConnections: vi.fn(),
    },
  } as unknown as FastifyInstance;
  return { app, close, listen, stopAccepting };
}

function fakeDatabase(order: string[]): Database.Database {
  return { close: vi.fn(() => { order.push('db.close'); }) } as unknown as Database.Database;
}

function sessionService() {
  return {
    login: vi.fn(),
    authenticate: vi.fn(),
    rotateCsrf: vi.fn(),
    verifyCsrf: vi.fn(),
    logout: vi.fn(),
    cleanupExpired: vi.fn(),
  };
}

function signalSource(): ApiSignalSource & EventEmitter {
  return new EventEmitter() as ApiSignalSource & EventEmitter;
}

function controlledTimers() {
  const intervals: Array<() => void> = [];
  const cleared: unknown[] = [];
  const timers: ApiTimers = {
    setInterval(callback) {
      intervals.push(callback);
      return callback;
    },
    clearInterval(handle) {
      cleared.push(handle);
    },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  return { timers, intervals, cleared };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('startApi', () => {
  it('prepares private roots, migrates, verifies both HEIF tools, then listens only on loopback', async () => {
    const config = testConfig();
    const order: string[] = [];
    const db = fakeDatabase(order);
    const application = fakeApplication(order);
    const signals = signalSource();
    const { timers } = controlledTimers();
    const createApp = vi.fn((dependencies: AppDependencies) => {
      expect(dependencies).toEqual(expect.objectContaining({
        publicOrigin: config.origin,
        sessionService: expect.any(Object),
        photoService: expect.any(Object),
        uploadPhotoService: expect.any(Object),
        deletePhotoService: expect.any(Object),
      }));
      order.push('createApp');
      return application.app;
    });

    const runtime = await startApi({
      config,
      clock: () => new Date('2026-09-01T00:00:00.000Z'),
      signalSource: signals,
      timers,
      openDatabase: () => { order.push('openDatabase'); return db; },
      runMigrations: () => { order.push('migrate'); },
      verifyHeifTool: async (path) => { order.push(`verify:${path}`); },
      createSessionService: async () => sessionService(),
      createApp,
    });

    expect(order).toEqual([
      'openDatabase',
      'migrate',
      'verify:/fixture/bin/heif-info',
      'verify:/fixture/bin/heif-convert',
      'createApp',
      'listen:{"host":"127.0.0.1","port":43100}',
    ]);
    expect(application.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 43100 });
    expect(statSync(config.dataRoot).mode & 0o7777).toBe(0o750);
    expect(statSync(dirname(config.databasePath)).mode & 0o7777).toBe(0o700);
    expect(statSync(config.stagingRoot).mode & 0o7777).toBe(0o700);
    expect(statSync(config.backupRoot).mode & 0o7777).toBe(0o700);
    expect(statSync(config.mediaRoot).mode & 0o7777).toBe(
      process.platform === 'linux' ? 0o2750 : 0o750,
    );

    await runtime.shutdown();
    expect(application.close).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
  });

  it('handles repeated termination signals with one ordered shutdown', async () => {
    const order: string[] = [];
    const config = testConfig();
    const db = fakeDatabase(order);
    const application = fakeApplication(order);
    const signals = signalSource();
    const controlled = controlledTimers();

    const runtime = await startApi({
      config,
      signalSource: signals,
      timers: controlled.timers,
      openDatabase: () => db,
      runMigrations: () => undefined,
      verifyHeifTool: async () => undefined,
      createSessionService: async () => sessionService(),
      createApp: () => application.app,
    });

    order.length = 0;
    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    await runtime.closed;

    expect(order).toEqual(['server.close', 'app.close', 'db.close']);
    expect(controlled.cleared).toHaveLength(1);
    expect(application.stopAccepting).toHaveBeenCalledOnce();
    expect(application.close).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('keeps signal guards and bounds stuck HTTP shutdown with the single grace timeout', async () => {
    const order: string[] = [];
    const config = testConfig();
    const db = fakeDatabase(order);
    const application = fakeApplication(order);
    application.stopAccepting.mockImplementation(() => {
      order.push('server.close');
    });
    application.close.mockImplementation(() => {
      order.push('app.close');
      return new Promise<void>(() => undefined);
    });
    const signals = signalSource();
    const intervals: Array<() => void> = [];
    const timeouts: Array<() => void> = [];
    const timers: ApiTimers = {
      setInterval(callback) { intervals.push(callback); return callback; },
      clearInterval: vi.fn(),
      setTimeout(callback) { timeouts.push(callback); return callback; },
      clearTimeout: vi.fn(),
    };
    const runtime = await startApi({
      config,
      signalSource: signals,
      timers,
      openDatabase: () => db,
      runMigrations: () => undefined,
      verifyHeifTool: async () => undefined,
      createSessionService: async () => sessionService(),
      createApp: () => application.app,
    });

    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    await Promise.resolve();

    expect(signals.listenerCount('SIGTERM')).toBe(1);
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(application.stopAccepting).toHaveBeenCalledOnce();
    expect(application.close).toHaveBeenCalledOnce();
    expect(timeouts).toHaveLength(1);
    expect(db.close).not.toHaveBeenCalled();

    timeouts[0]?.();
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve();
    }
    await runtime.closed;

    expect(application.app.server.closeAllConnections).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
    expect(intervals).toHaveLength(1);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('does not overlap hourly maintenance and continues after a failed run', async () => {
    const config = testConfig();
    const order: string[] = [];
    const db = fakeDatabase(order);
    const application = fakeApplication(order);
    const controlled = controlledTimers();
    let rejectFirst: ((error: Error) => void) | undefined;
    const run = vi.fn<MaintenanceService['run']>(() => new Promise((_resolve, reject) => {
      rejectFirst = reject;
    }));

    const runtime = await startApi({
      config,
      signalSource: signalSource(),
      timers: controlled.timers,
      openDatabase: () => db,
      runMigrations: () => undefined,
      verifyHeifTool: async () => undefined,
      createSessionService: async () => sessionService(),
      createMaintenanceService: () => ({ run }),
      createApp: () => application.app,
    });

    expect(controlled.intervals).toHaveLength(1);
    controlled.intervals[0]?.();
    controlled.intervals[0]?.();
    expect(run).toHaveBeenCalledOnce();
    rejectFirst?.(new Error('maintenance failed'));
    await Promise.resolve();
    await Promise.resolve();

    run.mockResolvedValueOnce({
      inspected: 0,
      removedMedia: 0,
      removedStaging: 0,
      removedDeleting: 0,
      expiredSessions: 0,
      failures: 0,
    });
    controlled.intervals[0]?.();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);

    await runtime.shutdown();
  });

  it('finishes shutdown after one 60-second grace with queue and maintenance still active', async () => {
    const config = testConfig();
    const order: string[] = [];
    const db = fakeDatabase(order);
    const application = fakeApplication(order);
    const signals = signalSource();
    const intervals: Array<() => void> = [];
    const timeouts: Array<() => void> = [];
    const timers: ApiTimers = {
      setInterval(callback) { intervals.push(callback); return callback; },
      clearInterval: vi.fn(),
      setTimeout(callback) { timeouts.push(callback); return callback; },
      clearTimeout: vi.fn(),
    };
    const queue = new ProcessingQueue();
    let rejectJob: (error: Error) => void = () => undefined;
    const job = queue.run(() => new Promise<void>((_resolveJob, reject) => {
      rejectJob = reject;
    }));
    void job.catch(() => undefined);
    const pendingJob = vi.fn(async () => undefined);
    const pending = queue.run(pendingJob);
    const pendingRejection = expect(pending).rejects.toMatchObject({
      code: 'UPLOAD_QUEUE_CLOSED',
      name: 'ProcessingQueueClosedError',
    });
    let rejectMaintenance: (error: Error) => void = () => undefined;
    const run = vi.fn<MaintenanceService['run']>(() => new Promise((_resolveRun, reject) => {
      rejectMaintenance = reject;
    }));
    const runtime = await startApi({
      config,
      signalSource: signals,
      timers,
      processingQueue: queue,
      openDatabase: () => db,
      runMigrations: () => undefined,
      verifyHeifTool: async () => undefined,
      createSessionService: async () => sessionService(),
      createMaintenanceService: () => ({ run }),
      createApp: () => application.app,
    });
    intervals[0]?.();
    expect(run).toHaveBeenCalledOnce();

    let shutdownFinished = false;
    const shutdown = runtime.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    await pendingRejection;
    expect(pendingJob).not.toHaveBeenCalled();
    expect(queue.pendingCount).toBe(0);
    expect(timeouts).toHaveLength(1);
    timeouts[0]?.();
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve();
    }

    expect(shutdownFinished).toBe(true);
    expect(application.close).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
    expect(intervals).toHaveLength(2);
    expect(application.app.server.closeAllConnections).toHaveBeenCalledOnce();
    expect(order.indexOf('app.close')).toBeLessThan(order.indexOf('db.close'));
    await shutdown;
    await runtime.closed;

    rejectJob(new Error('late queue failure'));
    rejectMaintenance(new Error('late maintenance failure'));
    await Promise.allSettled([job]);
    await Promise.resolve();
    expect(pendingJob).not.toHaveBeenCalled();
  });

  it('waits for in-flight maintenance before closing the shared database', async () => {
    const config = testConfig();
    const order: string[] = [];
    const db = fakeDatabase(order);
    const application = fakeApplication(order);
    const controlled = controlledTimers();
    let finishMaintenance = (): void => undefined;
    const run = vi.fn<MaintenanceService['run']>(() => new Promise((resolveRun) => {
      finishMaintenance = () => resolveRun({
        inspected: 0,
        removedMedia: 0,
        removedStaging: 0,
        removedDeleting: 0,
        expiredSessions: 0,
        failures: 0,
      });
    }));
    const runtime = await startApi({
      config,
      signalSource: signalSource(),
      timers: controlled.timers,
      openDatabase: () => db,
      runMigrations: () => undefined,
      verifyHeifTool: async () => undefined,
      createSessionService: async () => sessionService(),
      createMaintenanceService: () => ({ run }),
      createApp: () => application.app,
    });
    controlled.intervals[0]?.();
    expect(run).toHaveBeenCalledOnce();

    const shutdown = runtime.shutdown();
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve();
    }
    expect(application.close).toHaveBeenCalledOnce();
    expect(db.close).not.toHaveBeenCalled();

    finishMaintenance();
    await shutdown;
    expect(application.close).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
    expect(order.indexOf('app.close')).toBeLessThan(order.indexOf('db.close'));
  });

  it('unwinds app, database and maintenance timer when listen fails', async () => {
    const config = testConfig();
    const order: string[] = [];
    const db = fakeDatabase(order);
    const application = fakeApplication(order);
    application.listen.mockRejectedValueOnce(new Error('listen failed'));
    const controlled = controlledTimers();

    await expect(startApi({
      config,
      signalSource: signalSource(),
      timers: controlled.timers,
      openDatabase: () => db,
      runMigrations: () => undefined,
      verifyHeifTool: async () => undefined,
      createSessionService: async () => sessionService(),
      createApp: () => application.app,
      processingQueue: new ProcessingQueue(),
    })).rejects.toThrow('listen failed');

    expect(controlled.cleared).toHaveLength(1);
    expect(application.close).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
  });

  it('rejects a symlinked child ancestor before creating or chmodding outside dataRoot', async () => {
    const config = testConfig();
    const outside = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'sweet-memories-runtime-outside-')),
    );
    temporaryRoots.push(outside);
    const originalMode = statSync(outside).mode & 0o7777;
    symlinkSync(outside, config.mediaRoot);
    const unsafeConfig = Object.freeze({
      ...config,
      mediaRoot: join(config.mediaRoot, 'nested-media'),
    });
    const open = vi.fn();

    await expect(startApi({
      config: unsafeConfig,
      openDatabase: open,
    })).rejects.toThrow('运行目录状态不安全');

    expect(open).not.toHaveBeenCalled();
    expect(existsSync(join(outside, 'nested-media'))).toBe(false);
    expect(statSync(outside).mode & 0o7777).toBe(originalMode);
  });

  it('sanitizes configuration failures through the direct-entry main boundary', async () => {
    const entryModule = await import('./index.js');
    const main = Reflect.get(entryModule, 'main');
    expect(main).toBeTypeOf('function');
    const writeError = vi.fn();
    const setExitCode = vi.fn();
    const start = vi.fn();

    await main({
      loadConfig: () => { throw new Error('/private/config/path'); },
      startApi: start,
      writeError,
      setExitCode,
    });

    expect(start).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledExactlyOnceWith('图片 API 启动失败\n');
    expect(setExitCode).toHaveBeenCalledExactlyOnceWith(1);
  });
});
