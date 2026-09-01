// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InputInspection } from '../media/inspect-input.js';
import type { ProcessPhotoOptions, ProcessedPhotoManifest } from '../media/processor.js';
import { ProcessingQueue } from '../media/processing-queue.js';
import { MEDIA_GROUP_NAME, MediaStorage } from '../media/storage.js';
import { runMigrations } from '../migrations.js';
import {
  MAX_UPLOAD_BYTES,
  MIN_FREE_BYTES,
  createUploadPhotoService,
  defaultTitle,
} from './upload-photo.js';

const migrationsRoot = fileURLToPath(new URL('../../migrations', import.meta.url));
const currentGroupId = process.getgid?.();
const firstPhotoId = '0195c681-9c63-7db0-8000-000000000001';
const secondPhotoId = '0195c681-9c63-7db0-8000-000000000002';
const firstRequestId = '0195c681-9c63-7db0-8000-000000000101';
const secondRequestId = '0195c681-9c63-7db0-8000-000000000102';

let root: string;
let mediaRoot: string;
let stagingRoot: string;
let db: Database.Database;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function photoCount(): number {
  return (db.prepare('SELECT count(*) AS count FROM photos').get() as { count: number }).count;
}

function enableUploads(): void {
  db.prepare("UPDATE settings SET value = 'true' WHERE key = 'uploads_enabled'").run();
}

function inputInspection(takenDate: string | null = '2026-02-03'): InputInspection {
  return {
    width: 800,
    height: 600,
    kind: 'jpeg',
    mime: 'image/jpeg',
    takenDate,
  };
}

async function fakeProcessPhoto(options: ProcessPhotoOptions): Promise<ProcessedPhotoManifest> {
  const original = await readFile(options.inputPath);
  expect(original.length).toBeGreaterThan(0);
  const master = {
    kind: 'master' as const,
    format: 'jpeg' as const,
    width: 800,
    height: 600,
    relativePath: `${options.transaction.photoId}/master.jpg`,
  };
  const assets = [
    {
      kind: 'responsive' as const,
      format: 'avif' as const,
      width: 320,
      height: 240,
      relativePath: `${options.transaction.photoId}/320.avif`,
    },
    {
      kind: 'responsive' as const,
      format: 'webp' as const,
      width: 320,
      height: 240,
      relativePath: `${options.transaction.photoId}/320.webp`,
    },
    {
      kind: 'responsive' as const,
      format: 'jpeg' as const,
      width: 320,
      height: 240,
      relativePath: `${options.transaction.photoId}/320.jpeg`,
    },
  ];
  await Promise.all([
    writeFile(join(options.transaction.stagingDir, 'master.jpg'), original),
    writeFile(join(options.transaction.stagingDir, '320.avif'), original),
    writeFile(join(options.transaction.stagingDir, '320.webp'), original),
    writeFile(join(options.transaction.stagingDir, '320.jpeg'), original),
  ]);
  await rm(options.inputPath, { force: true });
  await options.transaction.commit();
  return { master, assets };
}

interface ServiceOverrides {
  readonly createPhotoId?: () => string;
  readonly inspectInput?: (inputPath: string, heifInfoPath: string) => Promise<InputInspection>;
  readonly now?: () => Date;
  readonly processPhoto?: (options: ProcessPhotoOptions) => Promise<ProcessedPhotoManifest>;
  readonly processingQueue?: ProcessingQueue;
  readonly statfs?: (path: string) => Promise<{ bavail: bigint; bsize: bigint }>;
}

