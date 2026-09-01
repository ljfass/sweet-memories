import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename as fileSystemRename,
  rm as fileSystemRemove,
} from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type Database from 'better-sqlite3';

import { ApiHttpError } from '../http/security.js';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_TREE_ENTRIES = 10_000;

export type RenameMediaTree = (source: string, target: string) => Promise<void>;
export type RemoveMediaTree = (
  path: string,
  options: { readonly recursive: true; readonly force: false },
) => Promise<void>;

export interface DeletePhotoInput {
  readonly id: string;
  readonly version: number;
}

export interface DeletePhotoResult {
  readonly deleted: boolean;
}

export interface DeletePhotoService {
  delete(input: DeletePhotoInput): Promise<DeletePhotoResult>;
}

export interface CreateDeletePhotoServiceOptions {
  readonly db: Database.Database;
  readonly mediaRoot: string;
  readonly createUuid?: () => string;
  readonly rename?: RenameMediaTree;
  readonly remove?: RemoveMediaTree;
}

type DatabaseDeleteResult = 'deleted' | 'conflict' | 'not_found';

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

function nodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot.length === 0
    || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function child(root: string, segment: string): string {
  const candidate = resolve(root, segment);
  if (candidate === root || !contained(root, candidate)) {
    throw unsafeMediaPath();
  }
  return candidate;
}

function unsafeMediaPath(cause?: unknown): ApiHttpError {
  const error = new ApiHttpError(
    500,
    'UNSAFE_MEDIA_PATH',
    '照片媒体路径状态异常，已拒绝删除',
  );
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (nodeError(error) && error.code === 'ENOENT') {
      return true;
    }
    throw unsafeMediaPath(error);
  }
}

async function directoryIdentity(path: string): Promise<FileIdentity> {
  let information;
  try {
    information = await lstat(path);
  } catch (cause) {
    throw unsafeMediaPath(cause);
  }
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw unsafeMediaPath();
  }
  return { device: information.dev, inode: information.ino };
}

