import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename as fileSystemRename,
  rmdir,
  rm as fileSystemRemove,
} from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type Database from 'better-sqlite3';

export const MAINTENANCE_BUDGET = 100;

const SOURCE_BUDGET = MAINTENANCE_BUDGET / 4;
const STALE_MILLISECONDS = 24 * 60 * 60 * 1_000;
const IDLE_MILLISECONDS = 12 * 60 * 60 * 1_000;
const MAX_TREE_ENTRIES = 10_000;
const UUID_BODY = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const CANONICAL_UUID = new RegExp(`^${UUID_BODY}$`, 'u');
const DELETING_ENTRY = new RegExp(`^(${UUID_BODY})-${UUID_BODY}$`, 'u');

export type RemoveMaintenanceTree = (
  path: string,
  options: { readonly recursive: true; readonly force: false },
) => Promise<void>;
export type RenameMaintenanceTree = (source: string, target: string) => Promise<void>;

export interface MaintenanceSummary {
  readonly inspected: number;
  readonly removedMedia: number;
  readonly removedStaging: number;
  readonly removedDeleting: number;
  readonly expiredSessions: number;
  readonly failures: number;
}

export interface MaintenanceService {
  run(): Promise<MaintenanceSummary>;
}

export interface CreateMaintenanceServiceOptions {
  readonly db: Database.Database;
  readonly mediaRoot: string;
  readonly stagingRoot: string;
  readonly now?: () => Date;
  readonly remove?: RemoveMaintenanceTree;
  readonly rename?: RenameMaintenanceTree;
}

export class MaintenanceSafetyError extends Error {
  readonly code = 'UNSAFE_MAINTENANCE_ROOT';

  constructor() {
    super('维护目录状态不安全');
    this.name = 'MaintenanceSafetyError';
  }
}

interface MutableSummary {
  inspected: number;
  removedMedia: number;
  removedStaging: number;
  removedDeleting: number;
  expiredSessions: number;
  failures: number;
}

interface SafeRoot {
  readonly configured: string;
  readonly canonical: string;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly modificationTimeNanoseconds: bigint;
  readonly birthTimeNanoseconds: bigint;
}

function nodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot.length === 0
    || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function rootsOverlap(left: string, right: string): boolean {
  return contained(left, right) || contained(right, left);
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function child(root: string, segment: string): string {
  const candidate = resolve(root, segment);
  if (candidate === root || !contained(root, candidate)) {
    throw new MaintenanceSafetyError();
  }
  return candidate;
}

async function rootDirectory(path: string): Promise<SafeRoot> {
  let information;
  try {
    information = await lstat(path);
  } catch {
    throw new MaintenanceSafetyError();
  }
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new MaintenanceSafetyError();
  }
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new MaintenanceSafetyError();
  }
  return { configured: path, canonical };
}

async function deletingDirectory(media: SafeRoot): Promise<SafeRoot> {
  const configured = child(media.configured, '.deleting');
  try {
    await mkdir(configured, { mode: 0o700 });
  } catch (error) {
    if (!nodeError(error) || error.code !== 'EEXIST') {
      throw new MaintenanceSafetyError();
    }
  }
  const root = await rootDirectory(configured);
  if (!contained(media.canonical, root.canonical)) {
    throw new MaintenanceSafetyError();
  }
  try {
    await chmod(configured, 0o700);
  } catch {
    throw new MaintenanceSafetyError();
  }
  return root;
}

async function assertSafeTree(
  root: string,
  canonicalRoot: string,
): Promise<FileIdentity> {
  let rootInformation;
  try {
    rootInformation = await lstat(root, { bigint: true });
  } catch {
    throw new MaintenanceSafetyError();
  }
  if (rootInformation.isSymbolicLink() || !rootInformation.isDirectory()) {
    throw new MaintenanceSafetyError();
  }
  const identity = {
    device: rootInformation.dev,
    inode: rootInformation.ino,
    modificationTimeNanoseconds: rootInformation.mtimeNs,
    birthTimeNanoseconds: rootInformation.birthtimeNs,
  };
  const pending = [root];
  let inspected = 0;

  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let canonicalDirectory: string;
    let entries;
    try {
      canonicalDirectory = await realpath(directory);
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new MaintenanceSafetyError();
    }
    if (!contained(canonicalRoot, canonicalDirectory)) {
      throw new MaintenanceSafetyError();
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      inspected += 1;
      if (inspected > MAX_TREE_ENTRIES) {
        throw new MaintenanceSafetyError();
      }
      const path = child(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new MaintenanceSafetyError();
      }
      let canonicalPath: string;
      try {
        canonicalPath = await realpath(path);
      } catch {
        throw new MaintenanceSafetyError();
      }
      if (!contained(canonicalRoot, canonicalPath)) {
        throw new MaintenanceSafetyError();
      }
      if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }
  return identity;
}

