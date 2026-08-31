// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  MAX_IMAGE_PIXELS,
  inspectInput,
  parseExifCalendarDate,
  type InspectInputDependencies,
} from './inspect-input.js';

const fixtureDirectory = join(import.meta.dirname, '../../test/fixtures');
const validHeic = join(fixtureDirectory, 'valid.heic');
const notAnImage = join(fixtureDirectory, 'not-an-image.bin');

let temporaryDirectory: string;
let jpegPath: string;
let pngPath: string;
let webpPath: string;
let heifPath: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'sweet-memories-inspect-'));
  jpegPath = join(temporaryDirectory, 'renamed-as-text.txt');
  pngPath = join(temporaryDirectory, 'renamed-as-jpeg.jpg');
  webpPath = join(temporaryDirectory, 'photo.webp');
  heifPath = join(temporaryDirectory, 'photo.heif');

  const pixels = Buffer.from([255, 0, 0, 255]);
  await Promise.all([
    sharp(pixels, { raw: { width: 1, height: 1, channels: 4 } }).jpeg().toFile(jpegPath),
    sharp(pixels, { raw: { width: 1, height: 1, channels: 4 } }).png().toFile(pngPath),
    sharp(pixels, { raw: { width: 1, height: 1, channels: 4 } }).webp().toFile(webpPath),
  ]);

  const heif = await readFile(validHeic);
  const heifWithGenericBrand = Buffer.from(heif);
  heifWithGenericBrand.write('mif1', 8, 'ascii');
  await writeFile(heifPath, heifWithGenericBrand);
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function heifDependencies(): InspectInputDependencies {
  return {
    inspectHeif: vi.fn().mockResolvedValue({ width: 64, height: 48 }),
    parseExif: vi.fn().mockResolvedValue(undefined),
  };
}

describe('inspectInput format recognition', () => {
  it.each([
    ['jpeg', () => jpegPath, 'image/jpeg'],
    ['png', () => pngPath, 'image/png'],
    ['webp', () => webpPath, 'image/webp'],
  ] as const)('recognizes %s from content without trusting the extension', async (kind, getPath, mime) => {
    await expect(inspectInput(getPath())).resolves.toMatchObject({ kind, mime, width: 1, height: 1 });
  });

  it.each([
    ['heic', () => validHeic, 'image/heic'],
    ['heif', () => heifPath, 'image/heif'],
  ] as const)('recognizes real %s magic bytes', async (kind, getPath, mime) => {
    await expect(inspectInput(getPath(), heifDependencies())).resolves.toMatchObject({
      kind,
      mime,
      width: 64,
      height: 48,
    });
  });

  it.each([
    ['plain bytes with a jpeg extension', async () => {
      const path = join(temporaryDirectory, 'fake.jpg');
      await writeFile(path, await readFile(notAnImage));
      return path;
    }],
    ['GIF', async () => {
      const path = join(temporaryDirectory, 'photo.gif');
      await writeFile(path, Buffer.from('47494638396101000100', 'hex'));
      return path;
    }],
    ['AVIF', async () => {
      const path = join(temporaryDirectory, 'photo.avif');
      await writeFile(path, Buffer.from('00000018667479706176696600000000617669666d696631', 'hex'));
      return path;
    }],
    ['HEIF sequence', async () => {
      const path = join(temporaryDirectory, 'sequence.heif');
      await writeFile(path, Buffer.from('00000018667479706d736631000000006d7366316d696631', 'hex'));
      return path;
    }],
  ])('rejects unsupported content: %s', async (_label, createPath) => {
    await expect(inspectInput(await createPath(), heifDependencies())).rejects.toMatchObject({
      code: 'UNSUPPORTED_IMAGE',
    });
  });

  it('rejects a damaged file even when its magic bytes look like JPEG', async () => {
    const damagedJpeg = join(temporaryDirectory, 'damaged.jpg');
    await writeFile(damagedJpeg, Buffer.from('ffd8ffe000104a4649460001', 'hex'));

    await expect(inspectInput(damagedJpeg)).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
  });
});

describe('inspectInput dimensions', () => {
  function dimensions(width: number, height: number): InspectInputDependencies {
    return {
      readMetadata: vi.fn().mockResolvedValue({ width, height }),
      parseExif: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('allows exactly sixty million pixels', async () => {
    await expect(inspectInput(jpegPath, dimensions(MAX_IMAGE_PIXELS, 1))).resolves.toMatchObject({
      width: MAX_IMAGE_PIXELS,
      height: 1,
    });
  });

  it('rejects one pixel above sixty million', async () => {
    await expect(inspectInput(jpegPath, dimensions(MAX_IMAGE_PIXELS + 1, 1))).rejects.toMatchObject({
      code: 'IMAGE_PIXEL_LIMIT',
    });
  });

  it.each([
    ['zero', 0, 1],
    ['negative', -1, 1],
    ['not finite', Number.POSITIVE_INFINITY, 1],
    ['not an integer', 1.5, 1],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1, 1],
  ])('rejects %s dimensions', async (_label, width, height) => {
    await expect(inspectInput(jpegPath, dimensions(width, height))).rejects.toMatchObject({
      code: 'INVALID_IMAGE_DIMENSIONS',
    });
  });

  it('rejects animated or multi-page ordinary image metadata', async () => {
    await expect(inspectInput(jpegPath, {
      ...dimensions(1, 1),
      readMetadata: vi.fn().mockResolvedValue({ width: 1, height: 1, pages: 2 }),
    })).rejects.toMatchObject({ code: 'IMAGE_SEQUENCE_UNSUPPORTED' });
  });
});

describe('EXIF calendar dates', () => {
  it.each([
    ['2024:02:29 23:59:59', '2024-02-29'],
    ['2000:02:29 00:00:00', '2000-02-29'],
    ['2026:01:01 00:30:00', '2026-01-01'],
  ])('extracts the raw calendar date without timezone conversion', (raw, expected) => {
    expect(parseExifCalendarDate(raw)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    new Date('2026-01-01T00:00:00Z'),
    '2023:02:29 10:00:00',
    '2024:13:01 10:00:00',
    '2024:01:01 24:00:00',
    '2024:01:01',
    '0000:01:01 00:00:00',
  ])('rejects a non-raw or invalid EXIF date: %s', (raw) => {
    expect(parseExifCalendarDate(raw)).toBeNull();
  });

  it('prefers DateTimeOriginal, falls back to CreateDate, and passes exact exifr options', async () => {
    const parseExif = vi.fn().mockResolvedValue({
      DateTimeOriginal: '2023:02:29 12:00:00',
      CreateDate: '2024:05:06 07:08:09',
    });

    await expect(inspectInput(jpegPath, { parseExif })).resolves.toMatchObject({
      takenDate: '2024-05-06',
    });
    expect(parseExif).toHaveBeenCalledWith(jpegPath, {
      pick: ['DateTimeOriginal', 'CreateDate'],
      reviveValues: false,
      translateValues: false,
    });
  });

  it('returns null when EXIF is absent, malformed, a revived Date, or throws', async () => {
    const values = [
      undefined,
      { DateTimeOriginal: 'not a date' },
      { DateTimeOriginal: new Date('2026-01-01T00:00:00Z') },
    ];

    for (const value of values) {
      await expect(inspectInput(jpegPath, {
        parseExif: vi.fn().mockResolvedValue(value),
      })).resolves.toMatchObject({ takenDate: null });
    }
    await expect(inspectInput(jpegPath, {
      parseExif: vi.fn().mockRejectedValue(new Error('bad metadata')),
    })).resolves.toMatchObject({ takenDate: null });
  });
});