async function sameDirectory(path: string, identity: FileIdentity): Promise<boolean> {
  try {
    const information = await lstat(path);
    return information.isDirectory()
      && !information.isSymbolicLink()
      && information.dev === identity.device
      && information.ino === identity.inode;
  } catch (error) {
    if (nodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw unsafeMediaPath(error);
  }
}

async function safeRealDirectory(path: string, canonicalRoot: string): Promise<void> {
  await directoryIdentity(path);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (cause) {
    throw unsafeMediaPath(cause);
  }
  if (!contained(canonicalRoot, canonicalPath)) {
    throw unsafeMediaPath();
  }
}

async function assertSafeTree(root: string, canonicalRoot: string): Promise<void> {
  let inspected = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    await safeRealDirectory(directory, canonicalRoot);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (cause) {
      throw unsafeMediaPath(cause);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      inspected += 1;
      if (inspected > MAX_TREE_ENTRIES) {
        throw unsafeMediaPath();
      }
      const path = child(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw unsafeMediaPath();
      }
      let canonicalPath: string;
      try {
        canonicalPath = await realpath(path);
      } catch (cause) {
        throw unsafeMediaPath(cause);
      }
      if (!contained(canonicalRoot, canonicalPath)) {
        throw unsafeMediaPath();
      }
      if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }
}

async function prepareMediaRoot(mediaRoot: string): Promise<string> {
  await directoryIdentity(mediaRoot);
  try {
    return await realpath(mediaRoot);
  } catch (cause) {
    throw unsafeMediaPath(cause);
  }
}

async function prepareDeletingRoot(mediaRoot: string, canonicalMediaRoot: string): Promise<string> {
  const deletingRoot = child(mediaRoot, '.deleting');
  try {
    await mkdir(deletingRoot, { mode: 0o700 });
  } catch (error) {
    if (!nodeError(error) || error.code !== 'EEXIST') {
      throw unsafeMediaPath(error);
    }
  }
  await directoryIdentity(deletingRoot);
  try {
    await chmod(deletingRoot, 0o700);
  } catch (cause) {
    throw unsafeMediaPath(cause);
  }
  await safeRealDirectory(deletingRoot, canonicalMediaRoot);
  return deletingRoot;
}

function deleteDatabaseRecord(
  db: Database.Database,
  input: DeletePhotoInput,
): DatabaseDeleteResult {
  return db.transaction(() => {
    const deletion = db.prepare('DELETE FROM photos WHERE id = ? AND version = ?').run(
      input.id,
      input.version,
    );
    if (deletion.changes === 1) {
      return 'deleted' as const;
    }
    return db.prepare('SELECT 1 FROM photos WHERE id = ?').get(input.id) === undefined
      ? 'not_found' as const
      : 'conflict' as const;
  }).immediate();
}

class FileDeletePhotoService implements DeletePhotoService {
  private readonly mediaRoot: string;
  private readonly createUuid: () => string;
  private readonly rename: RenameMediaTree;
  private readonly remove: RemoveMediaTree;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly options: CreateDeletePhotoServiceOptions) {
    if (!isAbsolute(options.mediaRoot)) {
      throw unsafeMediaPath();
    }
    this.mediaRoot = resolve(options.mediaRoot);
    this.createUuid = options.createUuid ?? randomUUID;
    this.rename = options.rename ?? fileSystemRename;
    this.remove = options.remove ?? fileSystemRemove;
  }

  async delete(input: DeletePhotoInput): Promise<DeletePhotoResult> {
    if (
      !CANONICAL_UUID.test(input.id)
      || !Number.isSafeInteger(input.version)
      || input.version < 1
    ) {
      throw new ApiHttpError(400, 'INVALID_PHOTO_DELETE', '照片删除请求无效');
    }
    return this.withPhotoLock(input.id, () => this.deleteLocked(input));
  }

  private async deleteLocked(input: DeletePhotoInput): Promise<DeletePhotoResult> {
    const canonicalMediaRoot = await prepareMediaRoot(this.mediaRoot);
    const existsInDatabase = this.options.db
      .prepare('SELECT 1 FROM photos WHERE id = ?')
      .get(input.id) !== undefined;
    if (!existsInDatabase) {
      return { deleted: false };
    }

    const source = child(this.mediaRoot, input.id);
    if (await missing(source)) {
      throw unsafeMediaPath();
    }
    const identity = await directoryIdentity(source);
    await assertSafeTree(source, canonicalMediaRoot);
    const deletingRoot = await prepareDeletingRoot(this.mediaRoot, canonicalMediaRoot);
    const deletionUuid = this.createUuid();
    if (!CANONICAL_UUID.test(deletionUuid)) {
      throw unsafeMediaPath();
    }
    const target = child(deletingRoot, `${input.id}-${deletionUuid}`);
    if (!(await missing(target))) {
      throw unsafeMediaPath();
    }

    try {
      await this.rename(source, target);
    } catch (cause) {
      throw unsafeMediaPath(cause);
    }
    if (!(await sameDirectory(target, identity)) || !(await missing(source))) {
      throw unsafeMediaPath();
    }

    let result: DatabaseDeleteResult;
    try {
      result = deleteDatabaseRecord(this.options.db, input);
    } catch (databaseError) {
      await this.restoreOrAggregate(source, target, identity, canonicalMediaRoot, databaseError);
      throw databaseError;
    }

    if (result === 'conflict') {
      const conflict = new ApiHttpError(
        409,
        'PHOTO_VERSION_CONFLICT',
        '照片已被更新，请刷新后重试',
      );
      await this.restoreOrAggregate(source, target, identity, canonicalMediaRoot, conflict);
      throw conflict;
    }

    await this.cleanupCommittedTarget(target, identity, canonicalMediaRoot);
    return { deleted: result === 'deleted' };
  }

  private async restoreOrAggregate(
    source: string,
    target: string,
    identity: FileIdentity,
    canonicalMediaRoot: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      if (!(await missing(source))) {
        throw unsafeMediaPath();
      }
      if (!(await sameDirectory(target, identity))) {
        throw unsafeMediaPath();
      }
      await assertSafeTree(target, canonicalMediaRoot);
      await this.rename(target, source);
      if (!(await sameDirectory(source, identity)) || !(await missing(target))) {
        throw unsafeMediaPath();
      }
    } catch (restoreError) {
      throw new AggregateError(
        [originalError, restoreError],
        '照片数据库删除失败且媒体恢复未安全完成',
        { cause: restoreError },
      );
    }
  }

  private async cleanupCommittedTarget(
    target: string,
    identity: FileIdentity,
    canonicalMediaRoot: string,
  ): Promise<void> {
    try {
      if (!(await sameDirectory(target, identity))) {
        return;
      }
      await assertSafeTree(target, canonicalMediaRoot);
      await this.remove(target, { recursive: true, force: false });
    } catch {
      // The database deletion is final; maintenance retries this private tree.
    }
  }

  private async withPhotoLock<T>(photoId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(photoId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = previous.then(() => gate);
    this.tails.set(photoId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(photoId) === tail) {
        this.tails.delete(photoId);
      }
    }
  }
}

export function createDeletePhotoService(
  options: CreateDeletePhotoServiceOptions,
): DeletePhotoService {
  return new FileDeletePhotoService(options);
}