async function identityStillMatches(path: string, identity: FileIdentity): Promise<boolean> {
  try {
    const information = await lstat(path, { bigint: true });
    return information.isDirectory()
      && !information.isSymbolicLink()
      && information.dev === identity.device
      && information.ino === identity.inode
      && information.mtimeNs === identity.modificationTimeNanoseconds
      && information.birthtimeNs === identity.birthTimeNanoseconds;
  } catch {
    return false;
  }
}

async function pathMissing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (nodeError(error) && error.code === 'ENOENT') {
      return true;
    }
    throw new MaintenanceSafetyError();
  }
}

class BoundedMaintenanceService implements MaintenanceService {
  private readonly mediaRoot: string;
  private readonly stagingRoot: string;
  private readonly now: () => Date;
  private readonly remove: RemoveMaintenanceTree;
  private readonly rename: RenameMaintenanceTree;
  private readonly scanCursors = new Map<
    'removedMedia' | 'removedStaging' | 'removedDeleting',
    string
  >();
  private sessionCursor: string | undefined;

  constructor(private readonly options: CreateMaintenanceServiceOptions) {
    if (!isAbsolute(options.mediaRoot) || !isAbsolute(options.stagingRoot)) {
      throw new MaintenanceSafetyError();
    }
    this.mediaRoot = resolve(options.mediaRoot);
    this.stagingRoot = resolve(options.stagingRoot);
    if (rootsOverlap(this.mediaRoot, this.stagingRoot)) {
      throw new MaintenanceSafetyError();
    }
    this.now = options.now ?? (() => new Date());
    this.remove = options.remove ?? fileSystemRemove;
    this.rename = options.rename ?? fileSystemRename;
  }

  async run(): Promise<MaintenanceSummary> {
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('Invalid clock value');
    }
    const media = await rootDirectory(this.mediaRoot);
    const staging = await rootDirectory(this.stagingRoot);
    if (rootsOverlap(media.canonical, staging.canonical)) {
      throw new MaintenanceSafetyError();
    }
    const deleting = await deletingDirectory(media);
    const summary: MutableSummary = {
      inspected: 0,
      removedMedia: 0,
      removedStaging: 0,
      removedDeleting: 0,
      expiredSessions: 0,
      failures: 0,
    };
    const cutoff = now.getTime() - STALE_MILLISECONDS;

