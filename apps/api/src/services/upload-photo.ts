import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { statfs as fileSystemStatfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type Database from 'better-sqlite3';

import { ApiHttpError } from '../http/security.js';
import { inspectHeif } from '../media/heif-tools.js';
import {
  InputInspectionError,
  inspectInput as inspectPhotoInput,
  type InputInspection,
} from '../media/inspect-input.js';
import {
  processPhoto as generatePhotoMedia,
  type ProcessPhotoOptions,
  type ProcessedPhotoManifest,
} from '../media/processor.js';
import {
  ProcessingQueue,
  ProcessingQueueError,
} from '../media/processing-queue.js';
import type { MediaStorage } from '../media/storage.js';
import {
  createPhotoService,
  type AdminPhotoDto,
} from './photo-service.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MIN_FREE_BYTES = 5n * 1024n * 1024n * 1024n;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type InspectUploadedInput = (
  inputPath: string,
  heifInfoPath: string,
) => Promise<InputInspection>;
type ProcessUploadedPhoto = (
  options: ProcessPhotoOptions,
) => Promise<ProcessedPhotoManifest>;
type StatFileSystem = (
  path: string,
) => Promise<{ readonly bavail: bigint; readonly bsize: bigint }>;

export interface UploadPhotoInput {
  readonly requestId: string;
  readonly stream: Readable;
}

export interface UploadPhotoResult {
  readonly photo: AdminPhotoDto;
  readonly replayed: boolean;
}

export interface UploadPhotoService {
  upload(input: UploadPhotoInput): Promise<UploadPhotoResult>;
}

export interface CreateUploadPhotoServiceOptions {
  readonly db: Database.Database;
  readonly diskPath: string;
  readonly storage: Pick<MediaStorage, 'createTransaction'>;
  readonly processingQueue?: ProcessingQueue;
  readonly statfs?: StatFileSystem;
  readonly inspectInput?: InspectUploadedInput;
  readonly processPhoto?: ProcessUploadedPhoto;
  readonly heifInfoPath: string;
  readonly heifConvertPath: string;
  readonly now?: () => Date;
  readonly createPhotoId?: () => string;
}

class UploadPhotoError extends ApiHttpError {
  constructor(statusCode: number, code: string, publicMessage: string) {
    super(statusCode, code, publicMessage);
    this.name = 'UploadPhotoError';
  }
}

function defaultStatfs(path: string): Promise<{ bavail: bigint; bsize: bigint }> {
  return fileSystemStatfs(path, { bigint: true });
}

async function defaultInspectInput(
  inputPath: string,
  heifInfoPath: string,
): Promise<InputInspection> {
  return inspectPhotoInput(inputPath, {
    inspectHeif: (path) => inspectHeif(path, { executable: heifInfoPath }),
  });
}

export function defaultTitle(capturedDate: string): string {
  const [, month, day] = capturedDate.split('-').map(Number);
  return `${capturedDate.slice(0, 4)}年${month}月${day}日的成长瞬间`;
}

function shanghaiCalendarDate(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error('Invalid clock value');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value('year');
  const month = value('month');
  const day = value('day');
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('Invalid Shanghai calendar date');
  }
  return `${year}-${month}-${day}`;
}

function stableTransform(photoId: string): {
  readonly rotation: number;
  readonly offsetX: number;
  readonly offsetY: number;
} {
  const digest = createHash('sha256').update(photoId, 'utf8').digest();
  return {
    rotation: (digest[0] as number) % 13 - 6,
    offsetX: (digest[1] as number) % 33 - 16,
    offsetY: (digest[2] as number) % 33 - 16,
  };
}

function uploadSettingEnabled(db: Database.Database): boolean {
  const setting = db.prepare(
    "SELECT value FROM settings WHERE key = 'uploads_enabled'",
  ).get() as { value: string } | undefined;
  return setting?.value === 'true';
}

function fileSizeLimiter(): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        callback(new UploadPhotoError(
          413,
          'UPLOAD_TOO_LARGE',
          '单张图片不能超过 10MB',
        ));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function writePrivateInput(stream: Readable, inputPath: string): Promise<void> {
  await pipeline(
    stream,
    fileSizeLimiter(),
    createWriteStream(inputPath, { flags: 'wx', mode: 0o600 }),
  );
}

