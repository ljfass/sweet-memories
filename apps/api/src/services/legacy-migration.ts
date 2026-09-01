import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import type Database from 'better-sqlite3';

interface LegacyPhoto {
  readonly legacyId: string;
  readonly photoId: string;
  readonly title: string;
  readonly description: string;
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
}

const LEGACY_PHOTOS: readonly LegacyPhoto[] = Object.freeze([
  Object.freeze({
    legacyId: '1',
    photoId: '9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1',
    title: '刚出生的时候 🍼',
    description: '刚出生的宝宝裹在粉色襁褓中安静熟睡',
    rotation: -5,
    x: 0,
    y: 10,
  }),
  Object.freeze({
    legacyId: '2',
    photoId: '58efb95e-2a98-45be-bbe4-acde6c34f7cd',
    title: '第一次笑得这么开心 😄',
    description: '宝宝睁着眼睛躺在印花被褥中',
    rotation: 3,
    x: 10,
    y: -5,
  }),
  Object.freeze({
    legacyId: '3',
    photoId: 'f83da4e8-d94e-4b8a-a725-36e2d1f931bf',
    title: '满月啦 🎈',
    description: '爸爸妈妈抱着宝宝在蛋糕前庆祝满月',
    rotation: -2,
    x: -10,
    y: 0,
  }),
  Object.freeze({
    legacyId: '4',
    photoId: 'a15b8021-9842-4ed7-bd0f-9f98518a2d72',
    title: '睡觉的样子最乖 💤',
    description: '宝宝躺在圆点枕头上安静熟睡',
    rotation: 4,
    x: 5,
    y: 15,
  }),
  Object.freeze({
    legacyId: '5',
    photoId: 'c9608cd6-3480-43fb-84ab-623899262ff9',
    title: '带去公园玩 🌳',
    description: '宝宝坐在婴儿车里游览开满玫瑰的公园',
    rotation: -4,
    x: 0,
    y: -10,
  }),
]);

interface MediaAssetManifest {
  readonly kind: 'master' | 'responsive';
  readonly format: 'avif' | 'webp' | 'jpeg';
  readonly width: number;
  readonly height: number;
  readonly relativePath: string;
  readonly size: number;
  readonly sha256: string;
}

interface PhotoMediaManifest {
  readonly legacyId: string;
  readonly photoId: string;
  readonly assets: readonly MediaAssetManifest[];
}

interface LegacyMediaManifest {
  readonly version: 1;
  readonly photos: readonly PhotoMediaManifest[];
}

export interface LegacyMigrationOptions {
  readonly db: Database.Database;
  readonly seedRoot: string;
  readonly mediaRoot: string;
}

interface PhotoRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly captured_date: string | null;
  readonly status: 'migration_pending' | 'published';
  readonly rotation: number;
  readonly offset_x: number;
  readonly offset_y: number;
  readonly request_id: string;
  readonly version: number;
  readonly created_at: string;
}

interface AssetRow {
  readonly photo_id: string;
  readonly kind: 'master' | 'responsive';
  readonly format: 'avif' | 'webp' | 'jpeg';
  readonly width: number;
  readonly height: number;
  readonly relative_path: string;
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function isDescendant(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot.length > 0
    && fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot);
}

function ordinaryDirectory(name: string, path: string): string {
  if (!isAbsolute(path)) throw new Error(`${name} 必须是绝对路径`);
  const information = lstatSync(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`${name} 必须是普通目录`);
  }
  return realpathSync.native(path);
}

function ordinaryFileInside(root: string, path: string): Buffer {
  const information = lstatSync(path);
  const actualPath = realpathSync.native(path);
  if (
    !information.isFile()
    || information.isSymbolicLink()
    || !isDescendant(root, actualPath)
  ) {
    throw new Error('媒体资源路径无效');
  }
  return readFileSync(path);
}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function expectedFileNames(): readonly string[] {
  return [
    'master.jpg',
    '320.avif', '320.webp', '320.jpg',
    '640.avif', '640.webp', '640.jpg',
    '960.avif', '960.webp', '960.jpg',
  ];
}