    await this.scanRoot(media, CANONICAL_UUID, 'removedMedia', cutoff, summary, true, '.deleting');
    await this.scanRoot(staging, CANONICAL_UUID, 'removedStaging', cutoff, summary, false);
    await this.scanRoot(
      deleting,
      DELETING_ENTRY,
      'removedDeleting',
      cutoff,
      summary,
      false,
      undefined,
      media,
    );
    this.cleanupSessions(now, summary);
    return summary;
  }

  private async scanRoot(
    root: SafeRoot,
    acceptedName: RegExp,
    counter: 'removedMedia' | 'removedStaging' | 'removedDeleting',
    cutoff: number,
    summary: MutableSummary,
    requireOrphan: boolean,
    ignoredName?: string,
    recoveryMedia?: SafeRoot,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(root.configured, { withFileTypes: true });
    } catch {
      throw new MaintenanceSafetyError();
    }
    const ordered = entries
      .filter((entry) => entry.name !== ignoredName)
      .sort((left, right) => compareNames(left.name, right.name));
    const cursor = this.scanCursors.get(counter);
    const afterCursor = cursor === undefined
      ? 0
      : ordered.findIndex((entry) => compareNames(entry.name, cursor) > 0);
    const start = afterCursor < 0 ? 0 : afterCursor;
    const bounded = [
      ...ordered.slice(start),
      ...ordered.slice(0, start),
    ].slice(0, SOURCE_BUDGET);
    for (const entry of bounded) {
      summary.inspected += 1;
      try {
        const deletingMatch = recoveryMedia === undefined
          ? undefined
          : DELETING_ENTRY.exec(entry.name);
        if (
          recoveryMedia === undefined
            ? !acceptedName.test(entry.name)
            : deletingMatch === null
        ) {
          continue;
        }
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new MaintenanceSafetyError();
        }
        const path = child(root.configured, entry.name);
        const information = await lstat(path);
        if (
          information.isSymbolicLink()
          || !information.isDirectory()
          || !Number.isFinite(information.mtimeMs)
          || information.mtimeMs >= cutoff
        ) {
          if (information.isSymbolicLink() || !information.isDirectory()) {
            throw new MaintenanceSafetyError();
          }
          continue;
        }
        if (
          requireOrphan
          && this.options.db.prepare('SELECT 1 FROM photos WHERE id = ?').get(entry.name) !== undefined
        ) {
          continue;
        }
        const identity = await assertSafeTree(path, root.canonical);
        if (!(await identityStillMatches(path, identity))) {
          throw new MaintenanceSafetyError();
        }
        if (
          recoveryMedia !== undefined
          && deletingMatch !== undefined
          && deletingMatch !== null
        ) {
          const photoId = deletingMatch[1];
          if (photoId === undefined) {
            throw new MaintenanceSafetyError();
          }
          if (this.photoExists(photoId)) {
            await this.restoreDeletingTree(recoveryMedia, path, photoId, identity);
            continue;
          }
        }
        await this.remove(path, { recursive: true, force: false });
        summary[counter] += 1;
      } catch {
        summary.failures += 1;
      }
    }
    const lastInspected = bounded.at(-1);
    if (lastInspected !== undefined) {
      // Retained and failing prefixes must still advance so later entries get a turn.
      this.scanCursors.set(counter, lastInspected.name);
    }
  }

  private photoExists(photoId: string): boolean {
    return this.options.db.prepare('SELECT 1 FROM photos WHERE id = ?').get(photoId) !== undefined;
  }

  private async restoreDeletingTree(
    media: SafeRoot,
    target: string,
    photoId: string,
    targetIdentity: FileIdentity,
  ): Promise<void> {
    const source = child(media.configured, photoId);
    let reservationIdentity: FileIdentity;
    try {
      await mkdir(source, { mode: 0o700 });
      reservationIdentity = await assertSafeTree(source, media.canonical);
    } catch {
      throw new MaintenanceSafetyError();
    }

    try {
      if (!this.photoExists(photoId)) {
        await this.removeEmptyReservation(source, reservationIdentity);
        return;
      }
      if (!(await identityStillMatches(target, targetIdentity))) {
        throw new MaintenanceSafetyError();
      }
      await this.rename(target, source);
      const restoredTarget = await identityStillMatches(source, targetIdentity);
      const targetIsMissing = await pathMissing(target);
      if (!restoredTarget || !targetIsMissing) {
        if (!restoredTarget && targetIsMissing && !(await pathMissing(source))) {
          try {
            await this.rename(source, target);
          } catch {
            // Leave whichever private/public paths exist for a later safe retry.
          }
        }
        throw new MaintenanceSafetyError();
      }

      if (!this.photoExists(photoId)) {
        if (!(await pathMissing(target))) {
          throw new MaintenanceSafetyError();
        }
        await this.rename(source, target);
        if (
          !(await identityStillMatches(target, targetIdentity))
          || !(await pathMissing(source))
        ) {
          throw new MaintenanceSafetyError();
        }
      }
    } catch (error) {
      if (await identityStillMatches(source, reservationIdentity)) {
        try {
          await rmdir(source);
        } catch {
          // A populated or replaced reservation belongs to a concurrent writer.
        }
      }
      throw error;
    }
  }

  private async removeEmptyReservation(
    source: string,
    reservationIdentity: FileIdentity,
  ): Promise<void> {
    if (!(await identityStillMatches(source, reservationIdentity))) {
      throw new MaintenanceSafetyError();
    }
    try {
      await rmdir(source);
    } catch {
      throw new MaintenanceSafetyError();
    }
  }

  private cleanupSessions(now: Date, summary: MutableSummary): void {
    const nowIso = now.toISOString();
    const idleCutoff = new Date(now.getTime() - IDLE_MILLISECONDS).toISOString();
    let sessions: Array<{ readonly token_hash: string }>;
    try {
      sessions = this.sessionCursor === undefined
        ? this.options.db.prepare(
          `SELECT token_hash
           FROM sessions
           WHERE absolute_expires_at <= ? OR last_activity_at <= ?
           ORDER BY token_hash ASC
           LIMIT ?`,
        ).all(nowIso, idleCutoff, SOURCE_BUDGET) as Array<{ readonly token_hash: string }>
        : this.options.db.prepare(
          `SELECT token_hash
           FROM sessions
           WHERE absolute_expires_at <= ? OR last_activity_at <= ?
           ORDER BY CASE WHEN token_hash > ? THEN 0 ELSE 1 END ASC, token_hash ASC
           LIMIT ?`,
        ).all(
          nowIso,
          idleCutoff,
          this.sessionCursor,
          SOURCE_BUDGET,
        ) as Array<{ readonly token_hash: string }>;
    } catch {
      summary.failures += 1;
      return;
    }

    for (const session of sessions) {
      summary.inspected += 1;
      try {
        const deletion = this.options.db.prepare(
          `DELETE FROM sessions
           WHERE token_hash = ?
             AND (absolute_expires_at <= ? OR last_activity_at <= ?)`,
        ).run(session.token_hash, nowIso, idleCutoff);
        summary.expiredSessions += deletion.changes;
      } catch {
        summary.failures += 1;
      }
    }
    const lastInspected = sessions.at(-1);
    if (lastInspected !== undefined) {
      // A row-specific deletion failure must not starve later expired sessions.
      this.sessionCursor = lastInspected.token_hash;
    }
  }
}

export function createMaintenanceService(
  options: CreateMaintenanceServiceOptions,
): MaintenanceService {
  return new BoundedMaintenanceService(options);
}
