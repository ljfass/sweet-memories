// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileTypeFromFile } from 'file-type';
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
let avifPath: string;
let exifJpegPath: string;
let terminalZeroSizedMdatPath: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'sweet-memories-inspect-'));
  jpegPath = join(temporaryDirectory, 'renamed-as-text.txt');
  pngPath = join(temporaryDirectory, 'renamed-as-jpeg.jpg');
  webpPath = join(temporaryDirectory, 'photo.webp');
  heifPath = join(temporaryDirectory, 'photo.heif');
  avifPath = join(temporaryDirectory, 'photo.avif');
  exifJpegPath = join(temporaryDirectory, 'photo-with-exif.jpg');
  terminalZeroSizedMdatPath = join(temporaryDirectory, 'terminal-zero-sized-mdat.heic');

  const pixels = Buffer.from([255, 0, 0, 255]);
  await Promise.all([
    sharp(pixels, { raw: { width: 1, height: 1, channels: 4 } }).jpeg().toFile(jpegPath),
    sharp(pixels, { raw: { width: 1, height: 1, channels: 4 } }).png().toFile(pngPath),
    sharp(pixels, { raw: { width: 1, height: 1, channels: 4 } }).webp().toFile(webpPath),
    sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } })
      .avif()
      .toFile(avifPath),
    sharp(pixels, { raw: { width: 1, height: 1, channels: 4 } })
      .jpeg()
      .withExif({ IFD2: { DateTimeOriginal: '2024:02:29 23:59:59' } })
      .toFile(exifJpegPath),
  ]);

  const heif = await readFile(validHeic);
  const heifWithGenericBrand = Buffer.from(heif);
  heifWithGenericBrand.write('mif1', 8, 'ascii');
  const zeroSizedMdat = Buffer.from(heif);
  zeroSizedMdat.writeUInt32BE(0, findTerminalTopLevelBoxOffset(zeroSizedMdat));
  await Promise.all([
    writeFile(heifPath, heifWithGenericBrand),
    writeFile(terminalZeroSizedMdatPath, zeroSizedMdat),
  ]);
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

function findTerminalTopLevelBoxOffset(buffer: Buffer): number {
  let offset = 0;
  while (offset <= buffer.length - 8) {
    const size32 = buffer.readUInt32BE(offset);
    const size = size32 === 1
      ? Number(buffer.readBigUInt64BE(offset + 8))
      : size32;
    if (size < 8 || offset + size > buffer.length) {
      throw new Error('invalid test fixture');
    }
    if (offset + size === buffer.length) {
      if (buffer.toString('ascii', offset + 4, offset + 8) !== 'mdat') {
        throw new Error('expected terminal mdat fixture');
      }
      return offset;
    }
    offset += size;
  }

  throw new Error('terminal box missing from test fixture');
}

function bmffBox(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  payload.copy(box, 8);
  return box;
}

function zeroSizedBox(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const box = bmffBox(type, payload);
  box.writeUInt32BE(0, 0);
  return box;
}

function fullBoxPayload(version: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([Buffer.from([version, 0, 0, 0]), payload]);
}

