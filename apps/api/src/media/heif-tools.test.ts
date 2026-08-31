import { describe, expect, it, vi } from 'vitest';

import {
  HEIF_MAX_BUFFER_BYTES,
  HEIF_TOOL_TIMEOUT_MS,
  HeifToolError,
  convertHeif,
  inspectHeif,
  type HeifCommandRunner,
} from './heif-tools.js';

function successfulRunner(stdout = ''): HeifCommandRunner {
  return vi.fn().mockResolvedValue({ stdout, stderr: '' });
}

describe('inspectHeif', () => {
  it('invokes heif-info without a shell and returns the unique primary image dimensions', async () => {
    const runner = successfulRunner([
      'MIME type: image/heic',
      'image: 4032x3024 (id=1), primary',
      '  color profile: no',
    ].join('\n'));

    await expect(inspectHeif('/staging/photo;touch-pwned.heic', runner)).resolves.toEqual({
      width: 4032,
      height: 3024,
    });
    expect(runner).toHaveBeenCalledWith(
      'heif-info',
      ['/staging/photo;touch-pwned.heic'],
      {
        encoding: 'utf8',
        maxBuffer: HEIF_MAX_BUFFER_BYTES,
        shell: false,
        timeout: HEIF_TOOL_TIMEOUT_MS,
      },
    );
  });

  it.each([
    ['a sequence', 'MIME type: image/heic-sequence\nimage: 10x10 (id=1), primary'],
    ['a declared sequence', 'sequence: yes\nimage: 10x10 (id=1), primary'],
    ['a declared image count above one', 'number of images: 2\nimage: 10x10 (id=1), primary'],
    ['multiple images', 'image: 10x10 (id=1), primary\nimage: 10x10 (id=2)'],
    ['multiple primary images', 'image: 10x10 (id=1), primary\nimage: 10x10 (id=2), primary'],
  ])('rejects %s', async (_label, stdout) => {
    await expect(inspectHeif('/staging/photo.heic', successfulRunner(stdout))).rejects.toMatchObject({
      code: 'HEIF_SEQUENCE_UNSUPPORTED',
    });
  });

  it.each([
    ['missing dimensions', 'MIME type: image/heic\nimage: primary'],
    ['no primary image', 'image: 10x10 (id=1)'],
    ['ambiguous dimensions', 'image: 10x10 20x20 (id=1), primary'],
    ['zero width', 'image: 0x10 (id=1), primary'],
    ['negative width', 'image: -1x10 (id=1), primary'],
    ['unsafe width', 'image: 9007199254740992x1 (id=1), primary'],
  ])('rejects malformed output: %s', async (_label, stdout) => {
    await expect(inspectHeif('/staging/photo.heic', successfulRunner(stdout))).rejects.toMatchObject({
      code: 'HEIF_INVALID_OUTPUT',
    });
  });

  it.each([
    ['missing tool', Object.assign(new Error('spawn /secret/path ENOENT'), { code: 'ENOENT' }), 'HEIF_TOOL_UNAVAILABLE'],
    ['timeout', Object.assign(new Error('stdout leaked'), { killed: true, signal: 'SIGTERM' }), 'HEIF_TOOL_TIMEOUT'],
    ['buffer overflow', Object.assign(new Error('stdout maxBuffer exceeded /secret/path'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'HEIF_TOOL_OUTPUT_LIMIT'],
    ['non-zero exit', Object.assign(new Error('stderr leaked /secret/path'), { code: 2, stderr: 'private stderr' }), 'HEIF_TOOL_FAILED'],
  ])('maps %s to a stable typed error without leaking command output', async (_label, failure, code) => {
    const runner: HeifCommandRunner = vi.fn().mockRejectedValue(failure);

    const result = inspectHeif('/secret/path/photo.heic', runner);
    await expect(result).rejects.toMatchObject({ code });
    await expect(result).rejects.not.toThrow(/secret|stdout|stderr|photo\.heic/iu);
  });
});

describe('convertHeif', () => {
  it('passes input and output as argument-array entries with bounded execution', async () => {
    const runner = successfulRunner();

    await expect(
      convertHeif('/staging/input;rm.heic', '/staging/output file.png', runner),
    ).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledWith(
      'heif-convert',
      ['/staging/input;rm.heic', '/staging/output file.png'],
      {
        encoding: 'utf8',
        maxBuffer: HEIF_MAX_BUFFER_BYTES,
        shell: false,
        timeout: HEIF_TOOL_TIMEOUT_MS,
      },
    );
  });

  it('maps conversion failures to typed errors without leaking paths or output', async () => {
    const runner: HeifCommandRunner = vi.fn().mockRejectedValue(
      Object.assign(new Error('private stdout /staging/input.heic'), { code: 1 }),
    );

    const result = convertHeif('/staging/input.heic', '/staging/output.png', runner);
    await expect(result).rejects.toBeInstanceOf(HeifToolError);
    await expect(result).rejects.toMatchObject({ code: 'HEIF_TOOL_FAILED' });
    await expect(result).rejects.not.toThrow(/private|staging|input|output/iu);
  });
});
