// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionService, type SessionService } from '../auth/session-service.js';
import { buildApp } from '../app.js';
import type { ProcessPhotoOptions, ProcessedPhotoManifest } from '../media/processor.js';
import { ProcessingQueue } from '../media/processing-queue.js';
import { MediaStorage } from '../media/storage.js';
import { runMigrations } from '../migrations.js';
import { createPhotoService, type PhotoService } from '../services/photo-service.js';
import { MIN_FREE_BYTES, createUploadPhotoService } from '../services/upload-photo.js';

const migrationsRoot = fileURLToPath(new URL('../../migrations', import.meta.url));
const publicOrigin = 'https://huangjianfen.cn';
const cookieName = '__Host-sweet_memories_session';
const temporaryRoots: string[] = [];
const databases: Database.Database[] = [];
const applications: FastifyInstance[] = [];

interface TestContext {
  readonly app: FastifyInstance;
  readonly db: Database.Database;
  readonly photoService: PhotoService;
  readonly sessionService: SessionService;
  readonly cookie: string;
  readonly csrf: string;
  readonly mediaRoot: string;
  readonly stagingRoot: string;
}

const currentGroupId = process.getgid?.();

async function fakeProcessPhoto(options: ProcessPhotoOptions): Promise<ProcessedPhotoManifest> {
  const content = await readFile(options.inputPath);
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
    writeFile(join(options.transaction.stagingDir, 'master.jpg'), content),
    writeFile(join(options.transaction.stagingDir, '320.avif'), content),
    writeFile(join(options.transaction.stagingDir, '320.webp'), content),
    writeFile(join(options.transaction.stagingDir, '320.jpeg'), content),
  ]);
  await rm(options.inputPath, { force: true });
  await options.transaction.commit();
  return { master, assets };
}

function seedPhoto(
  db: Database.Database,
  input: {
    readonly id: string;
    readonly title?: string;
    readonly description?: string | null;
    readonly capturedDate?: string | null;
    readonly status?: 'migration_pending' | 'published';
    readonly version?: number;
    readonly createdAt?: string;
  },
): void {
  const createdAt = input.createdAt ?? '2026-02-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO photos(
       id, title, description, captured_date, status, rotation, offset_x, offset_y,
       request_id, version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.title ?? `Title ${input.id}`,
    input.description ?? null,
    input.capturedDate === undefined ? '2026-01-02' : input.capturedDate,
    input.status ?? 'published',
    -2,
    3,
    4,
    `private-request-${input.id}`,
    input.version ?? 1,
    createdAt,
    createdAt,
  );
}

function photoCountFor(db: Database.Database): number {
  return (db.prepare('SELECT count(*) AS count FROM photos').get() as { count: number }).count;
}

