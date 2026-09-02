import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  open as openFile,
  realpath,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { constants, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import { buildApp, type AppDependencies } from './app.js';
import { createSessionService, type SessionService } from './auth/session-service.js';
import { loadConfig, type ApiConfig } from './config.js';
import { openDatabase } from './database.js';
import {
  HEIF_MAX_BUFFER_BYTES,
  HEIF_TOOL_TIMEOUT_MS,
} from './media/heif-tools.js';
import { ProcessingQueue } from './media/processing-queue.js';
import { MediaStorage } from './media/storage.js';
import { runMigrations } from './migrations.js';
import { createDeletePhotoService } from './services/delete-photo.js';
import {
  createMaintenanceService,
  type CreateMaintenanceServiceOptions,
  type MaintenanceService,
} from './services/maintenance.js';
import { createPhotoService } from './services/photo-service.js';
import { createUploadPhotoService } from './services/upload-photo.js';

export const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;
export const QUEUE_DRAIN_TIMEOUT_MS = 60_000;
const QUEUE_POLL_INTERVAL_MS = 25;

export interface ApiTimers {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ApiSignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export type VerifyHeifTool = (executable: string) => Promise<void>;

export interface StartApiOptions {
  readonly config: Readonly<ApiConfig>;
  readonly clock?: () => Date;
  readonly timers?: ApiTimers;
  readonly signalSource?: ApiSignalSource;
  readonly createApp?: (dependencies: AppDependencies) => FastifyInstance;
  readonly openDatabase?: (config: ApiConfig) => Database.Database;
  readonly runMigrations?: (db: Database.Database, migrationsRoot: string) => void;
  readonly verifyHeifTool?: VerifyHeifTool;
  readonly createSessionService?: (
    options: Parameters<typeof createSessionService>[0],
  ) => Promise<SessionService>;
  readonly createMaintenanceService?: (
    options: CreateMaintenanceServiceOptions,
  ) => MaintenanceService;
  readonly processingQueue?: ProcessingQueue;
}

export interface ApiRuntime {
  readonly app: FastifyInstance;
  readonly processingQueue: ProcessingQueue;
  readonly closed: Promise<void>;
  shutdown(): Promise<void>;
}

const systemTimers: ApiTimers = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot.length === 0
    || (
      fromRoot !== '..'
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    );
}

async function inspectDirectory(
  path: string,
  expectedCanonical: string,
  mode?: number,
): Promise<string> {
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error('运行目录状态不安全');
  }
  const canonical = await realpath(path);
  if (canonical !== expectedCanonical) {
    throw new Error('运行目录状态不安全');
  }
  const handle = await openFile(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || opened.dev !== information.dev
      || opened.ino !== information.ino
    ) {
      throw new Error('运行目录状态不安全');
    }
    if (mode !== undefined) {
      await handle.chmod(mode);
      const afterChmod = await handle.stat();
      if (afterChmod.dev !== opened.dev || afterChmod.ino !== opened.ino) {
        throw new Error('运行目录状态不安全');
      }
    }
  } finally {
    await handle.close();
  }
  return canonical;
}

async function inspectExistingAncestors(path: string): Promise<string> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let configured = root;
  let canonical = await realpath(root);
  await inspectDirectory(configured, canonical);
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  for (const segment of segments) {
    configured = join(configured, segment);
    canonical = join(canonical, segment);
    await inspectDirectory(configured, canonical);
  }
  return canonical;
}

async function ensureDirectChild(
  parent: string,
  canonicalParent: string,
  name: string,
  mode: number,
): Promise<{ readonly configured: string; readonly canonical: string }> {
  if (name.length === 0 || name === '.' || name === '..' || name.includes(sep)) {
    throw new Error('运行目录状态不安全');
  }
  const configured = join(parent, name);
  const canonical = join(canonicalParent, name);
  try {
    await mkdir(configured, { mode });
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
  }
  await inspectDirectory(configured, canonical, mode);
  return { configured, canonical };
}

