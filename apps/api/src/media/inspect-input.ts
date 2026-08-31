import * as exifr from 'exifr';
import { fileTypeFromFile, type FileTypeResult } from 'file-type';
import sharp from 'sharp';

import { inspectHeif, type HeifDimensions } from './heif-tools.js';

export const MAX_IMAGE_PIXELS = 60_000_000;

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