function seedAsset(
  db: Database.Database,
  input: {
    readonly photoId: string;
    readonly kind?: 'master' | 'responsive';
    readonly format: 'avif' | 'webp' | 'jpeg';
    readonly width: number;
    readonly height?: number;
    readonly relativePath?: string;
  },
): void {
  const extension = input.format === 'jpeg' ? 'jpg' : input.format;
  db.prepare(
    `INSERT INTO photo_assets(photo_id, kind, format, width, height, relative_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.photoId,
    input.kind ?? 'responsive',
    input.format,
    input.width,
    input.height ?? Math.round(input.width * 0.75),
    input.relativePath ?? `${input.photoId}/${input.width}.${extension}`,
  );
}

interface ContextOptions {
  readonly processingQueue?: ProcessingQueue;
  readonly statfs?: (path: string) => Promise<{ bavail: bigint; bsize: bigint }>;
}

async function createContext(options: ContextOptions = {}): Promise<TestContext> {
  if (currentGroupId === undefined) {
    throw new Error('Photo route tests require a POSIX process');
  }
  const root = mkdtempSync(join(tmpdir(), 'sweet-memories-photo-routes-'));
  temporaryRoots.push(root);
  const mediaRoot = join(root, 'media');
  const stagingRoot = join(root, 'staging');
  mkdirSync(mediaRoot);
  mkdirSync(stagingRoot);
  const db = new Database(join(root, 'routes.sqlite3'));
  databases.push(db);
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsRoot);
  db.prepare(
    `INSERT INTO admins(id, username, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    'admin-1',
    'alice',
    'test-password-hash',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );

  let randomCall = 0;
  const sessionService = await createSessionService({
    db,
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    verifyPassword: async (hash, password) =>
      hash === 'test-password-hash' && password === 'correct-password',
    dummyHashFactory: async () => 'dummy-password-hash',
    randomBytes: (size) => Buffer.alloc(size, ++randomCall),
  });
  const login = await sessionService.login({
    username: 'alice',
    password: 'correct-password',
    ip: '127.0.0.1',
  });
  const photoService = createPhotoService({
    db,
    now: () => new Date('2026-09-01T12:00:00.000Z'),
  });
  let photoIdCounter = 0;
  const uploadPhotoService = createUploadPhotoService({
    db,
    diskPath: stagingRoot,
    storage: new MediaStorage({
      mediaRoot,
      stagingRoot,
      resolveMediaGroupId: async () => currentGroupId,
      getProcessGroupId: () => currentGroupId,
    }),
    processingQueue: options.processingQueue ?? new ProcessingQueue(),
    statfs: options.statfs ?? (async () => ({ bavail: MIN_FREE_BYTES, bsize: 1n })),
    inspectInput: async () => ({
      width: 800,
      height: 600,
      kind: 'jpeg',
      mime: 'image/jpeg',
      takenDate: '2026-09-01',
    }),
    processPhoto: fakeProcessPhoto,
    heifInfoPath: '/configured/heif-info',
    heifConvertPath: '/configured/heif-convert',
    now: () => new Date('2026-09-01T12:00:00.000Z'),
    createPhotoId: () => `0195c681-9c63-7db0-8000-${String(++photoIdCounter).padStart(12, '0')}`,
  });
  const app = buildApp({
    publicOrigin,
    sessionService,
    photoService,
    uploadPhotoService,
    logger: false,
  });
  applications.push(app);

  return {
    app,
    db,
    photoService,
    sessionService,
    cookie: `${cookieName}=${login.rawToken}`,
    csrf: login.csrfToken,
    mediaRoot,
    stagingRoot,
  };
}

interface MultipartPart {
  readonly fieldname: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly value: Buffer | string;
}

function multipart(parts: readonly MultipartPart[], close = true) {
  const boundary = 'sweet-memories-test-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const disposition = part.filename === undefined
      ? `Content-Disposition: form-data; name="${part.fieldname}"\r\n\r\n`
      : `Content-Disposition: form-data; name="${part.fieldname}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`;
    chunks.push(Buffer.from(disposition), Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value), Buffer.from('\r\n'));
  }
  if (close) {
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
  }
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function seedCompletePhoto(
  db: Database.Database,
  input: Parameters<typeof seedPhoto>[1],
): void {
  seedPhoto(db, input);
  for (const width of [640, 320]) {
    seedAsset(db, { photoId: input.id, format: 'avif', width });
  }
  for (const width of [960, 320]) {
    seedAsset(db, { photoId: input.id, format: 'webp', width });
  }
  for (const width of [640, 320]) {
    seedAsset(db, {
      photoId: input.id,
      format: 'jpeg',
      width,
      height: width === 640 ? 480 : 240,
    });
  }
  seedAsset(db, {
    photoId: input.id,
    kind: 'master',
    format: 'jpeg',
    width: 1600,
    height: 1200,
    relativePath: `${input.id}/master.jpg`,
  });
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (app) => app.close()));
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('GET /api/photos', () => {
  it('is reachable through buildApp and exposes only ordered published DTO fields', async () => {
    const { app, db } = await createContext();
    seedCompletePhoto(db, {
      id: 'published-photo',
      title: 'Public title',
      description: 'Public description',
      capturedDate: '2026-01-02',
    });
    seedCompletePhoto(db, {
      id: 'migration-photo',
      title: 'Migration title',
      description: 'Migration description',
      capturedDate: null,
      status: 'migration_pending',
    });

    const response = await app.inject({ method: 'GET', url: '/api/photos' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: 'published-photo',
        title: 'Public title',
        alt: 'Public description',
        capturedDate: '2026-01-02',
        transform: { rotation: -2, x: 3, y: 4 },
        sources: {
          avif: [
            { url: '/media/published-photo/320.avif', width: 320 },
            { url: '/media/published-photo/640.avif', width: 640 },
          ],
          webp: [
            { url: '/media/published-photo/320.webp', width: 320 },
            { url: '/media/published-photo/960.webp', width: 960 },
          ],
          jpeg: [
            { url: '/media/published-photo/320.jpg', width: 320 },
            { url: '/media/published-photo/640.jpg', width: 640 },
          ],
          fallback: {
            url: '/media/published-photo/640.jpg',
            width: 640,
            height: 480,
          },
        },
      },
    ]);
    expect(response.body).not.toMatch(
      /migration|private-request|master\.jpg|request_id|relative_path|original|exif|gps|admin|\/var\//i,
    );
  });

  it('uses the title as alt text for null, empty, or whitespace-only descriptions', async () => {
    const { app, db } = await createContext();
    for (const [id, description] of [
      ['null-description', null],
      ['empty-description', ''],
      ['blank-description', '  '],
    ] as const) {
      seedCompletePhoto(db, { id, title: `Fallback ${id}`, description });
    }

    const response = await app.inject({ method: 'GET', url: '/api/photos' });

    expect(response.statusCode).toBe(200);
    expect(response.json().map((photo: { title: string; alt: string }) => [
      photo.title,
      photo.alt,
    ])).toEqual([
      ['Fallback blank-description', 'Fallback blank-description'],
      ['Fallback empty-description', 'Fallback empty-description'],
      ['Fallback null-description', 'Fallback null-description'],
    ]);
  });

  it.each([
    ['/absolute.jpg', 'absolute path'],
    ['../escape.jpg', 'parent path'],
    ['safe-photo\\escape.jpg', 'backslash'],
    ['other-photo/320.jpg', 'wrong photo id'],
    ['safe-photo//320.jpg', 'noncanonical path'],
  ])('fails closed without exposing an unsafe %s (%s)', async (relativePath) => {
    const { app, db } = await createContext();
    seedPhoto(db, { id: 'safe-photo' });
    seedAsset(db, {
      photoId: 'safe-photo',
      format: 'jpeg',
      width: 320,
      relativePath,
    });

    const response = await app.inject({ method: 'GET', url: '/api/photos' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: '服务器暂时无法处理请求' },
    });
    expect(response.body).not.toContain(relativePath);
  });
});

