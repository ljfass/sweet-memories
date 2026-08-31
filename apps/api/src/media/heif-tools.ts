import { execFile } from 'node:child_process';

export const HEIF_TOOL_TIMEOUT_MS = 30_000;
export const HEIF_MAX_BUFFER_BYTES = 1024 * 1024;

export type HeifToolErrorCode =
  | 'HEIF_INVALID_OUTPUT'
  | 'HEIF_SEQUENCE_UNSUPPORTED'
  | 'HEIF_TOOL_FAILED'
  | 'HEIF_TOOL_OUTPUT_LIMIT'
  | 'HEIF_TOOL_TIMEOUT'
  | 'HEIF_TOOL_UNAVAILABLE';

export class HeifToolError extends Error {
  readonly code: HeifToolErrorCode;

  constructor(code: HeifToolErrorCode, message: string) {
    super(message);
    this.name = 'HeifToolError';
    this.code = code;
  }
}

export interface HeifCommandOptions {
  encoding: 'utf8';
  maxBuffer: number;
  shell: false;
  timeout: number;
}

export interface HeifCommandResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
}

export type HeifCommandRunner = (
  executable: string,
  arguments_: string[],
  options: HeifCommandOptions,
) => Promise<HeifCommandResult>;

export interface HeifToolOptions {
  readonly executable?: string;
  readonly runner?: HeifCommandRunner;
}

export interface HeifDimensions {
  width: number;
  height: number;
}

const commandOptions: HeifCommandOptions = {
  encoding: 'utf8',
  maxBuffer: HEIF_MAX_BUFFER_BYTES,
  shell: false,
  timeout: HEIF_TOOL_TIMEOUT_MS,
};

const runExecFile: HeifCommandRunner = (executable, arguments_, options) =>
  new Promise((resolve, reject) => {
    execFile(executable, arguments_, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });

function mapCommandFailure(error: unknown): HeifToolError {
  const failure = typeof error === 'object' && error !== null
    ? error as { code?: unknown; killed?: unknown; signal?: unknown }
    : {};

  if (failure.code === 'ENOENT') {
    return new HeifToolError('HEIF_TOOL_UNAVAILABLE', 'HEIF 处理工具不可用');
  }

  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new HeifToolError('HEIF_TOOL_OUTPUT_LIMIT', 'HEIF 处理工具输出超过限制');
  }

  if (
    failure.code === 'ETIMEDOUT'
    || failure.killed === true
    || failure.signal === 'SIGTERM'
  ) {
    return new HeifToolError('HEIF_TOOL_TIMEOUT', 'HEIF 处理超时');
  }

  return new HeifToolError('HEIF_TOOL_FAILED', 'HEIF 处理失败');
}

function outputText(output: string | Buffer): string {
  return typeof output === 'string' ? output : output.toString('utf8');
}

function resolveExecutable(executable: string | undefined, defaultExecutable: string): string {
  const resolved = executable ?? defaultExecutable;
  if (typeof resolved !== 'string' || resolved.trim().length === 0) {
    throw new HeifToolError('HEIF_TOOL_UNAVAILABLE', 'HEIF 处理工具不可用');
  }

  return resolved;
}

function parseDimensions(stdout: string): HeifDimensions {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim());
  const declaresSequence = lines.some((line) => (
    /^MIME type:\s*image\/(?:heic|heif)-sequence\s*$/iu.test(line)
    || /^(?:is\s+)?(?:image\s+)?sequence\s*:\s*(?:yes|true|[1-9]\d*)\s*$/iu.test(line)
  ));
  const declaresMultipleImages = lines.some((line) => {
    const count = /^number of images\s*:\s*(\d+)\s*$/iu.exec(line);
    return count !== null && Number(count[1]) > 1;
  });
  if (declaresSequence || declaresMultipleImages) {
    throw new HeifToolError('HEIF_SEQUENCE_UNSUPPORTED', '不支持 HEIF 图像序列');
  }

  const imageLines = lines.filter((line) => /^image\s*:/iu.test(line));
  if (imageLines.length > 1) {
    throw new HeifToolError('HEIF_SEQUENCE_UNSUPPORTED', '不支持 HEIF 图像序列');
  }

  const imageLine = imageLines[0];
  if (!imageLine || !/\bprimary\b/iu.test(imageLine)) {
    throw new HeifToolError('HEIF_INVALID_OUTPUT', '无法读取 HEIF 主图信息');
  }

  const dimensions = [...imageLine.matchAll(/([+-]?\d+(?:\.\d+)?)\s*x\s*([+-]?\d+(?:\.\d+)?)/giu)];
  if (dimensions.length !== 1) {
    throw new HeifToolError('HEIF_INVALID_OUTPUT', '无法读取 HEIF 主图尺寸');
  }

  const width = Number(dimensions[0]?.[1]);
  const height = Number(dimensions[0]?.[2]);
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
  ) {
    throw new HeifToolError('HEIF_INVALID_OUTPUT', 'HEIF 主图尺寸无效');
  }

  return { width, height };
}

export async function inspectHeif(
  inputPath: string,
  options: HeifToolOptions = {},
): Promise<HeifDimensions> {
  const executable = resolveExecutable(options.executable, 'heif-info');
  const runner = options.runner ?? runExecFile;
  try {
    const result = await runner(executable, [inputPath], commandOptions);
    return parseDimensions(outputText(result.stdout));
  } catch (error) {
    if (error instanceof HeifToolError) {
      throw error;
    }

    throw mapCommandFailure(error);
  }
}

export async function convertHeif(
  inputPath: string,
  outputPngPath: string,
  options: HeifToolOptions = {},
): Promise<void> {
  const executable = resolveExecutable(options.executable, 'heif-convert');
  const runner = options.runner ?? runExecFile;
  try {
    await runner(executable, [inputPath, outputPngPath], commandOptions);
  } catch (error) {
    throw mapCommandFailure(error);
  }
}
