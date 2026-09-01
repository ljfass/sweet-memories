// @vitest-environment node

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EXPECTED_SOURCE_ASSETS,
  buildLegacySeed,
  verifyLegacySeed,
} from './prepare-legacy-seed.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const sourceRoot = join(repositoryRoot, 'src/assets/generated');
const manifestPath = join(repositoryRoot, 'apps/api/seed/legacy-photos.json');
const scriptPath = join(repositoryRoot, 'scripts/api/prepare-legacy-seed.mjs');
const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}

function emptyOutput(prefix = 'sweet-memories-seed-output-'): string {
  return temporaryRoot(prefix);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('legacy seed builder', () => {
  it('locks all 45 source digests and creates deterministic media plus a manifest', async () => {
    expect(EXPECTED_SOURCE_ASSETS).toHaveLength(45);
    expect(EXPECTED_SOURCE_ASSETS[0]).toEqual(expect.objectContaining({
      relativePath: 'photo-1-320.avif',
      sha256: 'b5bd647bb267ee5416827bf243b2d82201ae1e48540986d5a887af7945dfd9ee',
      width: 320,
      height: 320,
    }));
    expect(EXPECTED_SOURCE_ASSETS.at(-1)).toEqual(expect.objectContaining({
      relativePath: 'photo-5-960.jpg',
      sha256: 'bcec36e950fa67608d5b229c551e07033a2dd0172d542cdb4b8e8346778d92d2',
      width: 960,
      height: 960,
    }));

    const outputRoot = emptyOutput();
    await buildLegacySeed({ repositoryRoot, sourceRoot, manifestPath, outputRoot });

    const manifest = JSON.parse(readFileSync(join(outputRoot, 'media-manifest.json'), 'utf8')) as {
      version: number;
      photos: Array<{ photoId: string; assets: Array<{ relativePath: string; size: number; sha256: string }> }>;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.photos).toHaveLength(5);
    expect(manifest.photos.flatMap((photo) => photo.assets)).toHaveLength(50);
    for (const photo of manifest.photos) {
      expect(readdirSync(join(outputRoot, 'media', photo.photoId)).sort()).toEqual([
        '320.avif', '320.jpg', '320.webp',
        '640.avif', '640.jpg', '640.webp',
        '960.avif', '960.jpg', '960.webp',
        'master.jpg',
      ]);
      for (const asset of photo.assets) {
        expect(asset.relativePath).toMatch(new RegExp(`^${photo.photoId}/`));
        expect(asset.size).toBeGreaterThan(0);
        expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(lstatSync(join(outputRoot, 'media', asset.relativePath)).isFile()).toBe(true);
      }
    }
    expect(readFileSync(
      join(outputRoot, 'media', manifest.photos[0]!.photoId, 'master.jpg'),
    )).toEqual(readFileSync(join(sourceRoot, 'photo-1-960.jpg')));
  });

  it.each([
    ['relative output', () => 'relative-output'],
    ['workspace output', () => join(repositoryRoot, '.seed-output')],
  ])('rejects an unsafe %s path before writing', async (_name, output) => {
    await expect(buildLegacySeed({
      repositoryRoot,
      sourceRoot,
      manifestPath,
      outputRoot: output(),
    })).rejects.toThrow();
  });

  it('requires an existing empty ordinary output directory', async () => {
    const root = temporaryRoot('sweet-memories-seed-parent-');
    const missing = join(root, 'missing');
    await expect(buildLegacySeed({ repositoryRoot, sourceRoot, manifestPath, outputRoot: missing }))
      .rejects.toThrow();
    expect(existsSync(missing)).toBe(false);

    const nonempty = join(root, 'nonempty');
    mkdirSync(nonempty);
    writeFileSync(join(nonempty, 'keep.txt'), 'keep');
    await expect(buildLegacySeed({ repositoryRoot, sourceRoot, manifestPath, outputRoot: nonempty }))
      .rejects.toThrow();
    expect(readFileSync(join(nonempty, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('rejects source symlinks and content drift without leaving partial output', async () => {
    const fakeRoot = temporaryRoot('sweet-memories-seed-fixture-');
    const fakeSources = join(fakeRoot, 'generated');
    mkdirSync(fakeSources);
    cpSync(sourceRoot, fakeSources, { recursive: true });
    const target = join(fakeSources, 'photo-1-320.jpg');
    rmSync(target);
    symlinkSync(join(sourceRoot, 'photo-1-320.jpg'), target);
    const symlinkOutput = emptyOutput();

    await expect(buildLegacySeed({
      repositoryRoot: fakeRoot,
      sourceRoot: fakeSources,
      manifestPath,
      outputRoot: symlinkOutput,
    })).rejects.toThrow();
    expect(readdirSync(symlinkOutput)).toEqual([]);

    rmSync(target);
    writeFileSync(target, 'not a jpeg');
    const driftOutput = emptyOutput();
    await expect(buildLegacySeed({
      repositoryRoot: fakeRoot,
      sourceRoot: fakeSources,
      manifestPath,
      outputRoot: driftOutput,
    })).rejects.toThrow();
    expect(readdirSync(driftOutput)).toEqual([]);
  });

  it('rejects metadata drift from the fixed five-photo contract', async () => {
    const changedManifest = join(temporaryRoot('sweet-memories-seed-manifest-'), 'legacy.json');
    const photos = JSON.parse(readFileSync(manifestPath, 'utf8')) as Array<Record<string, unknown>>;
    photos[1]!.title = '被意外修改的标题';
    writeFileSync(changedManifest, JSON.stringify(photos));
    const outputRoot = emptyOutput();

    await expect(buildLegacySeed({
      repositoryRoot,
      sourceRoot,
      manifestPath: changedManifest,
      outputRoot,
    })).rejects.toThrow();
    expect(readdirSync(outputRoot)).toEqual([]);
  });

  it('runs --check in system temporary storage and leaves the repository seed directory unchanged', () => {
    const before = readdirSync(join(repositoryRoot, 'apps/api/seed')).sort();
    const result = spawnSync(process.execPath, [scriptPath, '--check'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('旧照片 seed 校验通过');
    expect(result.stderr).toBe('');
    expect(readdirSync(join(repositoryRoot, 'apps/api/seed')).sort()).toEqual(before);
  });

  it('independently rereads generated files and rejects output drift', async () => {
    const outputRoot = emptyOutput();
    await buildLegacySeed({ repositoryRoot, sourceRoot, manifestPath, outputRoot });
    await expect(verifyLegacySeed({ outputRoot })).resolves.toEqual({
      photoCount: 5,
      assetCount: 50,
    });

    const manifest = JSON.parse(readFileSync(join(outputRoot, 'media-manifest.json'), 'utf8')) as {
      photos: Array<{ photoId: string }>;
    };
    writeFileSync(join(outputRoot, 'media', manifest.photos[0]!.photoId, '320.jpg'), 'drift');
    await expect(verifyLegacySeed({ outputRoot })).rejects.toThrow();
  });
});
