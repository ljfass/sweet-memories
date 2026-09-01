import { rm } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

import sharp, { type Sharp } from 'sharp';

import type { PhotoAssetFormat, PhotoAssetKind } from '../types.js';
import {
  convertHeif as convertHeifWithTool,
  type HeifToolOptions,
} from './heif-tools.js';
import { MAX_IMAGE_PIXELS, type SupportedImageKind } from './inspect-input.js';
import type { MediaTransaction } from './storage.js';

export const IMAGE_INPUT_OPTIONS = Object.freeze({
  limitInputPixels: MAX_IMAGE_PIXELS,
  sequentialRead: true,
});

export const RESPONSIVE_OUTPUTS = Object.freeze([
  Object.freeze({ format: 'avif' as const, quality: 62 }),
  Object.freeze({ format: 'webp' as const, quality: 78 }),
  Object.freeze({ format: 'jpeg' as const, quality: 82 }),
]);

const RESPONSIVE_WIDTHS = [320, 640, 960, 1600] as const;

export interface GeneratedMediaAsset {
  readonly kind: PhotoAssetKind;
  readonly format: PhotoAssetFormat;
  readonly width: number;
  readonly height: number;
  readonly relativePath: string;
}

export interface ProcessedPhotoManifest {
  readonly master: GeneratedMediaAsset;
  readonly assets: readonly GeneratedMediaAsset[];
}

type HeifConverter = (
  inputPath: string,
  outputPngPath: string,
  options?: HeifToolOptions,
) => Promise<void>;

export interface ProcessPhotoOptions {
  readonly inputPath: string;
  readonly inputKind: SupportedImageKind;
  readonly transaction: MediaTransaction;
  readonly heifConvertPath?: string;
  readonly convertHeif?: HeifConverter;
}

function outputPath(transaction: MediaTransaction, fileName: string): string {
  const path = resolve(transaction.stagingDir, fileName);
  const fromStaging = relative(transaction.stagingDir, path);
  if (
    fromStaging.length === 0
    || fromStaging === '..'
    || fromStaging.startsWith(`..${sep}`)
    || isAbsolute(fromStaging)
  ) {
    throw new Error('Unsafe generated media path');
  }
  return path;
}

function relativeMediaPath(transaction: MediaTransaction, fileName: string): string {
  return posix.join(transaction.photoId, fileName);
}

function assertDimensions(width: number | undefined, height: number | undefined): void {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || (width ?? 0) <= 0
    || (height ?? 0) <= 0
    || (width as number) > Math.floor(MAX_IMAGE_PIXELS / (height as number))
  ) {
    throw new Error('Invalid processed image dimensions');
  }
}

function responsiveWidths(sourceWidth: number): readonly number[] {
  return [...new Set(RESPONSIVE_WIDTHS.map((width) => Math.min(width, sourceWidth)))];
}

function formatPipeline(image: Sharp, format: PhotoAssetFormat, quality: number): Sharp {
  if (format === 'avif') {
    return image.avif({ quality });
  }
  if (format === 'webp') {
    return image.webp({ quality });
  }
  return image.jpeg({ quality });
}

function isInside(directory: string, path: string): boolean {
  const fromDirectory = relative(resolve(directory), resolve(path));
  return fromDirectory.length > 0
    && fromDirectory !== '..'
    && !fromDirectory.startsWith(`..${sep}`)
    && !isAbsolute(fromDirectory);
}

async function rollbackAfterFailure(transaction: MediaTransaction, cause: unknown): Promise<never> {
  try {
    await transaction.rollback();
  } catch (rollbackError) {
    throw new AggregateError(
      [cause, rollbackError],
      '图片处理与补偿清理均失败',
      { cause: rollbackError },
    );
  }
  throw cause;
}

export async function processPhoto(options: ProcessPhotoOptions): Promise<ProcessedPhotoManifest> {
  const {
    inputPath,
    inputKind,
    transaction,
    heifConvertPath,
    convertHeif = convertHeifWithTool,
  } = options;
  const convertedInputPath = outputPath(transaction, '.decoded-input.png');
  let processingInputPath = inputPath;

  try {
    if (inputKind === 'heic' || inputKind === 'heif') {
      if (heifConvertPath === undefined) {
        throw new Error('HEIF 转换工具路径未配置');
      }
      await convertHeif(inputPath, convertedInputPath, { executable: heifConvertPath });
      processingInputPath = convertedInputPath;
    }

    const image = sharp(processingInputPath, IMAGE_INPUT_OPTIONS).rotate();
    const metadata = await image.metadata();
    const sourceWidth = metadata.autoOrient.width;
    const sourceHeight = metadata.autoOrient.height;
    assertDimensions(sourceWidth, sourceHeight);

    const masterFileName = 'master.jpg';
    const masterResult = await image
      .clone()
      .jpeg({ quality: 82 })
      .toFile(outputPath(transaction, masterFileName));
    assertDimensions(masterResult.width, masterResult.height);
    const master: GeneratedMediaAsset = {
      kind: 'master',
      format: 'jpeg',
      width: masterResult.width,
      height: masterResult.height,
      relativePath: relativeMediaPath(transaction, masterFileName),
    };

    const assets: GeneratedMediaAsset[] = [];
    for (const width of responsiveWidths(sourceWidth)) {
      for (const output of RESPONSIVE_OUTPUTS) {
        const fileName = `${width}.${output.format}`;
        const result = await formatPipeline(
          image.clone().resize({ width, withoutEnlargement: true }),
          output.format,
          output.quality,
        ).toFile(outputPath(transaction, fileName));
        assertDimensions(result.width, result.height);
        assets.push({
          kind: 'responsive',
          format: output.format,
          width: result.width,
          height: result.height,
          relativePath: relativeMediaPath(transaction, fileName),
        });
      }
    }

    if (processingInputPath === convertedInputPath) {
      await rm(convertedInputPath, { force: true });
    }
    if (isInside(transaction.stagingDir, inputPath)) {
      await rm(inputPath, { force: true });
    }

    await transaction.commit();
    return { master, assets };
  } catch (error) {
    return rollbackAfterFailure(transaction, error);
  }
}
