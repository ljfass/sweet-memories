import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import type Database from 'better-sqlite3';

import { normalizePhotoEditBody } from './photo-service.js';

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
  readonly fileOperations?: Partial<LegacyMigrationFileOperations>;
  readonly createImportId?: () => string;
}

export interface LegacyMigrationFileOperations {
  copyFile(source: string, destination: string): void;
  link(source: string, destination: string): void;
  chmod(path: string, mode: number): void;
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TEMPORARY_ROOT_PREFIX = '.legacy-import-';

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

function inspectPhotoMediaSubset(root: string, photo: PhotoMediaManifest): ReadonlySet<string> {
  const photoRoot = join(root, photo.photoId);
  const information = lstatSync(photoRoot);
  const actualPhotoRoot = realpathSync.native(photoRoot);
  if (
    !information.isDirectory()
    || information.isSymbolicLink()
    || !isDescendant(root, actualPhotoRoot)
  ) {
    throw new Error('照片媒体目录无效');
  }
  const expectedByName = new Map(photo.assets.map((asset) => [
    asset.relativePath.split('/')[1] as string,
    asset,
  ]));
  const present = new Set<string>();
  for (const name of readdirSync(photoRoot)) {
    const asset = expectedByName.get(name);
    if (asset === undefined) throw new Error('照片媒体目录包含额外资源');
    const contents = ordinaryFileInside(root, join(photoRoot, name));
    if (contents.byteLength !== asset.size || fileDigest(contents) !== asset.sha256) {
      throw new Error('照片媒体摘要不一致');
    }
    present.add(name);
  }
  return present;
}

function verifyPhotoMediaFiles(root: string, photo: PhotoMediaManifest): void {
  const present = inspectPhotoMediaSubset(root, photo);
  if (present.size !== photo.assets.length) throw new Error('照片媒体目录不完整');
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

function hasCanonicalStoredEdit(row: PhotoRow): boolean {
  try {
    const normalized = normalizePhotoEditBody({
      title: row.title,
      description: row.description,
      capturedDate: row.captured_date,
      version: row.version,
    });
    return normalized.title === row.title
      && normalized.description === row.description
      && normalized.capturedDate === row.captured_date
      && normalized.version === row.version;
  } catch {
    return false;
  }
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
        ? !hasCanonicalStoredEdit(row)
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

interface OwnedFile {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

interface MediaImportOwnership {
  readonly files: readonly OwnedFile[];
  readonly directories: readonly OwnedDirectory[];
}

interface TemporaryRootInspection {
  readonly root: OwnedDirectory;
  readonly files: readonly OwnedFile[];
}

const NODE_FILE_OPERATIONS: LegacyMigrationFileOperations = Object.freeze({
  copyFile: (source: string, destination: string) => {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  },
  link: (source: string, destination: string) => linkSync(source, destination),
  chmod: (path: string, mode: number) => chmodSync(path, mode),
});

function fileOperations(options: LegacyMigrationOptions): LegacyMigrationFileOperations {
  return { ...NODE_FILE_OPERATIONS, ...options.fileOperations };
}

function identity(path: string): { readonly device: number; readonly inode: number } {
  const information = lstatSync(path);
  return { device: information.dev, inode: information.ino };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isAlreadyPresent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function assertMode(path: string, mode: number): void {
  if ((lstatSync(path).mode & 0o777) !== mode) throw new Error('迁移媒体权限归一失败');
}

function ownedByCurrentProcess(path: string): boolean {
  return typeof process.geteuid !== 'function' || lstatSync(path).uid === process.geteuid();
}

function normalizePhotoModes(
  mediaRoot: string,
  photo: PhotoMediaManifest,
  operations: LegacyMigrationFileOperations,
): void {
  for (const asset of photo.assets) {
    const path = join(mediaRoot, asset.relativePath);
    operations.chmod(path, 0o640);
    assertMode(path, 0o640);
  }
  const photoRoot = join(mediaRoot, photo.photoId);
  operations.chmod(photoRoot, 0o750);
  assertMode(photoRoot, 0o750);
}

function removeOwnedFile(owned: OwnedFile, failures: unknown[]): void {
  try {
    const information = lstatSync(owned.path);
    if (
      !information.isFile()
      || information.isSymbolicLink()
      || information.dev !== owned.device
      || information.ino !== owned.inode
    ) {
      failures.push(new Error('迁移媒体文件已被替换，拒绝清理'));
      return;
    }
    unlinkSync(owned.path);
  } catch (error) {
    if (!isMissing(error)) failures.push(error);
  }
}

function removeOwnedDirectory(owned: OwnedDirectory, failures: unknown[]): void {
  try {
    const information = lstatSync(owned.path);
    if (
      !information.isDirectory()
      || information.isSymbolicLink()
      || information.dev !== owned.device
      || information.ino !== owned.inode
      || readdirSync(owned.path).length !== 0
    ) {
      failures.push(new Error('迁移媒体目录不再为空或已被替换，拒绝清理'));
      return;
    }
    rmdirSync(owned.path);
  } catch (error) {
    if (!isMissing(error)) failures.push(error);
  }
}

function expectedTemporaryNames(manifest: LegacyMediaManifest): ReadonlySet<string> {
  return new Set(manifest.photos.flatMap((photo) => photo.assets.map((asset) => {
    const fileName = asset.relativePath.split('/')[1] as string;
    return `${photo.photoId}-${fileName}.tmp`;
  })));
}

function inspectTemporaryRoot(
  path: string,
  manifest: LegacyMediaManifest,
): TemporaryRootInspection {
  const rootInformation = lstatSync(path);
  if (
    !rootInformation.isDirectory()
    || rootInformation.isSymbolicLink()
    || (rootInformation.mode & 0o777) !== 0o700
    || !ownedByCurrentProcess(path)
  ) {
    throw new Error('迁移临时目录无效，拒绝清理');
  }
  const allowedNames = expectedTemporaryNames(manifest);
  const files = readdirSync(path).map((name): OwnedFile => {
    if (!allowedNames.has(name)) throw new Error('迁移临时目录包含未知文件，拒绝清理');
    const filePath = join(path, name);
    const information = lstatSync(filePath);
    if (
      !information.isFile()
      || information.isSymbolicLink()
      || !ownedByCurrentProcess(filePath)
      || (information.mode & 0o133) !== 0
    ) {
      throw new Error('迁移临时目录包含非普通或不安全文件，拒绝清理');
    }
    return { path: filePath, device: information.dev, inode: information.ino };
  });
  return {
    root: { path, device: rootInformation.dev, inode: rootInformation.ino },
    files,
  };
}

function clearInspectedTemporaryRoot(inspection: TemporaryRootInspection): void {
  const failures: unknown[] = [];
  for (const file of inspection.files) removeOwnedFile(file, failures);
  if (failures.length === 0) removeOwnedDirectory(inspection.root, failures);
  if (failures.length > 0) throw new AggregateError(failures, '迁移临时目录清理失败');
}

function clearTemporaryRoot(owned: OwnedDirectory, manifest: LegacyMediaManifest): void {
  let inspection: TemporaryRootInspection;
  try {
    const inspected = inspectTemporaryRoot(owned.path, manifest);
    if (
      inspected.root.device !== owned.device
      || inspected.root.inode !== owned.inode
    ) {
      throw new Error('迁移临时目录已被替换，拒绝清理');
    }
    inspection = inspected;
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  clearInspectedTemporaryRoot(inspection);
}

function clearAbandonedTemporaryRoots(
  mediaRoot: string,
  manifest: LegacyMediaManifest,
): void {
  const inspections = readdirSync(mediaRoot)
    .filter((name) => name.startsWith(TEMPORARY_ROOT_PREFIX))
    .map((name): TemporaryRootInspection => {
      const importId = name.slice(TEMPORARY_ROOT_PREFIX.length);
      if (!UUID.test(importId)) throw new Error('迁移临时目录名称无效');
      return inspectTemporaryRoot(join(mediaRoot, name), manifest);
    });
  for (const inspection of inspections) clearInspectedTemporaryRoot(inspection);
}

function cleanupMediaAttempt(
  ownership: MediaImportOwnership,
  temporaryRoot: OwnedDirectory | undefined,
  manifest: LegacyMediaManifest,
  cause: unknown,
): never {
  const failures: unknown[] = [];
  if (temporaryRoot !== undefined) {
    try {
      clearTemporaryRoot(temporaryRoot, manifest);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const file of [...ownership.files].reverse()) removeOwnedFile(file, failures);
  for (const directory of [...ownership.directories].reverse()) {
    removeOwnedDirectory(directory, failures);
  }
  if (failures.length > 0) {
    throw new AggregateError([cause, ...failures], '迁移失败且媒体补偿不完整', { cause });
  }
  throw cause;
}

function verifyExpectedFile(root: string, asset: MediaAssetManifest, path: string): void {
  const contents = ordinaryFileInside(root, path);
  if (contents.byteLength !== asset.size || fileDigest(contents) !== asset.sha256) {
    throw new Error('照片媒体摘要不一致');
  }
}

function createTemporaryRoot(mediaRoot: string, importId: string): OwnedDirectory {
  if (!UUID.test(importId)) {
    throw new Error('迁移尝试 ID 无效');
  }
  const path = join(mediaRoot, `${TEMPORARY_ROOT_PREFIX}${importId}`);
  mkdirSync(path, { mode: 0o700 });
  assertMode(path, 0o700);
  return { path, ...identity(path) };
}

function installMissingAsset(
  bundle: { readonly seedRoot: string; readonly mediaRoot: string },
  asset: MediaAssetManifest,
  temporaryRoot: OwnedDirectory,
  operations: LegacyMigrationFileOperations,
  installedFiles: OwnedFile[],
): void {
  const fileName = asset.relativePath.split('/')[1] as string;
  const photoId = asset.relativePath.split('/')[0] as string;
  const source = join(bundle.seedRoot, 'media', asset.relativePath);
  const target = join(bundle.mediaRoot, asset.relativePath);
  const temporary = join(temporaryRoot.path, `${photoId}-${fileName}.tmp`);
  operations.copyFile(source, temporary);
  operations.chmod(temporary, 0o600);
  assertMode(temporary, 0o600);
  verifyExpectedFile(temporaryRoot.path, asset, temporary);
  const temporaryIdentity = identity(temporary);
  let installed = false;
  let publishError: unknown;
  try {
    operations.link(temporary, target);
    const targetIdentity = identity(target);
    if (
      targetIdentity.device !== temporaryIdentity.device
      || targetIdentity.inode !== temporaryIdentity.inode
    ) {
      throw new Error('迁移媒体原子发布身份不一致');
    }
    installedFiles.push({ path: target, ...targetIdentity });
    installed = true;
  } catch (error) {
    if (isAlreadyPresent(error)) verifyExpectedFile(bundle.mediaRoot, asset, target);
    else publishError = error;
  }
  let cleanupError: unknown;
  try {
    const current = identity(temporary);
    if (current.device === temporaryIdentity.device && current.inode === temporaryIdentity.inode) {
      unlinkSync(temporary);
    }
  } catch (error) {
    if (!isMissing(error)) cleanupError = error;
  }
  if (publishError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([publishError, cleanupError], '迁移媒体发布与清理均失败');
  }
  if (publishError !== undefined) throw publishError;
  if (cleanupError !== undefined) throw cleanupError;
  if (!installed) verifyExpectedFile(bundle.mediaRoot, asset, target);
}

function prepareMediaDirectories(
  options: LegacyMigrationOptions,
  bundle: {
    readonly seedRoot: string;
    readonly mediaRoot: string;
    readonly manifest: LegacyMediaManifest;
  },
): MediaImportOwnership {
  const operations = fileOperations(options);
  const files: OwnedFile[] = [];
  const directories: OwnedDirectory[] = [];
  let temporaryRoot: OwnedDirectory | undefined;
  try {
    clearAbandonedTemporaryRoots(bundle.mediaRoot, bundle.manifest);
    const presentByPhoto = new Map<string, ReadonlySet<string> | undefined>();
    for (const photo of bundle.manifest.photos) {
      try {
        presentByPhoto.set(photo.photoId, inspectPhotoMediaSubset(bundle.mediaRoot, photo));
      } catch (error) {
        if (isMissing(error)) presentByPhoto.set(photo.photoId, undefined);
        else throw error;
      }
    }

    for (const photo of bundle.manifest.photos) {
      const photoRoot = join(bundle.mediaRoot, photo.photoId);
      let present = presentByPhoto.get(photo.photoId);
      if (present === undefined) {
        try {
          mkdirSync(photoRoot, { mode: 0o700 });
          directories.push({ path: photoRoot, ...identity(photoRoot) });
          present = new Set<string>();
        } catch (error) {
          if (!isAlreadyPresent(error)) throw error;
          present = inspectPhotoMediaSubset(bundle.mediaRoot, photo);
        }
      }
      for (const asset of photo.assets) {
        const fileName = asset.relativePath.split('/')[1] as string;
        if (present.has(fileName)) continue;
        temporaryRoot ??= createTemporaryRoot(
          bundle.mediaRoot,
          (options.createImportId ?? randomUUID)(),
        );
        installMissingAsset(bundle, asset, temporaryRoot, operations, files);
      }
      verifyPhotoMediaFiles(bundle.mediaRoot, photo);
      normalizePhotoModes(bundle.mediaRoot, photo, operations);
    }
    verifyMediaFiles(bundle.mediaRoot, bundle.manifest);
    if (temporaryRoot !== undefined) clearTemporaryRoot(temporaryRoot, bundle.manifest);
    return { files, directories };
  } catch (error) {
    return cleanupMediaAttempt({ files, directories }, temporaryRoot, bundle.manifest, error);
  }
}

function insertLegacyDatabase(
  db: Database.Database,
  manifest: LegacyMediaManifest,
  mediaRoot: string,
): void {
  verifyMediaFiles(mediaRoot, manifest);
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
}

export async function importLegacyPhotos(
  options: LegacyMigrationOptions,
): Promise<{ readonly imported: number; readonly reused: number }> {
  const bundle = loadBundle(options);
  const operations = fileOperations(options);
  return options.db.transaction(() => {
    const existing = databaseRows(options.db);
    if (existing.length > 0) {
      assertImportedDatabase(options.db, bundle.manifest, false);
      verifyMediaFiles(bundle.mediaRoot, bundle.manifest);
      for (const photo of bundle.manifest.photos) {
        normalizePhotoModes(bundle.mediaRoot, photo, operations);
      }
      return { imported: 0, reused: 5 } as const;
    }
    const ownership = prepareMediaDirectories(options, bundle);
    try {
      insertLegacyDatabase(options.db, bundle.manifest, bundle.mediaRoot);
      return { imported: 5, reused: 0 } as const;
    } catch (error) {
      return cleanupMediaAttempt(ownership, undefined, bundle.manifest, error);
    }
  }).immediate();
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
