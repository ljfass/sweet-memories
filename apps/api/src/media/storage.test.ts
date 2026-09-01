// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MEDIA_GROUP_NAME,
  MediaStorage,
  MediaStorageError,
} from './storage.js';

const currentGroupId = process.getgid?.();

let temporaryDirectory: string;
let mediaRoot: string;
let stagingRoot: string;

beforeEach(async () => {
  if (currentGroupId === undefined) {
    throw new Error('Media storage tests require a POSIX process');
  }
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'sweet-memories-storage-'));
  mediaRoot = join(temporaryDirectory, 'media');
  stagingRoot = join(temporaryDirectory, 'staging');
  await Promise.all([
    mkdir(mediaRoot, { recursive: true }),
    mkdir(stagingRoot, { recursive: true }),
  ]);
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function createStorage(): MediaStorage {
  return new MediaStorage({
    mediaRoot,
    stagingRoot,
    resolveMediaGroupId: async (groupName) => {
      expect(groupName).toBe(MEDIA_GROUP_NAME);
      return currentGroupId as number;
    },
    getProcessGroupId: () => currentGroupId as number,
  });
}

describe('MediaStorage path and group boundaries', () => {
  it.each([
    '../outside',
    'not-a-uuid',
    '0195C681-9C63-7DB0-8000-000000000001',
    '0195c681-9c63-7db0-7000-000000000001',
    '0195c681-9c63-7db0-8000-000000000001/extra',
  ])('rejects a non-canonical server photo id: %s', async (photoId) => {
    await expect(createStorage().createTransaction(photoId)).rejects.toMatchObject({
      code: 'INVALID_PHOTO_ID',
    });
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  it('fails closed when the process primary group is not sweet-memories-media', async () => {
    const storage = new MediaStorage({
      mediaRoot,
      stagingRoot,
      resolveMediaGroupId: async () => (currentGroupId as number) + 1,
      getProcessGroupId: () => currentGroupId as number,
    });

    await expect(storage.createTransaction(randomUUID())).rejects.toMatchObject({
      code: 'MEDIA_GROUP_MISMATCH',
    });
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  it('creates a contained private staging directory owned by the required group', async () => {
    const photoId = randomUUID();
    const transaction = await createStorage().createTransaction(photoId);
    const stagingInfo = await stat(transaction.stagingDir);

    expect(relative(stagingRoot, transaction.stagingDir)).not.toMatch(/^\.\.(?:\/|$)/u);
    expect(relative(mediaRoot, transaction.finalDir)).toBe(photoId);
    expect(basename(transaction.stagingDir)).not.toContain(photoId);
    expect(stagingInfo.mode & 0o777).toBe(0o700);
    expect(stagingInfo.gid).toBe(currentGroupId);

    await transaction.rollback();
  });

  it('rejects an existing final target immediately without creating staging', async () => {
    const photoId = randomUUID();
    await mkdir(join(mediaRoot, photoId));
    await writeFile(join(mediaRoot, photoId, 'existing.txt'), 'keep');

    await expect(createStorage().createTransaction(photoId)).rejects.toMatchObject({
      code: 'MEDIA_TARGET_EXISTS',
    });
    expect(await readdir(stagingRoot)).toEqual([]);
    await expect(readFile(join(mediaRoot, photoId, 'existing.txt'), 'utf8')).resolves.toBe('keep');
  });
});

describe('MediaTransaction commit and rollback', () => {
  it('atomically publishes with read-only media permissions while preserving the group', async () => {
    const photoId = randomUUID();
    const transaction = await createStorage().createTransaction(photoId);
    await writeFile(join(transaction.stagingDir, 'master.jpg'), 'master', { mode: 0o600 });
    await writeFile(join(transaction.stagingDir, '320.jpeg'), 'responsive', { mode: 0o600 });
    expect((await stat(join(transaction.stagingDir, 'master.jpg'))).gid).toBe(currentGroupId);
    expect((await stat(join(transaction.stagingDir, '320.jpeg'))).gid).toBe(currentGroupId);

    await transaction.commit();

    await expect(stat(transaction.stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
    const finalInfo = await stat(transaction.finalDir);
    const masterInfo = await stat(join(transaction.finalDir, 'master.jpg'));
    const responsiveInfo = await stat(join(transaction.finalDir, '320.jpeg'));
    expect(finalInfo.mode & 0o777).toBe(0o750);
    expect(masterInfo.mode & 0o777).toBe(0o640);
    expect(responsiveInfo.mode & 0o777).toBe(0o640);
    expect(new Set([finalInfo.gid, masterInfo.gid, responsiveInfo.gid])).toEqual(
      new Set([currentGroupId]),
    );
  });

  it('never replaces a target that appears after transaction creation', async () => {
    const photoId = randomUUID();
    const transaction = await createStorage().createTransaction(photoId);
    await writeFile(join(transaction.stagingDir, 'master.jpg'), 'new');
    await mkdir(transaction.finalDir);
    await writeFile(join(transaction.finalDir, 'existing.txt'), 'keep');

    await expect(transaction.commit()).rejects.toMatchObject({
      code: 'MEDIA_TARGET_EXISTS',
    });
    await expect(readFile(join(transaction.finalDir, 'existing.txt'), 'utf8')).resolves.toBe('keep');
    await expect(stat(transaction.stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back staging and an owned published directory idempotently', async () => {
    const transaction = await createStorage().createTransaction(randomUUID());
    await writeFile(join(transaction.stagingDir, 'master.jpg'), 'new');
    await transaction.commit();

    await transaction.rollback();
    await transaction.rollback();

    await expect(stat(transaction.stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(transaction.finalDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects links and cleans the transaction instead of publishing them', async () => {
    const transaction = await createStorage().createTransaction(randomUUID());
    const outsideFile = join(temporaryDirectory, 'outside.txt');
    await writeFile(outsideFile, 'private');
    await import('node:fs/promises').then(({ symlink }) => (
      symlink(outsideFile, join(transaction.stagingDir, 'master.jpg'))
    ));

    await expect(transaction.commit()).rejects.toBeInstanceOf(MediaStorageError);
    await expect(stat(transaction.stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('private');
  });
});