function insertPhoto<T>(
  db: Database.Database,
  input: {
    readonly photoId: string;
    readonly requestId: string;
    readonly capturedDate: string;
    readonly createdAt: string;
    readonly manifest: ProcessedPhotoManifest;
  },
  mapInsertedPhoto: () => T,
): T {
  const transform = stableTransform(input.photoId);
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO photos(
         id, title, description, captured_date, status, rotation, offset_x, offset_y,
         request_id, version, created_at, updated_at
       ) VALUES (?, ?, NULL, ?, 'published', ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      input.photoId,
      defaultTitle(input.capturedDate),
      input.capturedDate,
      transform.rotation,
      transform.offsetX,
      transform.offsetY,
      input.requestId,
      input.createdAt,
      input.createdAt,
    );

    const insertAsset = db.prepare(
      `INSERT INTO photo_assets(photo_id, kind, format, width, height, relative_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const asset of [input.manifest.master, ...input.manifest.assets]) {
      insertAsset.run(
        input.photoId,
        asset.kind,
        asset.format,
        asset.width,
        asset.height,
        asset.relativePath,
      );
    }
    return mapInsertedPhoto();
  }).immediate();
}

class SqliteUploadPhotoService implements UploadPhotoService {
  private readonly catalog;
  private readonly queue: ProcessingQueue;
  private readonly statfs: StatFileSystem;
  private readonly inspectInput: InspectUploadedInput;
  private readonly processPhoto: ProcessUploadedPhoto;
  private readonly now: () => Date;
  private readonly createPhotoId: () => string;

  constructor(private readonly options: CreateUploadPhotoServiceOptions) {
    this.catalog = createPhotoService({ db: options.db });
    this.queue = options.processingQueue ?? new ProcessingQueue();
    this.statfs = options.statfs ?? defaultStatfs;
    this.inspectInput = options.inspectInput ?? defaultInspectInput;
    this.processPhoto = options.processPhoto ?? generatePhotoMedia;
    this.now = options.now ?? (() => new Date());
    this.createPhotoId = options.createPhotoId ?? randomUUID;
  }

  async upload(input: UploadPhotoInput): Promise<UploadPhotoResult> {
    if (!uploadSettingEnabled(this.options.db)) {
      throw new UploadPhotoError(423, 'UPLOADS_DISABLED', '图片上传暂未开放');
    }
    if (!CANONICAL_UUID.test(input.requestId)) {
      throw new UploadPhotoError(400, 'INVALID_IDEMPOTENCY_KEY', '上传请求 ID 无效');
    }
    const existing = this.findByRequestId(input.requestId);
    if (existing !== undefined) {
      return { photo: existing, replayed: true };
    }

    const fileSystem = await this.statfs(this.options.diskPath);
    if (fileSystem.bavail * fileSystem.bsize < MIN_FREE_BYTES) {
      throw new UploadPhotoError(507, 'INSUFFICIENT_STORAGE', '服务器存储空间不足');
    }

    const photoId = this.createPhotoId();
    const transaction = await this.options.storage.createTransaction(photoId);
    const inputPath = join(transaction.stagingDir, '.upload-input');
    const uploadDate = shanghaiCalendarDate(this.now());
    let completed = false;

    try {
      await writePrivateInput(input.stream, inputPath);
      const result = await this.queue.run(async () => {
        const queuedReplay = this.findByRequestId(input.requestId);
        if (queuedReplay !== undefined) {
          await transaction.rollback();
          completed = true;
          return { photo: queuedReplay, replayed: true };
        }

        const inspection = await this.inspectInput(inputPath, this.options.heifInfoPath);
        const manifest = await this.processPhoto({
          inputPath,
          inputKind: inspection.kind,
          transaction,
          heifConvertPath: this.options.heifConvertPath,
        });
        const createdAt = this.now();
        if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) {
          throw new Error('Invalid clock value');
        }
        const capturedDate = inspection.takenDate ?? uploadDate;
        let photo: AdminPhotoDto;
        try {
          photo = insertPhoto(this.options.db, {
            photoId,
            requestId: input.requestId,
            capturedDate,
            createdAt: createdAt.toISOString(),
            manifest,
          }, () => {
            const inserted = this.findByRequestId(input.requestId);
            if (inserted === undefined) {
              throw new Error('Inserted photo could not be read');
            }
            return inserted;
          });
        } catch (error) {
          await transaction.rollback();
          const replay = this.findByRequestId(input.requestId);
          if (replay !== undefined) {
            completed = true;
            return { photo: replay, replayed: true };
          }
          throw error;
        }
        completed = true;
        return { photo, replayed: false };
      });
      return result;
    } catch (error) {
      if (error instanceof ProcessingQueueError) {
        throw new UploadPhotoError(429, 'UPLOAD_QUEUE_FULL', '图片处理队列繁忙，请稍后重试');
      }
      if (error instanceof InputInspectionError) {
        throw new UploadPhotoError(415, error.code, error.message);
      }
      throw error;
    } finally {
      if (!completed) {
        await transaction.rollback();
      }
    }
  }

  private findByRequestId(requestId: string): AdminPhotoDto | undefined {
    const row = this.options.db.prepare(
      'SELECT id FROM photos WHERE request_id = ?',
    ).get(requestId) as { id: string } | undefined;
    if (row === undefined) {
      return undefined;
    }
    const photo = this.catalog.listAdminPhotos().find((candidate) => candidate.id === row.id);
    if (photo === undefined) {
      throw new Error('Photo request id points to a missing photo');
    }
    return photo;
  }
}

export function createUploadPhotoService(
  options: CreateUploadPhotoServiceOptions,
): UploadPhotoService {
  return new SqliteUploadPhotoService(options);
}