async function ensureDataRoot(path: string): Promise<{ configured: string; canonical: string }> {
  const configured = resolve(path);
  const parent = dirname(configured);
  if (configured === parent) {
    throw new Error('数据根目录不能是文件系统根目录');
  }
  const canonicalParent = await inspectExistingAncestors(parent);
  return ensureDirectChild(parent, canonicalParent, basename(configured), 0o750);
}

async function ensureDescendant(
  dataRoot: { readonly configured: string; readonly canonical: string },
  target: string,
  mode: number,
): Promise<string> {
  const configuredTarget = resolve(target);
  const fromRoot = relative(dataRoot.configured, configuredTarget);
  if (
    fromRoot.length === 0
    || fromRoot === '..'
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) {
    throw new Error('运行目录超出数据根目录');
  }
  let current = dataRoot;
  const segments = fromRoot.split(sep);
  for (const [index, segment] of segments.entries()) {
    current = await ensureDirectChild(
      current.configured,
      current.canonical,
      segment,
      index === segments.length - 1 ? mode : 0o700,
    );
  }
  return current.canonical;
}

async function assertDatabaseTarget(path: string): Promise<void> {
  try {
    const information = await lstat(path);
    if (!information.isFile() || information.isSymbolicLink()) {
      throw new Error('数据库文件状态不安全');
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function prepareRuntimeDirectories(config: Readonly<ApiConfig>): Promise<void> {
  const dataRoot = resolve(config.dataRoot);
  const databaseRoot = resolve(dirname(config.databasePath));
  const roots = [databaseRoot, config.mediaRoot, config.stagingRoot, config.backupRoot]
    .map((path) => resolve(path));
  if (!roots.every((path) => path !== dataRoot && contained(dataRoot, path))) {
    throw new Error('运行目录超出数据根目录');
  }

  for (const [index, left] of roots.entries()) {
    if (roots.some((right, rightIndex) => (
      rightIndex !== index && (contained(left, right) || contained(right, left))
    ))) {
      throw new Error('运行目录不能重叠');
    }
  }

  const securedDataRoot = await ensureDataRoot(dataRoot);
  const canonicalDataRoot = securedDataRoot.canonical;
  const canonicalDatabaseRoot = await ensureDescendant(securedDataRoot, databaseRoot, 0o700);
  const canonicalMediaRoot = await ensureDescendant(securedDataRoot, config.mediaRoot, 0o2750);
  const canonicalStagingRoot = await ensureDescendant(securedDataRoot, config.stagingRoot, 0o700);
  const canonicalBackupRoot = await ensureDescendant(securedDataRoot, config.backupRoot, 0o700);
  for (const path of [
    canonicalDatabaseRoot,
    canonicalMediaRoot,
    canonicalStagingRoot,
    canonicalBackupRoot,
  ]) {
    if (path === canonicalDataRoot || !contained(canonicalDataRoot, path)) {
      throw new Error('运行目录状态不安全');
    }
  }
  const canonicalRoots = [
    canonicalDatabaseRoot,
    canonicalMediaRoot,
    canonicalStagingRoot,
    canonicalBackupRoot,
  ];
  for (const [index, left] of canonicalRoots.entries()) {
    if (canonicalRoots.some((right, rightIndex) => (
      rightIndex !== index && contained(left, right)
    ))) {
      throw new Error('运行目录不能重叠');
    }
  }
  await assertDatabaseTarget(config.databasePath);
}

function defaultVerifyHeifTool(executable: string): Promise<void> {
  return new Promise((resolveVerification, rejectVerification) => {
    execFile(
      executable,
      ['--help'],
      {
        encoding: 'utf8',
        maxBuffer: HEIF_MAX_BUFFER_BYTES,
        shell: false,
        timeout: HEIF_TOOL_TIMEOUT_MS,
      },
      (error) => {
        if (error === null) {
          resolveVerification();
        } else {
          rejectVerification(new Error('HEIF 处理工具不可用'));
        }
      },
    );
  });
}

interface QueueDrainWait {
  readonly promise: Promise<void>;
  cancel(): void;
}

function waitForQueueDrain(
  queue: ProcessingQueue,
  timers: ApiTimers,
): QueueDrainWait {
  if (queue.activeCount === 0 && queue.pendingCount === 0) {
    return { promise: Promise.resolve(), cancel: () => undefined };
  }
  let resolveDrain = (): void => undefined;
  let settled = false;
  const handles: { interval?: unknown } = {};
  const promise = new Promise<void>((resolvePromise) => {
    resolveDrain = resolvePromise;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    if (handles.interval !== undefined) {
      timers.clearInterval(handles.interval);
    }
    resolveDrain();
  };
  handles.interval = timers.setInterval(() => {
    if (queue.activeCount === 0 && queue.pendingCount === 0) {
      finish();
    }
  }, QUEUE_POLL_INTERVAL_MS);
  return { promise, cancel: finish };
}

async function waitForShutdownGrace(
  queue: ProcessingQueue,
  tasks: readonly Promise<void>[],
  timers: ApiTimers,
): Promise<boolean> {
  if (
    queue.activeCount === 0
    && queue.pendingCount === 0
    && tasks.length === 0
  ) {
    return true;
  }
  const queueDrain = waitForQueueDrain(queue, timers);
  let timeout: unknown;
  const expired = new Promise<boolean>((resolveExpiration) => {
    timeout = timers.setTimeout(
      () => resolveExpiration(false),
      QUEUE_DRAIN_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      Promise.all([
        queueDrain.promise,
        ...tasks,
      ]).then(() => true),
      expired,
    ]);
  } finally {
    queueDrain.cancel();
    if (timeout !== undefined) timers.clearTimeout(timeout);
  }
}

function stopAccepting(app: FastifyInstance): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    if (!app.server.listening) {
      resolveClose();
      return;
    }
    app.server.close((error) => {
      if (
        error === undefined
        || (isNodeError(error) && error.code === 'ERR_SERVER_NOT_RUNNING')
      ) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
}

function closeDatabase(db: Database.Database): void {
  if (db.open === false) return;
  db.close();
}

export async function startApi(options: StartApiOptions): Promise<ApiRuntime> {
  const clock = options.clock ?? (() => new Date());
  const timers = options.timers ?? systemTimers;
  const signals = options.signalSource ?? process;
  const queue = options.processingQueue ?? new ProcessingQueue();
  const createApplication = options.createApp ?? buildApp;
  const open = options.openDatabase ?? openDatabase;
  const migrate = options.runMigrations ?? runMigrations;
  const verifyTool = options.verifyHeifTool ?? defaultVerifyHeifTool;
  const createSessions = options.createSessionService ?? createSessionService;
  const createMaintenance = options.createMaintenanceService ?? createMaintenanceService;
  let db: Database.Database | undefined;
  let app: FastifyInstance | undefined;
  let maintenanceTimer: unknown;
  let maintenanceTask: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let resolveClosed = (): void => undefined;
  let rejectClosed: (error: unknown) => void = () => undefined;
  const closed = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveClosed = resolvePromise;
    rejectClosed = rejectPromise;
  });
  // A signal-triggered failure is consumed here and reported by the direct entrypoint.
  void closed.catch(() => undefined);

  const removeSignalListeners = () => {
    signals.off('SIGINT', onSignal);
    signals.off('SIGTERM', onSignal);
  };
  const performShutdown = async (): Promise<void> => {
    let failure: unknown;
    const observe = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failure ??= error;
      }
    };
    try {
      queue.seal();
      if (maintenanceTimer !== undefined) {
        timers.clearInterval(maintenanceTimer);
        maintenanceTimer = undefined;
      }

      const tasks: Promise<void>[] = [];
      const application = app;
      if (application !== undefined) {
        tasks.push(observe(() => stopAccepting(application)));
        tasks.push(observe(() => application.close()));
      }
      if (maintenanceTask !== undefined) tasks.push(maintenanceTask);
      const drained = await waitForShutdownGrace(queue, tasks, timers);
      if (
        !drained
        && app !== undefined
        && typeof app.server.closeAllConnections === 'function'
      ) {
        try {
          app.server.closeAllConnections();
        } catch (error) {
          failure ??= error;
        }
      }
      if (db !== undefined) {
        try {
          closeDatabase(db);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
    } finally {
      removeSignalListeners();
    }
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = Promise.resolve().then(performShutdown).then(
      () => { resolveClosed(); },
      (error) => {
        rejectClosed(error);
        throw error;
      },
    );
    return shutdownPromise;
  };
  function onSignal(): void {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  }

  try {
    await prepareRuntimeDirectories(options.config);
    db = open(options.config);
    migrate(db, options.config.migrationsRoot);
    await verifyTool(options.config.heifInfoPath);
    await verifyTool(options.config.heifConvertPath);

    const sessionService = await createSessions({ db, now: clock });
    const photoService = createPhotoService({ db, now: clock });
    const storage = new MediaStorage({
      mediaRoot: options.config.mediaRoot,
      stagingRoot: options.config.stagingRoot,
    });
    const uploadPhotoService = createUploadPhotoService({
      db,
      diskPath: options.config.dataRoot,
      storage,
      processingQueue: queue,
      heifInfoPath: options.config.heifInfoPath,
      heifConvertPath: options.config.heifConvertPath,
      now: clock,
    });
    const deletePhotoService = createDeletePhotoService({
      db,
      mediaRoot: options.config.mediaRoot,
    });
    const maintenance = createMaintenance({
      db,
      mediaRoot: options.config.mediaRoot,
      stagingRoot: options.config.stagingRoot,
      now: clock,
    });
    app = createApplication({
      publicOrigin: options.config.origin,
      sessionService,
      photoService,
      uploadPhotoService,
      deletePhotoService,
    });

    maintenanceTimer = timers.setInterval(() => {
      if (maintenanceTask !== undefined) return;
      let runResult: ReturnType<MaintenanceService['run']>;
      try {
        runResult = maintenance.run();
      } catch (error) {
        runResult = Promise.reject(error);
      }
      const task = runResult
        .then(() => undefined, () => undefined)
        .finally(() => {
          if (maintenanceTask === task) maintenanceTask = undefined;
        });
      maintenanceTask = task;
      void task.catch(() => {
        // The task already sanitizes maintenance errors; this is a final guard.
      });
    }, MAINTENANCE_INTERVAL_MS);
    signals.on('SIGINT', onSignal);
    signals.on('SIGTERM', onSignal);
    await app.listen({ host: options.config.host, port: options.config.port });
    return { app, processingQueue: queue, closed, shutdown };
  } catch (error) {
    try {
      await shutdown();
    } catch {
      // Preserve the startup failure while still attempting every cleanup step.
    }
    throw error;
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(resolve(entry));
  } catch {
    return false;
  }
}

export interface MainDependencies {
  readonly loadConfig: typeof loadConfig;
  readonly setExitCode: (code: number) => void;
  readonly startApi: typeof startApi;
  readonly writeError: (message: string) => unknown;
}

export async function main(dependencies: MainDependencies): Promise<void> {
  try {
    await dependencies.startApi({ config: dependencies.loadConfig() });
  } catch {
    try {
      dependencies.writeError('图片 API 启动失败\n');
    } catch {
      // The exit status is still set if the diagnostic stream is unavailable.
    }
    dependencies.setExitCode(1);
  }
}

if (isDirectExecution()) {
  void main({
    loadConfig,
    startApi,
    writeError: (message) => process.stderr.write(message),
    setExitCode: (code) => { process.exitCode = code; },
  });
}
