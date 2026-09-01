import { randomUUID } from 'node:crypto';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const MEDIA_GROUP_NAME = 'sweet-memories-media';

export type MediaStorageErrorCode =
  | 'INVALID_MEDIA_ENTRY'
  | 'INVALID_PHOTO_ID'
  | 'INVALID_STORAGE_ROOT'
  | 'MEDIA_GROUP_MISMATCH'
  | 'MEDIA_GROUP_UNAVAILABLE'
  | 'MEDIA_TARGET_EXISTS'
  | 'TRANSACTION_CLOSED';

export class MediaStorageError extends Error {
  readonly code: MediaStorageErrorCode;

  constructor(code: MediaStorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MediaStorageError';
    this.code = code;
  }
}

export interface MediaTransaction {
  readonly photoId: string;
  readonly stagingDir: string;
  readonly finalDir: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

type ResolveMediaGroupId = (groupName: string) => Promise<number>;

export interface MediaStorageOptions {
  readonly mediaRoot: string;
  readonly stagingRoot: string;
  readonly resolveMediaGroupId?: ResolveMediaGroupId;
  readonly getProcessGroupId?: () => number | undefined;
  readonly createUuid?: () => string;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function storageRoot(name: string, value: string): string {
  if (!isAbsolute(value)) {
    throw new MediaStorageError('INVALID_STORAGE_ROOT', `${name} 必须是绝对路径`);
  }
  return resolve(value);
}

function isSameOrDescendant(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot.length === 0
    || (
      fromRoot !== '..'
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    );
}

function rootsOverlap(left: string, right: string): boolean {
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
}

function resolveInside(root: string, segment: string): string {
  const path = resolve(root, segment);
  const fromRoot = relative(root, path);
  if (
    fromRoot.length === 0
    || fromRoot === '..'
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) {
    throw new MediaStorageError('INVALID_STORAGE_ROOT', '媒体路径超出配置根目录');
  }
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

async function resolveSystemGroupId(groupName: string): Promise<number> {
  let groupFile: string;
  try {
    groupFile = await readFile('/etc/group', 'utf8');
  } catch (cause) {
    throw new MediaStorageError(
      'MEDIA_GROUP_UNAVAILABLE',
      '无法读取媒体组配置',
      { cause },
    );
  }

  for (const line of groupFile.split('\n')) {
    const fields = line.split(':');
    if (fields[0] !== groupName) {
      continue;
    }
    const groupId = Number(fields[2]);
    if (Number.isSafeInteger(groupId) && groupId >= 0) {
      return groupId;
    }
    break;
  }

  throw new MediaStorageError('MEDIA_GROUP_UNAVAILABLE', '媒体组配置不存在或无效');
}

async function enforceGroup(path: string, groupId: number): Promise<void> {
  let information = await lstat(path);
  if (information.gid !== groupId) {
    await chown(path, -1, groupId);
    information = await lstat(path);
  }
  if (information.gid !== groupId) {
    throw new MediaStorageError('MEDIA_GROUP_MISMATCH', '媒体资源组归属设置失败');
  }
}

async function preparePublishedTree(path: string, groupId: number): Promise<void> {
  const information = await lstat(path);
  if (!information.isDirectory()) {
    throw new MediaStorageError('INVALID_MEDIA_ENTRY', '媒体事务目录无效');
  }
  await enforceGroup(path, groupId);

  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = resolveInside(path, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new MediaStorageError('INVALID_MEDIA_ENTRY', '媒体事务包含不允许的文件类型');
    }
    if (entry.isDirectory()) {
      await preparePublishedTree(entryPath, groupId);
      await chmod(entryPath, 0o750);
      continue;
    }
    await enforceGroup(entryPath, groupId);
    await chmod(entryPath, 0o640);
  }
  await chmod(path, 0o750);
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

async function reserveEmptyDirectory(path: string): Promise<FileIdentity> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (cause) {
    if (isNodeError(cause) && cause.code === 'EEXIST') {
      throw new MediaStorageError(
        'MEDIA_TARGET_EXISTS',
        '照片媒体目录已经存在',
        { cause },
      );
    }
    throw cause;
  }

  const information = await lstat(path);
  if (!information.isDirectory()) {
    throw new MediaStorageError('MEDIA_TARGET_EXISTS', '照片媒体目录已经存在');
  }
  return { device: information.dev, inode: information.ino };
}

type IdentityStatus = 'match' | 'missing' | 'replaced';

async function identityStatus(path: string, identity: FileIdentity): Promise<IdentityStatus> {
  try {
    const information = await lstat(path);
    return information.isDirectory()
      && information.dev === identity.device
      && information.ino === identity.inode
      ? 'match'
      : 'replaced';
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

async function assertEmptyReservation(path: string, identity: FileIdentity): Promise<void> {
  if (await identityStatus(path, identity) !== 'match' || (await readdir(path)).length !== 0) {
    throw new MediaStorageError('MEDIA_TARGET_EXISTS', '照片媒体目录已经存在');
  }
}

type ReservationRemoval = 'missing' | 'removed' | 'replaced' | 'retained';

async function removeOwnedReservation(
  path: string,
  identity: FileIdentity,
): Promise<ReservationRemoval> {
  const status = await identityStatus(path, identity);
  if (status !== 'match') {
    return status;
  }
  try {
    await rmdir(path);
    return 'removed';
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return 'missing';
    }
    if (isNodeError(error) && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST')) {
      return 'retained';
    }
    throw error;
  }
}

class FileMediaTransaction implements MediaTransaction {
  private state: 'active' | 'published' | 'rolled_back' = 'active';
  private ownedFinalIdentity: FileIdentity | undefined;
  private reservationIdentity: FileIdentity | undefined;

  constructor(
    readonly photoId: string,
    readonly stagingDir: string,
    readonly finalDir: string,
    private readonly groupId: number,
  ) {}

  async commit(): Promise<void> {
    if (this.state === 'published') {
      return;
    }
    if (this.state !== 'active') {
      throw new MediaStorageError('TRANSACTION_CLOSED', '媒体事务已经关闭');
    }

    try {
      if (await exists(this.finalDir)) {
        throw new MediaStorageError('MEDIA_TARGET_EXISTS', '照片媒体目录已经存在');
      }
      await preparePublishedTree(this.stagingDir, this.groupId);
      this.reservationIdentity = await reserveEmptyDirectory(this.finalDir);
      await assertEmptyReservation(this.finalDir, this.reservationIdentity);
      const preparedDirectory = await lstat(this.stagingDir);
      const preparedIdentity = {
        device: preparedDirectory.dev,
        inode: preparedDirectory.ino,
      };
      await rename(this.stagingDir, this.finalDir);
      this.reservationIdentity = undefined;
      this.ownedFinalIdentity = preparedIdentity;
      this.state = 'published';
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (this.reservationIdentity !== undefined) {
        try {
          const removal = await removeOwnedReservation(this.finalDir, this.reservationIdentity);
          if (removal === 'retained') {
            cleanupErrors.push(new MediaStorageError(
              'MEDIA_TARGET_EXISTS',
              '媒体占位目录无法安全清理',
            ));
          } else {
            this.reservationIdentity = undefined;
          }
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        await rm(this.stagingDir, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          '媒体发布与补偿清理均失败',
          { cause: error },
        );
      }
      throw error;
    }
  }

  async rollback(): Promise<void> {
    if (this.state === 'rolled_back') {
      return;
    }

    if (this.reservationIdentity !== undefined) {
      const removal = await removeOwnedReservation(this.finalDir, this.reservationIdentity);
      if (removal === 'retained') {
        throw new MediaStorageError('MEDIA_TARGET_EXISTS', '媒体占位目录无法安全清理');
      }
      this.reservationIdentity = undefined;
    }
    await rm(this.stagingDir, { recursive: true, force: true });
    if (this.ownedFinalIdentity !== undefined) {
      if (await identityStatus(this.finalDir, this.ownedFinalIdentity) === 'match') {
        await rm(this.finalDir, { recursive: true, force: true });
      }
      this.ownedFinalIdentity = undefined;
    }
    this.state = 'rolled_back';
  }
}

export class MediaStorage {
  private readonly mediaRoot: string;
  private readonly stagingRoot: string;
  private readonly resolveMediaGroupId: ResolveMediaGroupId;
  private readonly getProcessGroupId: () => number | undefined;
  private readonly createUuid: () => string;

  constructor(options: MediaStorageOptions) {
    this.mediaRoot = storageRoot('mediaRoot', options.mediaRoot);
    this.stagingRoot = storageRoot('stagingRoot', options.stagingRoot);
    if (rootsOverlap(this.mediaRoot, this.stagingRoot)) {
      throw new MediaStorageError('INVALID_STORAGE_ROOT', '媒体目录与暂存目录必须分离');
    }
    this.resolveMediaGroupId = options.resolveMediaGroupId ?? resolveSystemGroupId;
    this.getProcessGroupId = options.getProcessGroupId ?? (() => process.getgid?.());
    this.createUuid = options.createUuid ?? randomUUID;
  }

  async createTransaction(photoId: string): Promise<MediaTransaction> {
    if (!CANONICAL_UUID.test(photoId)) {
      throw new MediaStorageError('INVALID_PHOTO_ID', '照片 ID 必须是服务端规范 UUID');
    }

    let realMediaRoot: string;
    let realStagingRoot: string;
    try {
      [realMediaRoot, realStagingRoot] = await Promise.all([
        realpath(this.mediaRoot),
        realpath(this.stagingRoot),
      ]);
    } catch (cause) {
      throw new MediaStorageError(
        'INVALID_STORAGE_ROOT',
        '媒体目录与暂存目录不可用',
        { cause },
      );
    }
    if (rootsOverlap(realMediaRoot, realStagingRoot)) {
      throw new MediaStorageError('INVALID_STORAGE_ROOT', '媒体目录与暂存目录必须分离');
    }

    const finalDir = resolveInside(this.mediaRoot, photoId);
    if (await exists(finalDir)) {
      throw new MediaStorageError('MEDIA_TARGET_EXISTS', '照片媒体目录已经存在');
    }

    const groupId = await this.resolveMediaGroupId(MEDIA_GROUP_NAME);
    if (!Number.isSafeInteger(groupId) || groupId < 0) {
      throw new MediaStorageError('MEDIA_GROUP_UNAVAILABLE', '媒体组配置不存在或无效');
    }
    if (this.getProcessGroupId() !== groupId) {
      throw new MediaStorageError(
        'MEDIA_GROUP_MISMATCH',
        `服务进程主组必须是 ${MEDIA_GROUP_NAME}`,
      );
    }

    const stagingDir = resolveInside(this.stagingRoot, this.createUuid());
    try {
      await mkdir(stagingDir, { mode: 0o700 });
      await chmod(stagingDir, 0o700);
      await enforceGroup(stagingDir, groupId);
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }

    return new FileMediaTransaction(photoId, stagingDir, finalDir, groupId);
  }
}