function parseAsset(value: unknown, photoId: string): MediaAssetManifest {
  if (!exactKeys(value, [
    'kind', 'format', 'width', 'height', 'relativePath', 'size', 'sha256',
  ])) {
    throw new Error('媒体清单资源字段无效');
  }
  const { kind, format, width, height, relativePath, size, sha256 } = value;
  if (
    (kind !== 'master' && kind !== 'responsive')
    || (format !== 'avif' && format !== 'webp' && format !== 'jpeg')
    || !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || !Number.isSafeInteger(size)
    || (width as number) <= 0
    || (height as number) <= 0
    || (size as number) <= 0
    || typeof relativePath !== 'string'
    || typeof sha256 !== 'string'
    || !SHA256.test(sha256)
  ) {
    throw new Error('媒体清单资源内容无效');
  }
  const segments = relativePath.split('/');
  if (
    segments.length !== 2
    || segments[0] !== photoId
    || segments[1] === undefined
    || !SAFE_NAME.test(segments[1])
    || segments[1] === '.'
    || segments[1] === '..'
    || relativePath.includes('\\')
  ) {
    throw new Error('媒体清单包含不安全路径');
  }
  return {
    kind,
    format,
    width: width as number,
    height: height as number,
    relativePath,
    size: size as number,
    sha256,
  };
}

function parseMediaManifest(seedRoot: string): LegacyMediaManifest {
  const manifestPath = join(seedRoot, 'media-manifest.json');
  const contents = ordinaryFileInside(seedRoot, manifestPath);
  const parsed: unknown = JSON.parse(contents.toString('utf8'));
  if (!exactKeys(parsed, ['version', 'photos']) || parsed.version !== 1 || !Array.isArray(parsed.photos)) {
    throw new Error('媒体清单格式无效');
  }
  if (parsed.photos.length !== LEGACY_PHOTOS.length) {
    throw new Error('媒体清单必须精确包含五张照片');
  }

  const photos = parsed.photos.map((value, index): PhotoMediaManifest => {
    const expectedPhoto = LEGACY_PHOTOS[index];
    if (
      expectedPhoto === undefined
      || !exactKeys(value, ['legacyId', 'photoId', 'assets'])
      || value.legacyId !== expectedPhoto.legacyId
      || value.photoId !== expectedPhoto.photoId
      || !Array.isArray(value.assets)
      || value.assets.length !== 10
    ) {
      throw new Error('媒体清单照片顺序或身份无效');
    }
    const assets = value.assets.map((asset) => parseAsset(asset, expectedPhoto.photoId));
    const actualNames = assets.map((asset) => asset.relativePath.split('/')[1]).sort();
    if (actualNames.join('\0') !== [...expectedFileNames()].sort().join('\0')) {
      throw new Error('媒体清单资源集合无效');
    }
    for (const asset of assets) {
      const fileName = asset.relativePath.split('/')[1] as string;
      const expectedMaster = fileName === 'master.jpg';
      const extension = fileName.split('.').at(-1);
      const expectedFormat = extension === 'jpg' ? 'jpeg' : extension;
      const expectedWidth = expectedMaster ? 960 : Number(fileName.split('.')[0]);
      if (
        asset.kind !== (expectedMaster ? 'master' : 'responsive')
        || asset.format !== expectedFormat
        || asset.width !== expectedWidth
        || asset.height !== expectedWidth
      ) {
        throw new Error('媒体清单资源元数据无效');
      }
    }
    return { legacyId: expectedPhoto.legacyId, photoId: expectedPhoto.photoId, assets };
  });
  return { version: 1, photos };
}

