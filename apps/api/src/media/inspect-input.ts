import { open } from 'node:fs/promises';

import exifr from 'exifr';
import { fileTypeFromFile, type FileTypeResult } from 'file-type';
import sharp from 'sharp';

import { inspectHeif, type HeifDimensions } from './heif-tools.js';

export const MAX_IMAGE_PIXELS = 60_000_000;
const MAX_FTYP_BOX_BYTES = 4096;
const MAX_HEIF_INSPECTION_BYTES = 10 * 1024 * 1024;
const MAX_BMFF_BOXES = 1024;
const MAX_BMFF_DEPTH = 8;

export type SupportedImageKind = 'heic' | 'heif' | 'jpeg' | 'png' | 'webp';
export type InputInspectionErrorCode =
  | 'IMAGE_PIXEL_LIMIT'
  | 'IMAGE_SEQUENCE_UNSUPPORTED'
  | 'INVALID_IMAGE_DIMENSIONS'
  | 'UNSUPPORTED_IMAGE';

export class InputInspectionError extends Error {
  readonly code: InputInspectionErrorCode;

  constructor(code: InputInspectionErrorCode, message: string) {
    super(message);
    this.name = 'InputInspectionError';
    this.code = code;
  }
}

export interface InputInspection {
  height: number;
  kind: SupportedImageKind;
  mime: string;
  takenDate: string | null;
  width: number;
}

interface ImageMetadata {
  height?: number;
  pages?: number;
  width?: number;
}

type ExifParser = (
  inputPath: string,
  options: {
    pick: ['DateTimeOriginal', 'CreateDate'];
    reviveValues: false;
    translateValues: false;
  },
) => Promise<unknown>;

export interface InspectInputDependencies {
  detectFileType?: (inputPath: string) => Promise<FileTypeResult | undefined>;
  inspectHeif?: (inputPath: string) => Promise<HeifDimensions>;
  parseExif?: ExifParser;
  readMetadata?: (inputPath: string) => Promise<ImageMetadata>;
}

interface SupportedType {
  kind: SupportedImageKind;
  mime: string;
}

const supportedTypes = new Map<string, SupportedType>([
  ['image/jpeg', { kind: 'jpeg', mime: 'image/jpeg' }],
  ['image/png', { kind: 'png', mime: 'image/png' }],
  ['image/webp', { kind: 'webp', mime: 'image/webp' }],
  ['image/heic', { kind: 'heic', mime: 'image/heic' }],
  ['image/heif', { kind: 'heif', mime: 'image/heif' }],
]);

const defaultReadMetadata = async (inputPath: string): Promise<ImageMetadata> => {
  const metadata = await sharp(inputPath).metadata();
  return { width: metadata.width, height: metadata.height, pages: metadata.pages };
};

const exifOptions: Parameters<ExifParser>[1] = {
  pick: ['DateTimeOriginal', 'CreateDate'],
  reviveValues: false,
  translateValues: false,
};

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseExifCalendarDate(rawValue: unknown): string | null {
  if (typeof rawValue !== 'string') {
    return null;
  }

  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(rawValue);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return null;
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
}

function validateDimensions(dimensions: ImageMetadata): HeifDimensions {
  const { width, height } = dimensions;
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || (width ?? 0) <= 0
    || (height ?? 0) <= 0
  ) {
    throw new InputInspectionError('INVALID_IMAGE_DIMENSIONS', '图片尺寸无效');
  }

  const safeWidth = width as number;
  const safeHeight = height as number;
  if (safeWidth > Math.floor(MAX_IMAGE_PIXELS / safeHeight)) {
    throw new InputInspectionError('IMAGE_PIXEL_LIMIT', '图片像素超过限制');
  }

  return { width: safeWidth, height: safeHeight };
}

function unsupportedHeifContainer(): InputInspectionError {
  return new InputInspectionError('UNSUPPORTED_IMAGE', 'HEIF 文件容器无效');
}

