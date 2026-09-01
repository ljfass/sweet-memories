// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import exifr from 'exifr';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IMAGE_INPUT_OPTIONS,
  RESPONSIVE_OUTPUTS,
  processPhoto,
  type ProcessPhotoOptions,
} from './processor.js';
import { MEDIA_GROUP_NAME, MediaStorage } from './storage.js';

const currentGroupId = process.getgid?.();

let temporaryDirectory: string;
let inputDirectory: string;
let mediaRoot: string;
let stagingRoot: string;

beforeEach(async () => {
  if (currentGroupId === undefined) {
    throw new Error('Media processor tests require a POSIX process');
  }
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'sweet-memories-processor-'));
  inputDirectory = join(temporaryDirectory, 'private-inputs');
  mediaRoot = join(temporaryDirectory, 'media');
  stagingRoot = join(temporaryDirectory, 'staging');
  await Promise.all([
    mkdir(inputDirectory),
    mkdir(mediaRoot),
    mkdir(stagingRoot),
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

async function createJpeg(
  name: string,
  width: number,
  height: number,
  metadata = false,
): Promise<string> {
  const path = join(inputDirectory, name);
  let image = sharp({
    create: { width, height, channels: 3, background: '#c53d5d' },
  }).jpeg();
  if (metadata) {
    image = image
      .withMetadata({ orientation: 6 })
      .withExifMerge({
        IFD0: { Model: 'Private Camera' },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '37/1 48/1 0/1',
          GPSLongitudeRef: 'W',
          GPSLongitude: '122/1 24/1 0/1',
        },
      });
  }
  await image.toFile(path);
  return path;
}

async function runProcessor(
  inputPath: string,
  options: Partial<Omit<ProcessPhotoOptions, 'inputPath' | 'transaction'>> = {},
) {
  const transaction = await createStorage().createTransaction(randomUUID());
  const manifest = await processPhoto({
    inputPath,
    inputKind: 'jpeg',
    transaction,
    ...options,
  });
  return { manifest, transaction };
}

describe('responsive photo processing', () => {
  it('uses bounded sequential Sharp input and the fixed output quality contract', () => {
    expect(IMAGE_INPUT_OPTIONS).toEqual({
      limitInputPixels: 60_000_000,
      sequentialRead: true,
    });
    expect(RESPONSIVE_OUTPUTS).toEqual([
      { format: 'avif', quality: 62 },
      { format: 'webp', quality: 78 },
      { format: 'jpeg', quality: 82 },
    ]);
  });

  it('generates a sanitized master and four widths in AVIF, WebP, and JPEG', async () => {
    const inputPath = await createJpeg('a-private-original-name.jpg', 1_700, 1_000);
    const { manifest, transaction } = await runProcessor(inputPath);

    expect(manifest.master).toMatchObject({
      kind: 'master',
      format: 'jpeg',
      width: 1_700,
      height: 1_000,
    });
    expect(basename(manifest.master.relativePath)).toBe('master.jpg');
    expect([...new Set(manifest.assets.map(({ width }) => width))]).toEqual([
      320, 640, 960, 1_600,
    ]);
    expect(new Set(manifest.assets.map(({ format }) => format))).toEqual(
      new Set(['avif', 'webp', 'jpeg']),
    );
    expect(manifest.assets).toHaveLength(12);
    for (const asset of [manifest.master, ...manifest.assets]) {
      expect(asset.relativePath).not.toContain('a-private-original-name');
      await expect(stat(join(mediaRoot, asset.relativePath))).resolves.toBeDefined();
    }
    await expect(stat(transaction.stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('auto-rotates and removes camera, orientation, EXIF, and GPS metadata', async () => {
    const inputPath = await createJpeg('location-and-camera.jpg', 4, 2, true);
    await expect(exifr.gps(inputPath)).resolves.toEqual({ latitude: 37.8, longitude: -122.4 });
    await expect(exifr.parse(inputPath)).resolves.toMatchObject({
      Model: 'Private Camera',
      Orientation: 'Rotate 90 CW',
    });

    const { manifest } = await runProcessor(inputPath);
    const publicJpeg = join(mediaRoot, manifest.master.relativePath);
    const metadata = await sharp(publicJpeg).metadata();

    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 2, height: 4 });
    expect(metadata.orientation).toBeUndefined();
    await expect(exifr.gps(publicJpeg)).resolves.toBeUndefined();
    await expect(exifr.parse(publicJpeg)).resolves.toBeUndefined();
  });

  it('does not upscale small photos and emits each actual width only once per format', async () => {
    const inputPath = await createJpeg('small-source.jpg', 500, 300);
    const { manifest } = await runProcessor(inputPath);

    expect(manifest.assets.map(({ width }) => width)).toEqual([
      320, 320, 320, 500, 500, 500,
    ]);
    expect(manifest.assets.map(({ relativePath }) => basename(relativePath))).toEqual([
      '320.avif', '320.webp', '320.jpeg', '500.avif', '500.webp', '500.jpeg',
    ]);
    expect(new Set(manifest.assets.map(({ relativePath }) => relativePath)).size).toBe(6);
  });

  it('uses the bounded configured HEIF converter and removes private temporary inputs', async () => {
    const transaction = await createStorage().createTransaction(randomUUID());
    const privateInput = join(transaction.stagingDir, 'untrusted-original.heic');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(privateInput, 'heic'));
    const convertHeif = vi.fn(async (
      inputPath: string,
      outputPath: string,
      options?: { executable?: string },
    ) => {
      expect(inputPath).toBe(privateInput);
      expect(options?.executable).toBe('/configured/heif-convert');
      await sharp({
        create: { width: 400, height: 300, channels: 3, background: '#3465a4' },
      }).png().toFile(outputPath);
    });

    const manifest = await processPhoto({
      inputPath: privateInput,
      inputKind: 'heic',
      transaction,
      heifConvertPath: '/configured/heif-convert',
      convertHeif,
    });

    expect(convertHeif).toHaveBeenCalledOnce();
    const publishedNames = await readdir(transaction.finalDir);
    expect(publishedNames).not.toContain('untrusted-original.heic');
    expect(publishedNames).not.toContain('.decoded-input.png');
    expect(manifest.assets.map(({ width }) => width)).toEqual([
      320, 320, 320, 400, 400, 400,
    ]);
  });

  it('cleans staging and generated partial files when any processing step fails', async () => {
    const inputPath = await createJpeg('will-fail.jpg', 500, 300);
    const transaction = await createStorage().createTransaction(randomUUID());
    await mkdir(join(transaction.stagingDir, '320.avif'));

    await expect(processPhoto({
      inputPath,
      inputKind: 'jpeg',
      transaction,
    })).rejects.toBeDefined();

    await expect(stat(transaction.stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(transaction.finalDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(stagingRoot)).toEqual([]);
    expect(await readdir(mediaRoot)).toEqual([]);
  });

  it('rolls back a failed HEIF conversion without leaving its private upload', async () => {
    const transaction = await createStorage().createTransaction(randomUUID());
    const privateInput = join(transaction.stagingDir, 'upload.heif');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(privateInput, 'heif'));

    await expect(processPhoto({
      inputPath: privateInput,
      inputKind: 'heif',
      transaction,
      heifConvertPath: '/configured/heif-convert',
      convertHeif: vi.fn().mockRejectedValue(new Error('conversion failed')),
    })).rejects.toThrow('conversion failed');

    await expect(stat(transaction.stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(transaction.finalDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