function fileDigest(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function verifyPhotoMediaFiles(root: string, photo: PhotoMediaManifest): void {
  const photoRoot = join(root, photo.photoId);
    const information = lstatSync(photoRoot);
    const actualPhotoRoot = realpathSync.native(photoRoot);
    if (
      !information.isDirectory()
      || information.isSymbolicLink()
      || !isDescendant(root, actualPhotoRoot)
      || readdirSync(photoRoot).sort().join('\0')
        !== photo.assets.map((asset) => asset.relativePath.split('/')[1] as string).sort().join('\0')
    ) {
      throw new Error('照片媒体目录无效');
    }
    for (const asset of photo.assets) {
      const path = join(root, asset.relativePath);
      const contents = ordinaryFileInside(root, path);
      if (contents.byteLength !== asset.size || fileDigest(contents) !== asset.sha256) {
        throw new Error('照片媒体摘要不一致');
      }
    }
}

function verifyMediaFiles(root: string, manifest: LegacyMediaManifest): void {
  for (const photo of manifest.photos) {
    verifyPhotoMediaFiles(root, photo);
  }
}

function loadBundle(options: LegacyMigrationOptions): {
  readonly seedRoot: string;
  readonly mediaRoot: string;
  readonly manifest: LegacyMediaManifest;
} {
  const seedRoot = ordinaryDirectory('seedRoot', options.seedRoot);
  const mediaRoot = ordinaryDirectory('mediaRoot', options.mediaRoot);
  if (seedRoot === mediaRoot || isDescendant(seedRoot, mediaRoot) || isDescendant(mediaRoot, seedRoot)) {
    throw new Error('seed 与媒体目录不能重叠');
  }
  const manifest = parseMediaManifest(seedRoot);
  verifyMediaFiles(join(seedRoot, 'media'), manifest);
  return { seedRoot, mediaRoot, manifest };
}

function createdAt(photo: LegacyPhoto): string {
  return `2000-01-01T00:00:0${photo.legacyId}.000Z`;
}

function databaseRows(db: Database.Database): readonly PhotoRow[] {
  const ids = LEGACY_PHOTOS.map((photo) => photo.photoId);
  const requests = LEGACY_PHOTOS.map((photo) => `legacy-photo-${photo.legacyId}`);
  const idPlaceholders = ids.map(() => '?').join(', ');
  const requestPlaceholders = requests.map(() => '?').join(', ');
  return db.prepare(
    `SELECT id, title, description, captured_date, status, rotation, offset_x, offset_y,
            request_id, version, created_at
     FROM photos
     WHERE id IN (${idPlaceholders})
        OR request_id IN (${requestPlaceholders})`,
  ).all(...ids, ...requests) as PhotoRow[];
}

function expectedAssets(manifest: LegacyMediaManifest, photoId: string): readonly MediaAssetManifest[] {
  const photo = manifest.photos.find((candidate) => candidate.photoId === photoId);
  if (photo === undefined) throw new Error('媒体清单缺少照片');
  return photo.assets;
}

function assertAssetRows(db: Database.Database, manifest: LegacyMediaManifest): void {
  const ids = LEGACY_PHOTOS.map((photo) => photo.photoId);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT photo_id, kind, format, width, height, relative_path
     FROM photo_assets WHERE photo_id IN (${placeholders})
     ORDER BY photo_id, relative_path`,
  ).all(...ids) as AssetRow[];
  if (rows.length !== 50) throw new Error('迁移媒体数据库记录不完整');
  for (const photo of LEGACY_PHOTOS) {
    const actual = rows.filter((row) => row.photo_id === photo.photoId);
    const expected = expectedAssets(manifest, photo.photoId);
    if (actual.length !== expected.length) throw new Error('迁移媒体数据库记录不完整');
    const actualContract = actual.map((row) => [
      row.kind, row.format, row.width, row.height, row.relative_path,
    ]).sort();
    const expectedContract = expected.map((asset) => [
      asset.kind, asset.format, asset.width, asset.height, asset.relativePath,
    ]).sort();
    if (JSON.stringify(actualContract) !== JSON.stringify(expectedContract)) {
      throw new Error('迁移媒体数据库记录不一致');
    }
  }
}

function canonicalCalendarDate(value: string | null): boolean {
  if (value === null) return false;
  const match = CALENDAR_DATE.exec(value);
  if (match === null || Number(match[1]) === 0) return false;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function nonemptyText(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

function assertImportedDatabase(
  db: Database.Database,
  manifest: LegacyMediaManifest,
  requireReady: boolean,
): void {
  const rows = databaseRows(db);
  if (rows.length !== LEGACY_PHOTOS.length) throw new Error('迁移照片数据库记录不完整或冲突');
  for (const expected of LEGACY_PHOTOS) {
    const row = rows.find((candidate) => candidate.id === expected.photoId);
    if (
      row === undefined
      || row.request_id !== `legacy-photo-${expected.legacyId}`
      || !nonemptyText(row.title)
      || !nonemptyText(row.description)
      || row.rotation !== expected.rotation
      || row.offset_x !== expected.x
      || row.offset_y !== expected.y
      || row.created_at !== createdAt(expected)
      || (row.status !== 'migration_pending' && row.status !== 'published')
      || !Number.isSafeInteger(row.version)
      || row.version < 1
      || (requireReady
        ? !canonicalCalendarDate(row.captured_date)
        : row.captured_date !== null && !canonicalCalendarDate(row.captured_date))
    ) {
      throw new Error('迁移照片数据库记录不一致');
    }
  }
  assertAssetRows(db, manifest);
  if (requireReady) {
    const ids = LEGACY_PHOTOS.map((photo) => photo.photoId);
    const placeholders = ids.map(() => '?').join(', ');
    const ordered = db.prepare(
      `SELECT id FROM photos WHERE id IN (${placeholders})
       ORDER BY captured_date ASC, created_at ASC, id ASC`,
    ).all(...ids) as Array<{ id: string }>;
    if (ordered.map((row) => row.id).join('\0') !== ids.join('\0')) {
      throw new Error('迁移照片公开顺序不一致');
    }
  }
}

interface OwnedDirectory {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

function createMediaDirectories(
  mediaRoot: string,
  seedRoot: string,
  manifest: LegacyMediaManifest,
  preexistingPhotoIds: ReadonlySet<string>,
): readonly OwnedDirectory[] {
  const created: OwnedDirectory[] = [];
  try {
    for (const photo of manifest.photos) {
      if (preexistingPhotoIds.has(photo.photoId)) continue;
      const targetRoot = join(mediaRoot, photo.photoId);
      mkdirSync(targetRoot, { mode: 0o700 });
      const information = lstatSync(targetRoot);
      created.push({ path: targetRoot, device: information.dev, inode: information.ino });
      for (const asset of photo.assets) {
        const fileName = asset.relativePath.split('/')[1] as string;
        const source = join(seedRoot, 'media', asset.relativePath);
        const target = join(targetRoot, fileName);
        copyFileSync(source, target, constants.COPYFILE_EXCL);
        chmodSync(target, 0o640);
      }
      chmodSync(targetRoot, 0o750);
    }
    verifyMediaFiles(mediaRoot, manifest);
    return created;
  } catch (error) {
    cleanupOwnedDirectories(created, error);
  }
}

function cleanupOwnedDirectories(created: readonly OwnedDirectory[], cause: unknown): never {
  const failures: unknown[] = [];
  for (const owned of [...created].reverse()) {
    try {
      const information = lstatSync(owned.path);
      if (
        information.isDirectory()
        && information.dev === owned.device
        && information.ino === owned.inode
      ) {
        rmSync(owned.path, { recursive: true, force: true });
      } else {
        failures.push(new Error('迁移媒体目录已被替换，拒绝清理'));
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError([cause, ...failures], '迁移失败且媒体补偿不完整', { cause });
  }
  throw cause;
}

function insertLegacyDatabase(db: Database.Database, manifest: LegacyMediaManifest): void {
  db.transaction(() => {
    const insertPhoto = db.prepare(
      `INSERT INTO photos(
         id, title, description, captured_date, status, rotation, offset_x, offset_y,
         request_id, version, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, 'migration_pending', ?, ?, ?, ?, 1, ?, ?)`,
    );
    const insertAsset = db.prepare(
      `INSERT INTO photo_assets(photo_id, kind, format, width, height, relative_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const photo of LEGACY_PHOTOS) {
      const timestamp = createdAt(photo);
      insertPhoto.run(
        photo.photoId,
        photo.title,
        photo.description,
        photo.rotation,
        photo.x,
        photo.y,
        `legacy-photo-${photo.legacyId}`,
        timestamp,
        timestamp,
      );
      for (const asset of expectedAssets(manifest, photo.photoId)) {
        insertAsset.run(
          photo.photoId,
          asset.kind,
          asset.format,
          asset.width,
          asset.height,
          asset.relativePath,
        );
      }
    }
  }).immediate();
}