function readPrintableBrand(box: Buffer, offset: number): string {
  for (let index = offset; index < offset + 4; index += 1) {
    const byte = box[index];
    if (byte === undefined || byte < 0x20 || byte > 0x7e) {
      throw unsupportedHeifContainer();
    }
  }

  return box.toString('ascii', offset, offset + 4);
}

interface BmffBox {
  readonly end: number;
  readonly payloadStart: number;
  readonly start: number;
  readonly type: string;
}

interface BmffInspectionState {
  boxCount: number;
  hasHevcConfig: boolean;
  hasHevcItem: boolean;
  metadataBoxCount: number;
}

type BmffScope = 'nested' | 'root';

function assertBmffDepth(depth: number): void {
  if (depth > MAX_BMFF_DEPTH) {
    throw unsupportedHeifContainer();
  }
}

function parseBmffBox(
  buffer: Buffer,
  offset: number,
  parentEnd: number,
  state: BmffInspectionState,
  scope: BmffScope,
): BmffBox {
  if (offset < 0 || parentEnd > buffer.length || offset > parentEnd - 8) {
    throw unsupportedHeifContainer();
  }

  const size32 = buffer.readUInt32BE(offset);
  let size: number;
  let headerSize: number;
  if (size32 === 0) {
    if (scope !== 'root') {
      throw unsupportedHeifContainer();
    }
    size = parentEnd - offset;
    headerSize = 8;
  } else if (size32 === 1) {
    if (offset > parentEnd - 16) {
      throw unsupportedHeifContainer();
    }
    const size64 = buffer.readBigUInt64BE(offset + 8);
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw unsupportedHeifContainer();
    }
    size = Number(size64);
    headerSize = 16;
  } else {
    size = size32;
    headerSize = 8;
  }

  if (size === 0 || size < headerSize || size > parentEnd - offset) {
    throw unsupportedHeifContainer();
  }

  state.boxCount += 1;
  if (state.boxCount > MAX_BMFF_BOXES) {
    throw unsupportedHeifContainer();
  }

  return {
    start: offset,
    end: offset + size,
    payloadStart: offset + headerSize,
    type: readPrintableBrand(buffer, offset + 4),
  };
}

function walkBmffBoxes(
  buffer: Buffer,
  start: number,
  end: number,
  state: BmffInspectionState,
  scope: BmffScope,
  visit: (box: BmffBox) => void,
): void {
  let offset = start;
  while (offset < end) {
    const box = parseBmffBox(buffer, offset, end, state, scope);
    visit(box);
    offset = box.end;
  }

  if (offset !== end) {
    throw unsupportedHeifContainer();
  }
}

function inspectItemInfoEntry(
  buffer: Buffer,
  box: BmffBox,
  depth: number,
  state: BmffInspectionState,
): void {
  assertBmffDepth(depth);
  if (box.end - box.payloadStart < 4) {
    throw unsupportedHeifContainer();
  }

  const version = buffer[box.payloadStart];
  let itemTypeOffset: number;
  if (version === 2) {
    itemTypeOffset = box.payloadStart + 8;
  } else if (version === 3) {
    itemTypeOffset = box.payloadStart + 10;
  } else {
    throw unsupportedHeifContainer();
  }

  if (itemTypeOffset > box.end - 4) {
    throw unsupportedHeifContainer();
  }

  const itemType = readPrintableBrand(buffer, itemTypeOffset);
  if (itemType === 'av01') {
    throw new InputInspectionError('UNSUPPORTED_IMAGE', '不支持 AVIF 图片');
  }
  if (itemType === 'hvc1' || itemType === 'hev1') {
    state.hasHevcItem = true;
  }
}