describe('GET /api/admin/photos', () => {
  it('requires a valid cookie and returns migration records with no-store', async () => {
    const { app, db, cookie } = await createContext();
    seedCompletePhoto(db, {
      id: 'migration-photo',
      title: 'Migration title',
      description: null,
      capturedDate: null,
      status: 'migration_pending',
      version: 2,
    });

    const anonymous = await app.inject({ method: 'GET', url: '/api/admin/photos' });
    const authenticated = await app.inject({
      method: 'GET',
      url: '/api/admin/photos',
      headers: { cookie },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.headers['cache-control']).toBe('no-store');
    expect(authenticated.json()).toEqual([
      expect.objectContaining({
        id: 'migration-photo',
        title: 'Migration title',
        description: null,
        capturedDate: null,
        status: 'migration_pending',
        version: 2,
      }),
    ]);
    expect(authenticated.body).not.toMatch(
      /private-request|master\.jpg|request_id|relative_path|token|csrf|password|\/var\//i,
    );
  });
});

describe('POST /api/admin/photos', () => {
  const requestId = '0195c681-9c63-7db0-8000-000000000101';
  const validFile = multipart([
    {
      fieldname: 'photo',
      filename: 'private-original-name.jpg',
      contentType: 'image/jpeg',
      value: Buffer.from('route image bytes'),
    },
  ]);

  async function enableUploads(db: Database.Database): Promise<void> {
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'uploads_enabled'").run();
  }

  it('requires exact Origin, authentication, one current CSRF value, and a canonical request id', async () => {
    const { app, db, cookie, csrf } = await createContext();
    await enableUploads(db);
    const request = (headers: Record<string, string | string[]>) => app.inject({
      method: 'POST',
      url: '/api/admin/photos',
      headers: { 'content-type': validFile.contentType, ...headers },
      payload: validFile.body,
    });

    const missingOrigin = await request({ cookie, 'x-csrf-token': csrf, 'idempotency-key': requestId });
    const missingCookie = await request({ origin: publicOrigin, 'x-csrf-token': csrf, 'idempotency-key': requestId });
    const invalidCsrf = await request({ origin: publicOrigin, cookie, 'x-csrf-token': 'wrong', 'idempotency-key': requestId });
    const multipleCsrf = await request({ origin: publicOrigin, cookie, 'x-csrf-token': [csrf, csrf], 'idempotency-key': requestId });
    const missingRequestId = await request({ origin: publicOrigin, cookie, 'x-csrf-token': csrf });
    const noncanonicalRequestId = await request({ origin: publicOrigin, cookie, 'x-csrf-token': csrf, 'idempotency-key': requestId.toUpperCase() });

    expect(missingOrigin.statusCode).toBe(403);
    expect(missingCookie.statusCode).toBe(401);
    expect(invalidCsrf.statusCode).toBe(403);
    expect(multipleCsrf.statusCode).toBe(403);
    expect(missingRequestId.statusCode).toBe(400);
    expect(noncanonicalRequestId.statusCode).toBe(400);
    expect(photoCountFor(db)).toBe(0);
  });

  it('is registered through buildApp, creates once with 201, and replays with 200', async () => {
    const { app, db, cookie, csrf } = await createContext();
    await enableUploads(db);
    const headers = {
      origin: publicOrigin,
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': requestId,
      'content-type': validFile.contentType,
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/admin/photos',
      headers,
      payload: validFile.body,
    });
    const replayFile = multipart([
      {
        fieldname: 'photo',
        filename: 'different-secret-name.jpg',
        contentType: 'image/jpeg',
        value: Buffer.from('must not be consumed'),
      },
    ]);
    const second = await app.inject({
      method: 'POST',
      url: '/api/admin/photos',
      headers: { ...headers, 'content-type': replayFile.contentType },
      payload: replayFile.body,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(second.json().photo.id).toBe(first.json().photo.id);
    expect(photoCountFor(db)).toBe(1);
    const visible = `${first.body}\n${second.body}`;
    expect(visible).not.toMatch(/private-original|different-secret|filename|requestId|staging|\/var\//i);
  });

  it('returns 423 before consuming multipart while uploads are disabled', async () => {
    const { app, db, cookie, csrf } = await createContext();
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/photos',
      headers: {
        origin: publicOrigin,
        cookie,
        'x-csrf-token': csrf,
        'idempotency-key': requestId,
        'content-type': validFile.contentType,
      },
      payload: validFile.body,
    });

    expect(response.statusCode).toBe(423);
    expect(response.json()).toEqual({
      error: { code: 'UPLOADS_DISABLED', message: '图片上传暂未开放' },
    });
    expect(photoCountFor(db)).toBe(0);
  });

  it('returns stable 507 and 429 envelopes for disk and queue admission failures', async () => {
    const lowDisk = await createContext({
      statfs: async () => ({ bavail: MIN_FREE_BYTES - 1n, bsize: 1n }),
    });
    await enableUploads(lowDisk.db);
    const headers = (context: TestContext) => ({
      origin: publicOrigin,
      cookie: context.cookie,
      'x-csrf-token': context.csrf,
      'idempotency-key': requestId,
      'content-type': validFile.contentType,
    });

    const insufficient = await lowDisk.app.inject({
      method: 'POST',
      url: '/api/admin/photos',
      headers: headers(lowDisk),
      payload: validFile.body,
    });
    expect(insufficient.statusCode).toBe(507);
    expect(insufficient.json()).toEqual({
      error: { code: 'INSUFFICIENT_STORAGE', message: '服务器存储空间不足' },
    });

    const queue = new ProcessingQueue();
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const occupied = Array.from({ length: 10 }, () => queue.run(async () => blocker));
    const fullQueue = await createContext({ processingQueue: queue });
    await enableUploads(fullQueue.db);
    const busy = await fullQueue.app.inject({
      method: 'POST',
      url: '/api/admin/photos',
      headers: headers(fullQueue),
      payload: validFile.body,
    });
    expect(busy.statusCode).toBe(429);
    expect(busy.json()).toEqual({
      error: { code: 'UPLOAD_QUEUE_FULL', message: '图片处理队列繁忙，请稍后重试' },
    });
    expect(photoCountFor(fullQueue.db)).toBe(0);
    expect(await readdir(fullQueue.stagingRoot)).toEqual([]);

    release();
    await Promise.all(occupied);
  });

  it('rejects non-multipart content while uploads are enabled', async () => {
    const { app, db, cookie, csrf } = await createContext();
    await enableUploads(db);

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/photos',
      headers: {
        origin: publicOrigin,
        cookie,
        'x-csrf-token': csrf,
        'idempotency-key': requestId,
        'content-type': 'application/json',
      },
      payload: { private: 'not a photo' },
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '请使用 multipart/form-data 上传' },
    });
    expect(photoCountFor(db)).toBe(0);
  });

  it.each([
    ['no file', multipart([])],
    ['a form field', multipart([{ fieldname: 'caption', value: 'private caption' }])],
    ['wrong file part name', multipart([{ fieldname: 'avatar', filename: 'wrong.jpg', value: 'wrong' }])],
    ['two files', multipart([
      { fieldname: 'photo', filename: 'first.jpg', value: 'first' },
      { fieldname: 'photo', filename: 'second.jpg', value: 'second' },
    ])],
    ['a truncated body', multipart([
      { fieldname: 'photo', filename: 'truncated.jpg', value: 'truncated' },
    ], false)],
  ] as const)('rejects %s and cleans all upload state', async (_label, body) => {
    const { app, db, cookie, csrf, mediaRoot, stagingRoot } = await createContext();
    await enableUploads(db);

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/photos',
      headers: {
        origin: publicOrigin,
        cookie,
        'x-csrf-token': csrf,
        'idempotency-key': requestId,
        'content-type': body.contentType,
      },
      payload: body.body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'INVALID_MULTIPART_UPLOAD', message: '请只上传一个 photo 文件' },
    });
    expect(photoCountFor(db)).toBe(0);
    expect(await readdir(mediaRoot)).toEqual([]);
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  it('rejects a file over 10 MiB with 413 and removes the partial staging file', async () => {
    const { app, db, cookie, csrf, mediaRoot, stagingRoot } = await createContext();
    await enableUploads(db);
    const oversized = multipart([
      {
        fieldname: 'photo',
        filename: 'oversized-private.jpg',
        contentType: 'image/jpeg',
        value: Buffer.alloc(10 * 1024 * 1024 + 1, 1),
      },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/photos',
      headers: {
        origin: publicOrigin,
        cookie,
        'x-csrf-token': csrf,
        'idempotency-key': requestId,
        'content-type': oversized.contentType,
      },
      payload: oversized.body,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: { code: 'UPLOAD_TOO_LARGE', message: '单张图片不能超过 10MB' },
    });
    expect(response.body).not.toContain('oversized-private.jpg');
    expect(photoCountFor(db)).toBe(0);
    expect(await readdir(mediaRoot)).toEqual([]);
    expect(await readdir(stagingRoot)).toEqual([]);
  });
});