export async function importLegacyPhotos(
  options: LegacyMigrationOptions,
): Promise<{ readonly imported: number; readonly reused: number }> {
  const bundle = loadBundle(options);
  const existing = databaseRows(options.db);
  if (existing.length > 0) {
    assertImportedDatabase(options.db, bundle.manifest, false);
    verifyMediaFiles(bundle.mediaRoot, bundle.manifest);
    return { imported: 0, reused: 5 };
  }
  const preexistingPhotoIds = new Set<string>();
  for (const photo of bundle.manifest.photos) {
    try {
      lstatSync(join(bundle.mediaRoot, photo.photoId));
      verifyPhotoMediaFiles(bundle.mediaRoot, photo);
      preexistingPhotoIds.add(photo.photoId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const created = createMediaDirectories(
    bundle.mediaRoot,
    bundle.seedRoot,
    bundle.manifest,
    preexistingPhotoIds,
  );
  try {
    insertLegacyDatabase(options.db, bundle.manifest);
    return { imported: 5, reused: 0 };
  } catch (error) {
    return cleanupOwnedDirectories(created, error);
  }
}

export async function checkLegacyReadiness(
  options: LegacyMigrationOptions,
): Promise<{ readonly ready: true; readonly photoCount: 5 }> {
  const bundle = loadBundle(options);
  assertImportedDatabase(options.db, bundle.manifest, true);
  verifyMediaFiles(bundle.mediaRoot, bundle.manifest);
  return { ready: true, photoCount: 5 };
}

export async function activateLegacyPhotos(
  options: LegacyMigrationOptions,
): Promise<{ readonly activated: number }> {
  return options.db.transaction(() => {
    const bundle = loadBundle(options);
    assertImportedDatabase(options.db, bundle.manifest, true);
    verifyMediaFiles(bundle.mediaRoot, bundle.manifest);
    const ids = LEGACY_PHOTOS.map((photo) => photo.photoId);
    const placeholders = ids.map(() => '?').join(', ');
    const result = options.db.prepare(
      `UPDATE photos SET status = 'published'
       WHERE id IN (${placeholders}) AND status = 'migration_pending'`,
    ).run(...ids);
    return { activated: result.changes };
  }).immediate();
}

export function getUploadsEnabled(db: Database.Database): boolean {
  const setting = db.prepare(
    "SELECT value FROM settings WHERE key = 'uploads_enabled'",
  ).get() as { value: string } | undefined;
  if (setting?.value !== 'true' && setting?.value !== 'false') {
    throw new Error('上传开关配置无效');
  }
  return setting.value === 'true';
}

export function setUploadsEnabled(
  db: Database.Database,
  enabled: boolean,
  updatedAt: string,
): boolean {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== updatedAt) {
    throw new Error('上传开关更新时间无效');
  }
  const result = db.prepare(
    "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'uploads_enabled'",
  ).run(enabled ? 'true' : 'false', updatedAt);
  if (result.changes !== 1) throw new Error('上传开关配置不存在');
  return getUploadsEnabled(db);
}