function syntheticFtyp(): Buffer {
  return bmffBox('ftyp', Buffer.concat([
    Buffer.from('mif1', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('mif1miaf', 'ascii'),
  ]));
}

function itemInfoEntry(version: 2 | 3, itemType: string): Buffer {
  const identity = version === 2
    ? Buffer.from([0, 1, 0, 0])
    : Buffer.from([0, 0, 0, 1, 0, 0]);
  return bmffBox('infe', fullBoxPayload(version, Buffer.concat([
    identity,
    Buffer.from(itemType, 'ascii'),
    Buffer.from([0]),
  ])));
}

function itemInformation(entry: Buffer): Buffer {
  const count = Buffer.alloc(2);
  count.writeUInt16BE(1);
  return bmffBox('iinf', fullBoxPayload(0, Buffer.concat([count, entry])));
}

function itemProperties(property: Buffer): Buffer {
  return bmffBox('iprp', bmffBox('ipco', property));
}

function metadataBox(...children: Buffer[]): Buffer {
  return bmffBox('meta', fullBoxPayload(0, Buffer.concat(children)));
}

async function writeSyntheticHeif(name: string, ...boxes: Buffer[]): Promise<string> {
  const path = join(temporaryDirectory, name);
  await writeFile(path, Buffer.concat([syntheticFtyp(), ...boxes]));
  return path;
}

async function expectRejectedBeforeHeifInspection(path: string): Promise<void> {
  const inspectHeif = vi.fn().mockResolvedValue({ width: 2, height: 2 });
  await expect(inspectInput(path, {
    inspectHeif,
    parseExif: vi.fn().mockResolvedValue(undefined),
  })).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
  expect(inspectHeif).not.toHaveBeenCalled();
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

  it('accepts a real HEIC whose terminal top-level mdat extends to EOF', async () => {
    await expect(fileTypeFromFile(terminalZeroSizedMdatPath)).resolves.toMatchObject({
      mime: 'image/heic',
    });
    await expect(sharp(terminalZeroSizedMdatPath).metadata()).resolves.toMatchObject({
      width: 48,
      height: 64,
      compression: 'hevc',
    });

    const inspectHeif = vi.fn().mockResolvedValue({ width: 48, height: 64 });
    await expect(inspectInput(terminalZeroSizedMdatPath, {
      inspectHeif,
      parseExif: vi.fn().mockResolvedValue(undefined),
    })).resolves.toMatchObject({ kind: 'heic', width: 48, height: 64 });
    expect(inspectHeif).toHaveBeenCalledOnce();
  });

  it('rejects a nested zero-sized box even when HEVC metadata is otherwise valid', async () => {
    const path = await writeSyntheticHeif(
      'nested-zero-sized-box.heif',
      metadataBox(
        itemInformation(itemInfoEntry(2, 'hvc1')),
        itemProperties(bmffBox('hvcC')),
        zeroSizedBox('free'),
      ),
    );
    await expectRejectedBeforeHeifInspection(path);
  });

  it('rejects a non-terminal nested zero-sized box before following siblings', async () => {
    const path = await writeSyntheticHeif(
      'non-terminal-nested-zero-sized-box.heif',
      metadataBox(
        zeroSizedBox('free'),
        itemInformation(itemInfoEntry(2, 'hvc1')),
        itemProperties(bmffBox('hvcC')),
      ),
    );
    await expectRejectedBeforeHeifInspection(path);
  });

  it('rejects an incomplete top-level box boundary', async () => {
    const path = await writeSyntheticHeif(
      'incomplete-top-level-box.heif',
      metadataBox(
        itemInformation(itemInfoEntry(2, 'hvc1')),
        itemProperties(bmffBox('hvcC')),
      ),
      Buffer.alloc(7),
    );
    await expectRejectedBeforeHeifInspection(path);
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
      const path = join(temporaryDirectory, 'minimal.avif');
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

  it('rejects a real AVIF image', async () => {
    await expect(inspectInput(avifPath, heifDependencies())).rejects.toMatchObject({
      code: 'UNSUPPORTED_IMAGE',
    });
  });

  it('rejects AVIF codec metadata after every AVIF ftyp brand is disguised', async () => {
    const avif = await readFile(avifPath);
    expect(avif.toString('ascii', 4, 8)).toBe('ftyp');
    const ftypSize = avif.readUInt32BE(0);
    const brands = [avif.toString('ascii', 8, 12), ...Array.from(
      { length: (ftypSize - 16) / 4 },
      (_, index) => avif.toString('ascii', 16 + index * 4, 20 + index * 4),
    )];
    expect(brands).toEqual(['avif', 'mif1', 'avif', 'miaf']);

    const disguised = Buffer.from(avif);
    disguised.write('mif1', 8, 'ascii');
    disguised.write('mif1', 16, 'ascii');
    disguised.write('miaf', 20, 'ascii');
    disguised.write('miaf', 24, 'ascii');
    expect([
      disguised.toString('ascii', 8, 12),
      disguised.toString('ascii', 16, 20),
      disguised.toString('ascii', 20, 24),
      disguised.toString('ascii', 24, 28),
    ]).toEqual(['mif1', 'mif1', 'miaf', 'miaf']);
    const disguisedPath = join(temporaryDirectory, 'disguised-avif.heif');
    await writeFile(disguisedPath, disguised);
    await expect(sharp(disguisedPath).metadata()).resolves.toMatchObject({ width: 2, height: 2 });
    await expect(fileTypeFromFile(disguisedPath)).resolves.toMatchObject({ mime: 'image/heif' });
    await expectRejectedBeforeHeifInspection(disguisedPath);
  });

  it.each([2, 3] as const)('rejects an infe version %i av01 item type', async (version) => {
    const path = await writeSyntheticHeif(
      `av01-infe-v${version}.heif`,
      metadataBox(itemInformation(itemInfoEntry(version, 'av01'))),
    );
    await expectRejectedBeforeHeifInspection(path);
  });

  it('rejects an av1C item property even when no infe item exposes the codec', async () => {
    const path = await writeSyntheticHeif(
      'av1c-property.heif',
      metadataBox(itemProperties(bmffBox('av1C'))),
    );
    await expectRejectedBeforeHeifInspection(path);
  });

  it('accepts structurally valid HEVC item and property metadata', async () => {
    const path = await writeSyntheticHeif(
      'synthetic-hevc.heif',
      metadataBox(
        itemInformation(itemInfoEntry(2, 'hvc1')),
        itemProperties(bmffBox('hvcC')),
      ),
    );

    await expect(inspectInput(path, heifDependencies())).resolves.toMatchObject({
      kind: 'heif',
      width: 64,
      height: 48,
    });
  });

  it.each([
    ['zero-sized metadata box', () => {
      const box = Buffer.alloc(8);
      box.write('meta', 4, 4, 'ascii');
      return box;
    }],
    ['extended-sized metadata box', () => {
      const box = Buffer.alloc(20);
      box.writeUInt32BE(1, 0);
      box.write('meta', 4, 4, 'ascii');
      box.writeBigUInt64BE(20n, 8);
      return box;
    }],
    ['out-of-bounds metadata box', () => {
      const box = Buffer.alloc(8);
      box.writeUInt32BE(64, 0);
      box.write('meta', 4, 4, 'ascii');
      return box;
    }],
    ['truncated metadata FullBox', () => bmffBox('meta', Buffer.alloc(3))],
  ])('rejects malformed BMFF structure: %s', async (label, createBox) => {
    const path = await writeSyntheticHeif(`malformed-${label.replaceAll(' ', '-')}.heif`, createBox());
    await expectRejectedBeforeHeifInspection(path);
  });

  it('rejects metadata nesting beyond the inspection depth limit', async () => {
    let nested = metadataBox();
    for (let depth = 0; depth < 10; depth += 1) {
      nested = metadataBox(nested);
    }
    const path = await writeSyntheticHeif('too-deep.heif', nested);
    await expectRejectedBeforeHeifInspection(path);
  });

  it('rejects files that exceed the BMFF box-count limit', async () => {
    const boxes = Array.from({ length: 1025 }, () => bmffBox('free'));
    const path = await writeSyntheticHeif('too-many-boxes.heif', ...boxes);
    await expectRejectedBeforeHeifInspection(path);
  });

  it('rejects a malformed mif1 ftyp box before HEIF inspection', async () => {
    const malformed = await readFile(heifPath);
    malformed.writeUInt32BE(18, 0);
    const malformedPath = join(temporaryDirectory, 'malformed-ftyp.heif');
    await writeFile(malformedPath, malformed);
    const inspectHeif = vi.fn().mockResolvedValue({ width: 64, height: 48 });

    await expect(inspectInput(malformedPath, {
      inspectHeif,
      parseExif: vi.fn().mockResolvedValue(undefined),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
    expect(inspectHeif).not.toHaveBeenCalled();
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
  it('reads DateTimeOriginal through the Node ESM default export used in production', async () => {
    const actualExifr = await vi.importActual<typeof import('exifr')>('exifr');
    vi.doMock('exifr', () => ({ default: actualExifr.default }));
    vi.resetModules();

    try {
      const productionModule = await import('./inspect-input.js');
      await expect(productionModule.inspectInput(exifJpegPath)).resolves.toMatchObject({
        takenDate: '2024-02-29',
      });
    } finally {
      vi.doUnmock('exifr');
      vi.resetModules();
    }
  });

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