function createService(overrides: ServiceOverrides = {}) {
  const ids = [firstPhotoId, secondPhotoId];
  let nextId = 0;
  return createUploadPhotoService({
    db,
    diskPath: stagingRoot,
    storage: new MediaStorage({
      mediaRoot,
      stagingRoot,
      resolveMediaGroupId: async (groupName) => {
        expect(groupName).toBe(MEDIA_GROUP_NAME);
        return currentGroupId as number;
      },
      getProcessGroupId: () => currentGroupId as number,
    }),
    processingQueue: overrides.processingQueue ?? new ProcessingQueue(),
    statfs: overrides.statfs ?? (async () => ({
      bavail: MIN_FREE_BYTES,
      bsize: 1n,
    })),
    inspectInput: overrides.inspectInput ?? (async () => inputInspection()),
    processPhoto: overrides.processPhoto ?? fakeProcessPhoto,
    heifInfoPath: '/configured/heif-info',
    heifConvertPath: '/configured/heif-convert',
    now: overrides.now ?? (() => new Date('2026-08-31T16:30:00.000Z')),
    createPhotoId: overrides.createPhotoId ?? (() => ids[nextId++] as string),
  });
}

function unreadableStream(): Readable {
  return new Readable({
    read() {
      this.destroy(new Error('stream must not be read'));
    },
  });
}

beforeEach(async () => {
  if (currentGroupId === undefined) {
    throw new Error('Upload tests require a POSIX process');
  }
  root = await mkdtemp(join(tmpdir(), 'sweet-memories-upload-'));
  mediaRoot = join(root, 'media');
  stagingRoot = join(root, 'staging');
  await Promise.all([mkdir(mediaRoot), mkdir(stagingRoot)]);
  db = new Database(join(root, 'upload.sqlite3'));
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsRoot);
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe('upload service admission and idempotency', () => {
  it('rejects disabled uploads before statfs, reading the stream, or creating staging', async () => {
    const statfs = vi.fn(async () => ({ bavail: MIN_FREE_BYTES, bsize: 1n }));
    const service = createService({ statfs });

    await expect(service.upload({ requestId: firstRequestId, stream: unreadableStream() }))
      .rejects.toMatchObject({ statusCode: 423, code: 'UPLOADS_DISABLED' });
    expect(statfs).not.toHaveBeenCalled();
    expect(await readdir(stagingRoot)).toEqual([]);
    expect(await readdir(mediaRoot)).toEqual([]);
    expect(photoCount()).toBe(0);
  });

  it('returns an existing photo before statfs or stream consumption on idempotent replay', async () => {
    enableUploads();
    const statfs = vi.fn(async () => ({ bavail: MIN_FREE_BYTES, bsize: 1n }));
    const processPhoto = vi.fn(fakeProcessPhoto);
    const service = createService({ statfs, processPhoto });
    const first = await service.upload({
      requestId: firstRequestId,
      stream: Readable.from(Buffer.from('first image')),
    });
    const callsAfterFirst = statfs.mock.calls.length;

    const second = await service.upload({
      requestId: firstRequestId,
      stream: unreadableStream(),
    });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.photo.id).toBe(first.photo.id);
    expect(photoCount()).toBe(1);
    expect(statfs).toHaveBeenCalledTimes(callsAfterFirst);
    expect(processPhoto).toHaveBeenCalledOnce();
  });

  it('creates distinct photos for distinct request ids', async () => {
    enableUploads();
    const service = createService();

    const first = await service.upload({
      requestId: firstRequestId,
      stream: Readable.from(Buffer.from('first image')),
    });
    const second = await service.upload({
      requestId: secondRequestId,
      stream: Readable.from(Buffer.from('second image')),
    });

    expect(first.photo.id).toBe(firstPhotoId);
    expect(second.photo.id).toBe(secondPhotoId);
    expect(photoCount()).toBe(2);
  });

  it('deduplicates concurrent requests after the queue without processing twice', async () => {
    enableUploads();
    const processStarted = deferred<void>();
    const allowProcess = deferred<void>();
    const processPhoto = vi.fn(async (options: ProcessPhotoOptions) => {
      processStarted.resolve();
      await allowProcess.promise;
      return fakeProcessPhoto(options);
    });
    const service = createService({ processPhoto });

    const first = service.upload({
      requestId: firstRequestId,
      stream: Readable.from(Buffer.from('first attempt')),
    });
    await processStarted.promise;
    const second = service.upload({
      requestId: firstRequestId,
      stream: Readable.from(Buffer.from('concurrent retry')),
    });
    allowProcess.resolve();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.replayed).toBe(false);
    expect(secondResult.replayed).toBe(true);
    expect(secondResult.photo.id).toBe(firstResult.photo.id);
    expect(processPhoto).toHaveBeenCalledOnce();
    expect(photoCount()).toBe(1);
    expect(await readdir(stagingRoot)).toEqual([]);
    expect(await readdir(mediaRoot)).toEqual([firstPhotoId]);
  });
});