function inspectItemInformation(
  buffer: Buffer,
  box: BmffBox,
  depth: number,
  state: BmffInspectionState,
): void {
  assertBmffDepth(depth);
  if (box.end - box.payloadStart < 6) {
    throw unsupportedHeifContainer();
  }

  const version = buffer[box.payloadStart];
  let entryCount: number;
  let entriesStart: number;
  if (version === 0) {
    entryCount = buffer.readUInt16BE(box.payloadStart + 4);
    entriesStart = box.payloadStart + 6;
  } else if (version === 1) {
    if (box.end - box.payloadStart < 8) {
      throw unsupportedHeifContainer();
    }
    entryCount = buffer.readUInt32BE(box.payloadStart + 4);
    entriesStart = box.payloadStart + 8;
  } else {
    throw unsupportedHeifContainer();
  }

  if (entryCount > MAX_BMFF_BOXES) {
    throw unsupportedHeifContainer();
  }

  let parsedEntries = 0;
  walkBmffBoxes(buffer, entriesStart, box.end, state, 'nested', (entry) => {
    if (entry.type !== 'infe') {
      throw unsupportedHeifContainer();
    }
    parsedEntries += 1;
    inspectItemInfoEntry(buffer, entry, depth + 1, state);
  });
  if (parsedEntries !== entryCount) {
    throw unsupportedHeifContainer();
  }
}

function inspectItemPropertyContainer(
  buffer: Buffer,
  box: BmffBox,
  depth: number,
  state: BmffInspectionState,
): void {
  assertBmffDepth(depth);
  walkBmffBoxes(buffer, box.payloadStart, box.end, state, 'nested', (property) => {
    if (property.type === 'av1C') {
      throw new InputInspectionError('UNSUPPORTED_IMAGE', '不支持 AVIF 图片');
    }
    if (property.type === 'hvcC') {
      state.hasHevcConfig = true;
    }
  });
}

function inspectItemProperties(
  buffer: Buffer,
  box: BmffBox,
  depth: number,
  state: BmffInspectionState,
): void {
  assertBmffDepth(depth);
  walkBmffBoxes(buffer, box.payloadStart, box.end, state, 'nested', (child) => {
    if (child.type === 'ipco') {
      inspectItemPropertyContainer(buffer, child, depth + 1, state);
    } else if (child.type === 'iprp') {
      inspectItemProperties(buffer, child, depth + 1, state);
    } else if (child.type === 'meta') {
      inspectMetadataBox(buffer, child, depth + 1, state);
    }
  });
}

function inspectMetadataBox(
  buffer: Buffer,
  box: BmffBox,
  depth: number,
  state: BmffInspectionState,
): void {
  assertBmffDepth(depth);
  if (box.end - box.payloadStart < 4) {
    throw unsupportedHeifContainer();
  }

  state.metadataBoxCount += 1;
  walkBmffBoxes(buffer, box.payloadStart + 4, box.end, state, 'nested', (child) => {
    if (child.type === 'iinf') {
      inspectItemInformation(buffer, child, depth + 1, state);
    } else if (child.type === 'iprp') {
      inspectItemProperties(buffer, child, depth + 1, state);
    } else if (child.type === 'meta') {
      inspectMetadataBox(buffer, child, depth + 1, state);
    }
  });
}

function validateFileTypeBox(
  buffer: Buffer,
  box: BmffBox,
  kind: 'heic' | 'heif',
): void {
  if (
    box.start !== 0
    || box.type !== 'ftyp'
    || box.end - box.start < 16
    || box.end - box.start > MAX_FTYP_BOX_BYTES
    || (box.end - box.start - 16) % 4 !== 0
  ) {
    throw unsupportedHeifContainer();
  }

  const majorBrand = readPrintableBrand(buffer, box.payloadStart);
  if (
    (kind === 'heic' && majorBrand !== 'heic' && majorBrand !== 'heix')
    || (kind === 'heif' && majorBrand !== 'mif1')
  ) {
    throw unsupportedHeifContainer();
  }

  const brands = [majorBrand];
  for (let offset = box.payloadStart + 8; offset < box.end; offset += 4) {
    brands.push(readPrintableBrand(buffer, offset));
  }
  if (brands.some((brand) => brand === 'avif' || brand === 'avis')) {
    throw new InputInspectionError('UNSUPPORTED_IMAGE', '不支持 AVIF 图片');
  }
}