describe('PATCH /api/admin/photos/:id', () => {
  const validPayload = {
    title: 'Updated title',
    description: 'Updated description',
    capturedDate: '2026-02-28',
    version: 1,
  };
  const invalidPayloads: Array<[Record<string, unknown>, string]> = [
    [{ ...validPayload, extra: true }, 'extra key'],
    [{ title: 'title', description: null, capturedDate: '2026-02-28' }, 'missing key'],
    [{ ...validPayload, title: '' }, 'empty title'],
    [{ ...validPayload, title: 'x'.repeat(121) }, 'long title'],
    [{ ...validPayload, description: 'x'.repeat(501) }, 'long description'],
    [{ ...validPayload, capturedDate: '2026-02-29' }, 'rolled date'],
    [{ ...validPayload, capturedDate: '2026-2-09' }, 'noncanonical date'],
    [{ ...validPayload, capturedDate: '0000-01-01' }, 'zero year'],
    [{ ...validPayload, version: 0 }, 'zero version'],
    [{ ...validPayload, version: 1.5 }, 'fractional version'],
    [{ ...validPayload, version: Number.MAX_SAFE_INTEGER + 1 }, 'unsafe version'],
  ];

  it('requires exact Origin, authentication, and the current single CSRF value', async () => {
    const { app, db, cookie, csrf } = await createContext();
    seedCompletePhoto(db, { id: 'editable' });

    const missingOrigin = await app.inject({
      method: 'PATCH',
      url: '/api/admin/photos/editable',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: validPayload,
    });
    const missingCookie = await app.inject({
      method: 'PATCH',
      url: '/api/admin/photos/editable',
      headers: { origin: publicOrigin, 'x-csrf-token': csrf },
      payload: validPayload,
    });
    const invalidCsrf = await app.inject({
      method: 'PATCH',
      url: '/api/admin/photos/editable',
      headers: { origin: publicOrigin, cookie, 'x-csrf-token': 'wrong' },
      payload: validPayload,
    });
    const multipleCsrf = await app.inject({
      method: 'PATCH',
      url: '/api/admin/photos/editable',
      headers: {
        origin: publicOrigin,
        cookie,
        'x-csrf-token': [csrf, csrf],
      },
      payload: validPayload,
    });

    expect(missingOrigin.statusCode).toBe(403);
    expect(missingCookie.statusCode).toBe(401);
    expect(invalidCsrf.statusCode).toBe(403);
    expect(multipleCsrf.statusCode).toBe(403);
    expect(db.prepare('SELECT version FROM photos WHERE id = ?').get('editable')).toEqual({
      version: 1,
    });
  });

  it('normalizes accepted text, updates the row, and returns no-store', async () => {
    const { app, db, cookie, csrf } = await createContext();
    seedCompletePhoto(db, { id: 'editable' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/photos/editable',
      headers: { origin: publicOrigin, cookie, 'x-csrf-token': csrf },
      payload: {
        title: '  Cafe\u0301 photo  ',
        description: '   ',
        capturedDate: '2024-02-29',
        version: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      id: 'editable',
      title: 'Caf\u00e9 photo',
      description: null,
      capturedDate: '2024-02-29',
      version: 2,
    });
    expect(db.prepare(
      'SELECT title, description, captured_date, version FROM photos WHERE id = ?',
    ).get('editable')).toEqual({
      title: 'Caf\u00e9 photo',
      description: null,
      captured_date: '2024-02-29',
      version: 2,
    });
  });

  it.each([
    'missing assets',
    'no responsive JPEG',
    'unsafe relative path',
  ] as const)(
    'rolls back every edited column when the migration record has %s',
    async (invalidMedia) => {
      const { app, db, cookie, csrf } = await createContext();
      seedPhoto(db, {
        id: 'migration-edit',
        title: 'Original title',
        description: 'Original description',
        capturedDate: null,
        status: 'migration_pending',
      });
      if (invalidMedia === 'no responsive JPEG') {
        seedAsset(db, { photoId: 'migration-edit', format: 'avif', width: 320 });
        seedAsset(db, { photoId: 'migration-edit', format: 'webp', width: 320 });
      } else if (invalidMedia === 'unsafe relative path') {
        seedAsset(db, {
          photoId: 'migration-edit',
          format: 'jpeg',
          width: 320,
          relativePath: '../private-file.jpg',
        });
      }
      const readStoredEdit = () => db.prepare(
        `SELECT title, description, captured_date, version, updated_at
         FROM photos WHERE id = ?`,
      ).get('migration-edit');
      const before = readStoredEdit();

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/admin/photos/migration-edit',
        headers: { origin: publicOrigin, cookie, 'x-csrf-token': csrf },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: { code: 'INTERNAL_ERROR', message: '服务器暂时无法处理请求' },
      });
      expect(readStoredEdit()).toEqual(before);
    },
  );

  it.each([
    [{ ...validPayload, title: '\u0000' }, 'title-only NUL'],
    [{ ...validPayload, title: 'a\u0000' }, 'title trailing NUL'],
    [{ ...validPayload, description: '\u0000details' }, 'description leading NUL'],
    [{ ...validPayload, description: 'details\u0000more' }, 'description middle NUL'],
  ])('rejects %s (%s) before changing the database', async (payload) => {
    const { app, db, cookie, csrf } = await createContext();
    seedCompletePhoto(db, {
      id: 'editable',
      title: 'Original title',
      description: 'Original description',
    });
    const readStoredEdit = () => db.prepare(
      `SELECT title, description, captured_date, version, updated_at
       FROM photos WHERE id = ?`,
    ).get('editable');
    const before = readStoredEdit();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/photos/editable',
      headers: { origin: publicOrigin, cookie, 'x-csrf-token': csrf },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'INVALID_PHOTO_EDIT', message: '照片编辑内容无效' },
    });
    expect(readStoredEdit()).toEqual(before);
  });

  it.each(invalidPayloads)('rejects an invalid exact edit payload: %s (%s)', async (payload) => {
    const { app, db, cookie, csrf } = await createContext();
    seedCompletePhoto(db, { id: 'editable' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/photos/editable',
      headers: { origin: publicOrigin, cookie, 'x-csrf-token': csrf },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'INVALID_PHOTO_EDIT', message: '照片编辑内容无效' },
    });
    expect(db.prepare('SELECT version FROM photos WHERE id = ?').get('editable')).toEqual({
      version: 1,
    });
  });

  it('counts Unicode code points after normalization for title and description limits', async () => {
    const { app, db, cookie, csrf } = await createContext();
    seedCompletePhoto(db, { id: 'editable' });
    const accepted = await app.inject({
      method: 'PATCH',
      url: '/api/admin/photos/editable',
      headers: { origin: publicOrigin, cookie, 'x-csrf-token': csrf },
      payload: {
        title: '\ud83d\udcf7'.repeat(120),
        description: '\ud83d\udcf7'.repeat(500),
        capturedDate: '2026-01-01',
        version: 1,
      },
    });

    expect(accepted.statusCode).toBe(200);
    expect(Array.from(accepted.json().title)).toHaveLength(120);
    expect(Array.from(accepted.json().description)).toHaveLength(500);
  });

  it('returns stable 409 and 404 errors for stale and missing records', async () => {
    const { app, db, cookie, csrf } = await createContext();
    seedCompletePhoto(db, { id: 'editable', version: 2 });

    const stale = await app.inject({
      method: 'PATCH',
      url: '/api/admin/photos/editable',
      headers: { origin: publicOrigin, cookie, 'x-csrf-token': csrf },
      payload: validPayload,
    });
    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/admin/photos/missing',
      headers: { origin: publicOrigin, cookie, 'x-csrf-token': csrf },
      payload: validPayload,
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: { code: 'PHOTO_VERSION_CONFLICT', message: '照片已被更新，请刷新后重试' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: 'PHOTO_NOT_FOUND', message: '照片不存在' },
    });
  });
});