describe('upload service resource boundaries', () => {
  it('rejects below 5 GiB but admits exactly 5 GiB before reading the stream', async () => {
    enableUploads();
    const low = createService({
      statfs: async () => ({ bavail: MIN_FREE_BYTES - 1n, bsize: 1n }),
    });
    await expect(low.upload({ requestId: firstRequestId, stream: unreadableStream() }))
      .rejects.toMatchObject({ statusCode: 507, code: 'INSUFFICIENT_STORAGE' });
    expect(await readdir(stagingRoot)).toEqual([]);

    const exact = createService({
      statfs: async () => ({ bavail: MIN_FREE_BYTES / 4096n, bsize: 4096n }),
    });
    await expect(exact.upload({
      requestId: firstRequestId,
      stream: Readable.from(Buffer.from('exact threshold')),
    })).resolves.toMatchObject({ replayed: false });
  });

  it('aborts a stream above 10 MiB and removes all staging and published files', async () => {
    enableUploads();
    const service = createService();

    await expect(service.upload({
      requestId: firstRequestId,
      stream: Readable.from(Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1)),
    })).rejects.toMatchObject({ statusCode: 413, code: 'UPLOAD_TOO_LARGE' });

    expect(photoCount()).toBe(0);
    expect(await readdir(stagingRoot)).toEqual([]);
    expect(await readdir(mediaRoot)).toEqual([]);
  });

  it('maps a full one-active-nine-pending processing queue to 429 and cleans staging', async () => {
    enableUploads();
    const queue = new ProcessingQueue();
    const blocker = deferred<void>();
    const occupied = Array.from({ length: 10 }, () => queue.run(async () => blocker.promise));
    const service = createService({ processingQueue: queue });

    await expect(service.upload({
      requestId: firstRequestId,
      stream: Readable.from(Buffer.from('queued image')),
    })).rejects.toMatchObject({ statusCode: 429, code: 'UPLOAD_QUEUE_FULL' });
    expect(await readdir(stagingRoot)).toEqual([]);
    expect(await readdir(mediaRoot)).toEqual([]);
    expect(photoCount()).toBe(0);

    blocker.resolve();
    await Promise.all(occupied);
  });

  it('rolls back an already published directory when the SQLite insert fails', async () => {
    enableUploads();
    db.exec(`
      CREATE TRIGGER reject_uploaded_photo
      BEFORE INSERT ON photos
      BEGIN
        SELECT RAISE(ABORT, 'injected database failure');
      END;
    `);
    const service = createService();

    await expect(service.upload({
      requestId: firstRequestId,
      stream: Readable.from(Buffer.from('valid image')),
    })).rejects.toThrow('injected database failure');

    expect(photoCount()).toBe(0);
    expect(await readdir(stagingRoot)).toEqual([]);
    expect(await readdir(mediaRoot)).toEqual([]);
  });

  it('rolls back both SQLite and published media when the inserted manifest cannot be mapped', async () => {
    enableUploads();
    const processPhoto = async (options: ProcessPhotoOptions): Promise<ProcessedPhotoManifest> => {
      const manifest = await fakeProcessPhoto(options);
      return {
        master: manifest.master,
        assets: manifest.assets.filter((asset) => asset.format !== 'jpeg'),
      };
    };
    const service = createService({ processPhoto });

    await expect(service.upload({
      requestId: firstRequestId,
      stream: Readable.from(Buffer.from('invalid manifest')),
    })).rejects.toThrow('Photo has no JPEG fallback');

    expect(photoCount()).toBe(0);
    expect(await readdir(stagingRoot)).toEqual([]);
    expect(await readdir(mediaRoot)).toEqual([]);
  });
});