async function readBoundedHeif(inputPath: string): Promise<Buffer> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(inputPath, 'r');
    const stats = await file.stat();
    if (!stats.isFile() || stats.size < 16 || stats.size > MAX_HEIF_INSPECTION_BYTES) {
      throw unsupportedHeifContainer();
    }

    const buffer = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await file.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead <= 0) {
        throw unsupportedHeifContainer();
      }
      offset += result.bytesRead;
    }

    return buffer;
  } catch (error) {
    if (error instanceof InputInspectionError) {
      throw error;
    }

    throw unsupportedHeifContainer();
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function validateHeifContainer(
  inputPath: string,
  kind: 'heic' | 'heif',
): Promise<void> {
  try {
    const buffer = await readBoundedHeif(inputPath);
    const state: BmffInspectionState = {
      boxCount: 0,
      hasHevcConfig: false,
      hasHevcItem: false,
      metadataBoxCount: 0,
    };
    let firstBox = true;
    walkBmffBoxes(buffer, 0, buffer.length, state, 'root', (box) => {
      if (firstBox) {
        validateFileTypeBox(buffer, box, kind);
        firstBox = false;
      } else if (box.type === 'meta') {
        inspectMetadataBox(buffer, box, 1, state);
      }
    });

    if (
      firstBox
      || state.metadataBoxCount === 0
      || !state.hasHevcItem
      || !state.hasHevcConfig
    ) {
      throw unsupportedHeifContainer();
    }
  } catch (error) {
    if (error instanceof InputInspectionError) {
      throw error;
    }

    throw unsupportedHeifContainer();
  }
}

async function readTakenDate(inputPath: string, parseExif: ExifParser): Promise<string | null> {
  try {
    const metadata = await parseExif(inputPath, exifOptions);
    if (typeof metadata !== 'object' || metadata === null) {
      return null;
    }

    const values = metadata as Record<string, unknown>;
    return parseExifCalendarDate(values.DateTimeOriginal)
      ?? parseExifCalendarDate(values.CreateDate);
  } catch {
    return null;
  }
}

export async function inspectInput(
  inputPath: string,
  dependencies: InspectInputDependencies = {},
): Promise<InputInspection> {
  const detectFileType = dependencies.detectFileType ?? fileTypeFromFile;
  let detected: FileTypeResult | undefined;
  try {
    detected = await detectFileType(inputPath);
  } catch {
    throw new InputInspectionError('UNSUPPORTED_IMAGE', '无法识别图片格式');
  }

  const supportedType = detected ? supportedTypes.get(detected.mime) : undefined;
  if (!supportedType) {
    throw new InputInspectionError('UNSUPPORTED_IMAGE', '不支持的图片格式');
  }

  let metadata: ImageMetadata;
  if (supportedType.kind === 'heic' || supportedType.kind === 'heif') {
    await validateHeifContainer(inputPath, supportedType.kind);
    metadata = await (dependencies.inspectHeif ?? inspectHeif)(inputPath);
  } else {
    try {
      metadata = await (dependencies.readMetadata ?? defaultReadMetadata)(inputPath);
    } catch {
      throw new InputInspectionError('UNSUPPORTED_IMAGE', '图片文件已损坏或无法读取');
    }

    if ((metadata.pages ?? 1) !== 1) {
      throw new InputInspectionError('IMAGE_SEQUENCE_UNSUPPORTED', '不支持多帧图片');
    }
  }

  const dimensions = validateDimensions(metadata);
  const takenDate = await readTakenDate(inputPath, dependencies.parseExif ?? exifr.parse);

  return {
    ...supportedType,
    ...dimensions,
    takenDate,
  };
}