describe('upload metadata and persisted manifest', () => {
  it('uses trusted EXIF date, the exact default title, configured HEIF tools, and stable transform', async () => {
    enableUploads();
    const inspectInput = vi.fn(async (_path: string, heifInfoPath: string) => {
      expect(heifInfoPath).toBe('/configured/heif-info');
      return inputInspection('2024-02-29');
    });
    const processPhoto = vi.fn(async (options: ProcessPhotoOptions) => {
      expect(options.heifConvertPath).toBe('/configured/heif-convert');
      return fakeProcessPhoto(options);
    });
    const service = createService({ inspectInput, processPhoto });

    const result = await service.upload({
      requestId: firstRequestId,
      stream: Readable.from(Buffer.from('valid image')),
    });
    const row = db.prepare(
      `SELECT title, captured_date, status, rotation, offset_x, offset_y, version
       FROM photos WHERE id = ?`,
    ).get(firstPhotoId);

    expect(defaultTitle('2024-02-29')).toBe('2024年2月29日的成长瞬间');
    expect(row).toEqual({
      title: '2024年2月29日的成长瞬间',
      captured_date: '2024-02-29',
      status: 'published',
      rotation: 6,
      offset_x: 12,
      offset_y: 0,
      version: 1,
    });
    expect(result.photo).toMatchObject({
      id: firstPhotoId,
      title: '2024年2月29日的成长瞬间',
      capturedDate: '2024-02-29',
      status: 'published',
      transform: { rotation: 6, x: 12, y: 0 },
    });
    expect(result.photo).not.toHaveProperty('requestId');
    expect(result.photo).not.toHaveProperty('filename');
    expect(inspectInput).toHaveBeenCalledOnce();
    expect(processPhoto).toHaveBeenCalledOnce();
  });

  it('uses the Asia/Shanghai calendar date from an injected clock when EXIF is absent', async () => {
    enableUploads();
    const service = createService({
      inspectInput: async () => inputInspection(null),
      now: () => new Date('2026-08-31T16:30:00.000Z'),
    });

    const result = await service.upload({
      requestId: firstRequestId,
      stream: Readable.from(Buffer.from('no exif image')),
    });

    expect(result.photo.capturedDate).toBe('2026-09-01');
    expect(result.photo.title).toBe('2026年9月1日的成长瞬间');
  });

  it('inserts the photo and every generated asset in one SQLite transaction', async () => {
    enableUploads();
    const service = createService();
    await service.upload({
      requestId: firstRequestId,
      stream: Readable.from(Buffer.from('manifest image')),
    });

    expect(db.prepare(
      `SELECT kind, format, width, height, relative_path
       FROM photo_assets WHERE photo_id = ? ORDER BY relative_path`,
    ).all(firstPhotoId)).toEqual([
      { kind: 'responsive', format: 'avif', width: 320, height: 240, relative_path: `${firstPhotoId}/320.avif` },
      { kind: 'responsive', format: 'jpeg', width: 320, height: 240, relative_path: `${firstPhotoId}/320.jpeg` },
      { kind: 'responsive', format: 'webp', width: 320, height: 240, relative_path: `${firstPhotoId}/320.webp` },
      { kind: 'master', format: 'jpeg', width: 800, height: 600, relative_path: `${firstPhotoId}/master.jpg` },
    ]);
  });
});
