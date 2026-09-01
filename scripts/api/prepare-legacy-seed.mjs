#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const SOURCE_DIGESTS = Object.freeze({
  'photo-1-320.avif': 'b5bd647bb267ee5416827bf243b2d82201ae1e48540986d5a887af7945dfd9ee',
  'photo-1-320.webp': 'c4a23e5417162772e5e7e6bdf6a909db2c3ce52bb3c73c95e61f23497452ffdb',
  'photo-1-320.jpg': '4e950a5abd69233112ee8995e03b3cbcfe4583729b01b96e5eee68af778e6998',
  'photo-1-640.avif': '089db4887628bdea0b1a6dae3f0fd1ccccf2e92c3d9406113358542084fee068',
  'photo-1-640.webp': '9eeefa470dc75049e23a3c95d671fd6f1bf18321c8879d48ec1e1d4fd92a4289',
  'photo-1-640.jpg': 'cb48a31217afb83eaba2dda46a4dacc62dd52f21ca0211088aeb7c84b53cd171',
  'photo-1-960.avif': '0c65e50b5f6e2e1e1a95bd41570dc1bc78eca966a5892c82cf8b7050b36f0dbd',
  'photo-1-960.webp': 'cb363376f2204d11be5e48f6e70d449ae3d633bd0fa46fa630af16ec76b35a4a',
  'photo-1-960.jpg': '7db3872598765012eaa2f704945c6fec66c36eb644ebe8a76b39a32c7f5d9315',
  'photo-2-320.avif': '2ff2341f6bf1fb1afa4b90172c6f78df1c18482ec9181abe71926665ba2ff01a',
  'photo-2-320.webp': '4d783456f79cbaf925f3d7af503babf191ea34342769542d467afe8c2d2ebef7',
  'photo-2-320.jpg': '80aae75e48bc0dfcba3ac6bd1bb7e63c0a03f5bc4212dced5fb3a1cbe755361b',
  'photo-2-640.avif': '1fef226858fdfaa700bea320c472c00e3453e0a9d0c2dc8fc49fb43ad0f41845',
  'photo-2-640.webp': 'd2235424b48fe31c800bf0bed9d3f6ed55d3f2f7c1ecb7a1d7b8bff5899bd56a',
  'photo-2-640.jpg': '49aa21a7ba7a5d3973d82ab8fca1c5a9e7eff16525cf0b7b01ae5d11a6f7b022',
  'photo-2-960.avif': '8246797aad3246fd903bc105c36f64b1f3fc3478ed0f9e7dabacd4901db83877',
  'photo-2-960.webp': '831255a8de00f35de0dc667ac6c980dd93b01445987d792bb9d1b20bc7303db0',
  'photo-2-960.jpg': 'b0daa8cab6ea48ac5a684db9ab3dac6d8ac3bf0788a5f196d89b5aea1590cd72',
  'photo-3-320.avif': 'b698501fe5eaf5599b4e4164f3b150f060b3c7bb872ac855490705fc4ba814a6',
  'photo-3-320.webp': '558e986d67d39af2c009fde3dfc627b2b26afd433a8298807d8867a09a892c2d',
  'photo-3-320.jpg': '298f2c921bd130b37ca3ba1a9545e4ae8c3065d82033d5ff55db761f5fe20254',
  'photo-3-640.avif': 'b682f189f34a671ef418f178c49661143605a313206ebe48b0d82c848435d226',
  'photo-3-640.webp': '5c51be7f8607e9ebd1fa30818d98c7754d078960f991f6b3465a016c953e5a83',
  'photo-3-640.jpg': 'ecb54d448a39f30aca5849784bacba80e240ff31d12492cc1cdb3eb0a44bdd92',
  'photo-3-960.avif': 'b463a9ce7babad562a3bc858e984e033afa7a2fe2e86da53a0871024cbe69d11',
  'photo-3-960.webp': '2a0f2828e3934095b3a83ebe8ca43c2879a396768592af84fea61b74f500ff40',
  'photo-3-960.jpg': '30d8a5a416137beeca32a200a4eb4231825c2cecbdaf64d179ef9063f86da330',
  'photo-4-320.avif': '03bd8ad9922aa2d0063a592e5c30b9f4955714b9dc4ca227ccef5773470778d3',
  'photo-4-320.webp': '25764639b89293b9f53e43c7c3c7df99852e65e72ac7f2e2fd134a5dafbc01ea',
  'photo-4-320.jpg': '2a74fa7adf80da8543ac675cefb24330794a0e4753f0a25eb806becfe47f7b9c',
  'photo-4-640.avif': '3710ef1d7dd5370fc4e050ded9e4872183ff2fcd944a4bfec368f69b74d39786',
  'photo-4-640.webp': '7a60049dab740a91d5cdcc6d2a02c4cb042cb145509595440ebc13194f02a890',
  'photo-4-640.jpg': '49c89c0a2e0849464526e7ca6cb2818782ef29e768a71cd499dfaecfd12f3d3f',
  'photo-4-960.avif': 'd3d8be1b151fd1671df8f13c85a0696318736f8a00e4cdb1f2f4dd3443ad9be5',
  'photo-4-960.webp': '5b0b7b8bbab4401435341f6b6eb41b02dfbca724f82f885f3f851eb7db9fc048',
  'photo-4-960.jpg': '90cfdf0e5481981b70bf69583758d4f45bcedda6e0cec780f7a24ca024854772',
  'photo-5-320.avif': 'd5294b14910aafa89acad31a1504da928251666cc996b7658d1ee9e6246ebfe9',
  'photo-5-320.webp': 'c255eac3fbf4509f46da05150c39939cee2a327293758988ce949cf2d9332e46',
  'photo-5-320.jpg': '1a982427dae0d7464411b025e7b42adefc50f519ed7ba5bb6702b7407c844b69',
  'photo-5-640.avif': '3c9d0997732c4d2855640da9f29b8d1d3cdbf9b5b6cb4fcbf7bca1bde9228aaf',
  'photo-5-640.webp': '598fb328e4db2cb51543d61ac3f4d1751de0312327a2ff1ebbfa1d90a26eb3a1',
  'photo-5-640.jpg': 'ab8f8b7af61495734ec21bae83d0424600f84fd92c22d48ae14703d8dadb3772',
  'photo-5-960.avif': '1f90e9f5b08276a1e8f5a42b3b600ed099ee0af85c607fa4247e971e5bcb09f9',
  'photo-5-960.webp': 'a79c04fdaa01e55c10c2a357a475bb0979a4b06afa039d2e910a0ae1f620056a',
  'photo-5-960.jpg': 'bcec36e950fa67608d5b229c551e07033a2dd0172d542cdb4b8e8346778d92d2',
});

const WIDTHS = [320, 640, 960];
const EXTENSIONS = ['avif', 'webp', 'jpg'];
const LEGACY_IDS = ['1', '2', '3', '4', '5'];
const LEGACY_PHOTO_IDS = Object.freeze([
  '9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1',
  '58efb95e-2a98-45be-bbe4-acde6c34f7cd',
  'f83da4e8-d94e-4b8a-a725-36e2d1f931bf',
  'a15b8021-9842-4ed7-bd0f-9f98518a2d72',
  'c9608cd6-3480-43fb-84ab-623899262ff9',
]);
const EXPECTED_LEGACY_PHOTOS = Object.freeze([
  Object.freeze({
    legacyId: '1', photoId: LEGACY_PHOTO_IDS[0], title: '刚出生的时候 🍼',
    description: '刚出生的宝宝裹在粉色襁褓中安静熟睡', capturedDate: null,
    rotation: -5, x: 0, y: 10,
  }),
  Object.freeze({
    legacyId: '2', photoId: LEGACY_PHOTO_IDS[1], title: '第一次笑得这么开心 😄',
    description: '宝宝睁着眼睛躺在印花被褥中', capturedDate: null,
    rotation: 3, x: 10, y: -5,
  }),
  Object.freeze({
    legacyId: '3', photoId: LEGACY_PHOTO_IDS[2], title: '满月啦 🎈',
    description: '爸爸妈妈抱着宝宝在蛋糕前庆祝满月', capturedDate: null,
    rotation: -2, x: -10, y: 0,
  }),
  Object.freeze({
    legacyId: '4', photoId: LEGACY_PHOTO_IDS[3], title: '睡觉的样子最乖 💤',
    description: '宝宝躺在圆点枕头上安静熟睡', capturedDate: null,
    rotation: 4, x: 5, y: 15,
  }),
  Object.freeze({
    legacyId: '5', photoId: LEGACY_PHOTO_IDS[4], title: '带去公园玩 🌳',
    description: '宝宝坐在婴儿车里游览开满玫瑰的公园', capturedDate: null,
    rotation: -4, x: 0, y: -10,
  }),
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const EXPECTED_SOURCE_ASSETS = Object.freeze(
  LEGACY_IDS.flatMap((legacyId) => WIDTHS.flatMap((width) => EXTENSIONS.map((extension) => {
    const relativePath = `photo-${legacyId}-${width}.${extension}`;
    return Object.freeze({
      legacyId,
      relativePath,
      width,
      height: width,
      extension,
      sha256: SOURCE_DIGESTS[relativePath],
    });
  }))),
);

function isDescendant(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot.length > 0
    && fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot);
}

async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

async function readLegacyPhotos(path) {
  const information = await lstat(path);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error('旧照片清单不是普通文件');
  }
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length !== 5) {
    throw new Error('旧照片清单必须精确包含五条记录');
  }
  for (const [index, photo] of parsed.entries()) {
    if (
      !exactKeys(photo, [
        'legacyId', 'photoId', 'title', 'description', 'capturedDate', 'rotation', 'x', 'y',
      ])
      || photo.legacyId !== String(index + 1)
      || !UUID.test(photo.photoId)
      || typeof photo.title !== 'string'
      || photo.title.length === 0
      || typeof photo.description !== 'string'
      || photo.description.length === 0
      || photo.capturedDate !== null
      || !Number.isInteger(photo.rotation)
      || !Number.isInteger(photo.x)
      || !Number.isInteger(photo.y)
    ) {
      throw new Error('旧照片清单内容无效');
    }
  }
  if (JSON.stringify(parsed) !== JSON.stringify(EXPECTED_LEGACY_PHOTOS)) {
    throw new Error('旧照片清单与固定迁移合同不一致');
  }
  return parsed;
}

async function validateOutput(repositoryRoot, outputRoot) {
  if (!isAbsolute(outputRoot)) {
    throw new Error('输出目录必须是绝对路径');
  }
  const outputInformation = await lstat(outputRoot);
  if (!outputInformation.isDirectory() || outputInformation.isSymbolicLink()) {
    throw new Error('输出目录必须是普通目录');
  }
  const [realRepository, realOutput] = await Promise.all([
    realpath(repositoryRoot),
    realpath(outputRoot),
  ]);
  if (realRepository === realOutput || isDescendant(realRepository, realOutput)) {
    throw new Error('输出目录必须位于工作区外');
  }
  if ((await readdir(realOutput)).length !== 0) {
    throw new Error('输出目录必须为空');
  }
  return realOutput;
}

async function inspectSources(repositoryRoot, sourceRoot) {
  const sourceInformation = await lstat(sourceRoot);
  if (!sourceInformation.isDirectory() || sourceInformation.isSymbolicLink()) {
    throw new Error('源媒体目录无效');
  }
  const [realRepository, realSource] = await Promise.all([
    realpath(repositoryRoot),
    realpath(sourceRoot),
  ]);
  if (realRepository !== realSource && !isDescendant(realRepository, realSource)) {
    throw new Error('源媒体目录必须位于工作区内');
  }

  const inspected = [];
  for (const expected of EXPECTED_SOURCE_ASSETS) {
    if (typeof expected.sha256 !== 'string') {
      throw new Error('源媒体摘要合同不完整');
    }
    const path = join(realSource, expected.relativePath);
    const information = await lstat(path);
    const actualPath = await realpath(path);
    if (
      !information.isFile()
      || information.isSymbolicLink()
      || !isDescendant(realSource, actualPath)
    ) {
      throw new Error('源媒体必须是目录内的普通文件');
    }
    const [actualDigest, metadata] = await Promise.all([
      digest(path),
      sharp(path).metadata(),
    ]);
    const expectedFormat = expected.extension === 'jpg'
      ? 'jpeg'
      : expected.extension === 'avif' ? 'heif' : 'webp';
    if (
      actualDigest !== expected.sha256
      || metadata.format !== expectedFormat
      || metadata.width !== expected.width
      || metadata.height !== expected.height
    ) {
      throw new Error(`源媒体内容漂移: ${expected.relativePath}`);
    }
    inspected.push({ ...expected, path, size: information.size });
  }
  return inspected;
}

function outputAsset(photoId, source, fileName, kind) {
  return {
    kind,
    format: source.extension === 'jpg' ? 'jpeg' : source.extension,
    width: source.width,
    height: source.height,
    relativePath: `${photoId}/${fileName}`,
    size: source.size,
    sha256: source.sha256,
  };
}

function parseGeneratedAsset(value, expected, photoId) {
  if (
    !exactKeys(value, [
      'kind', 'format', 'width', 'height', 'relativePath', 'size', 'sha256',
    ])
    || value.kind !== expected.kind
    || value.format !== expected.format
    || value.width !== expected.width
    || value.height !== expected.height
    || value.relativePath !== `${photoId}/${expected.fileName}`
    || !Number.isSafeInteger(value.size)
    || value.size <= 0
    || value.sha256 !== expected.sha256
  ) {
    throw new Error('生成媒体清单资源无效');
  }
  return value;
}

function expectedGeneratedAssets(legacyId) {
  const sources = EXPECTED_SOURCE_ASSETS.filter((source) => source.legacyId === legacyId);
  const master = sources.find((source) => source.width === 960 && source.extension === 'jpg');
  if (master === undefined) throw new Error('生成媒体主图合同缺失');
  return [
    {
      kind: 'master',
      format: 'jpeg',
      width: 960,
      height: 960,
      fileName: 'master.jpg',
      sha256: master.sha256,
    },
    ...sources.map((source) => ({
      kind: 'responsive',
      format: source.extension === 'jpg' ? 'jpeg' : source.extension,
      width: source.width,
      height: source.height,
      fileName: `${source.width}.${source.extension}`,
      sha256: source.sha256,
    })),
  ];
}

export async function verifyLegacySeed({ outputRoot }) {
  if (!isAbsolute(outputRoot)) throw new Error('校验目录必须是绝对路径');
  const outputInformation = await lstat(outputRoot);
  if (!outputInformation.isDirectory() || outputInformation.isSymbolicLink()) {
    throw new Error('校验目录必须是普通目录');
  }
  const realOutput = await realpath(outputRoot);
  const rootEntries = (await readdir(realOutput)).sort();
  if (rootEntries.join('\0') !== ['media', 'media-manifest.json'].sort().join('\0')) {
    throw new Error('生成 seed 根目录内容无效');
  }
  const manifestPath = join(realOutput, 'media-manifest.json');
  const manifestInformation = await lstat(manifestPath);
  if (!manifestInformation.isFile() || manifestInformation.isSymbolicLink()) {
    throw new Error('生成媒体清单不是普通文件');
  }
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!exactKeys(parsed, ['version', 'photos']) || parsed.version !== 1 || !Array.isArray(parsed.photos)) {
    throw new Error('生成媒体清单格式无效');
  }
  if (parsed.photos.length !== 5) throw new Error('生成媒体清单照片数量无效');

  const mediaRoot = join(realOutput, 'media');
  const mediaInformation = await lstat(mediaRoot);
  if (!mediaInformation.isDirectory() || mediaInformation.isSymbolicLink()) {
    throw new Error('生成媒体目录无效');
  }
  const realMediaRoot = await realpath(mediaRoot);
  if (!isDescendant(realOutput, realMediaRoot)) throw new Error('生成媒体目录越界');
  if ((await readdir(realMediaRoot)).sort().join('\0') !== [...LEGACY_PHOTO_IDS].sort().join('\0')) {
    throw new Error('生成媒体照片目录集合无效');
  }

  let assetCount = 0;
  for (const [index, value] of parsed.photos.entries()) {
    const legacyId = LEGACY_IDS[index];
    const photoId = LEGACY_PHOTO_IDS[index];
    if (
      legacyId === undefined
      || photoId === undefined
      || !exactKeys(value, ['legacyId', 'photoId', 'assets'])
      || value.legacyId !== legacyId
      || value.photoId !== photoId
      || !Array.isArray(value.assets)
    ) {
      throw new Error('生成媒体照片身份无效');
    }
    const expectedAssets = expectedGeneratedAssets(legacyId);
    if (value.assets.length !== expectedAssets.length) throw new Error('生成媒体资源数量无效');
    const assets = value.assets.map((asset, assetIndex) =>
      parseGeneratedAsset(asset, expectedAssets[assetIndex], photoId));
    const photoRoot = join(realMediaRoot, photoId);
    const photoInformation = await lstat(photoRoot);
    const realPhotoRoot = await realpath(photoRoot);
    if (
      !photoInformation.isDirectory()
      || photoInformation.isSymbolicLink()
      || !isDescendant(realMediaRoot, realPhotoRoot)
      || (await readdir(realPhotoRoot)).sort().join('\0')
        !== expectedAssets.map((asset) => asset.fileName).sort().join('\0')
    ) {
      throw new Error('生成媒体照片目录无效');
    }
    for (const asset of assets) {
      const fileName = asset.relativePath.split('/')[1];
      const path = join(realPhotoRoot, fileName);
      const information = await lstat(path);
      const actualPath = await realpath(path);
      if (
        !information.isFile()
        || information.isSymbolicLink()
        || !isDescendant(realPhotoRoot, actualPath)
      ) {
        throw new Error('生成媒体资源不是普通文件');
      }
      const contents = await readFile(path);
      if (contents.byteLength !== asset.size || fileDigest(contents) !== asset.sha256) {
        throw new Error('生成媒体资源摘要不一致');
      }
      assetCount += 1;
    }
  }
  return { photoCount: 5, assetCount };
}

function fileDigest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export async function buildLegacySeed({ repositoryRoot, sourceRoot, manifestPath, outputRoot }) {
  const realOutput = await validateOutput(repositoryRoot, outputRoot);
  const [photos, sources] = await Promise.all([
    readLegacyPhotos(manifestPath),
    inspectSources(repositoryRoot, sourceRoot),
  ]);
  const mediaRoot = join(realOutput, 'media');
  const mediaManifestPath = join(realOutput, 'media-manifest.json');

  try {
    await mkdir(mediaRoot, { mode: 0o750 });
    const manifestPhotos = [];
    for (const photo of photos) {
      const photoRoot = join(mediaRoot, photo.photoId);
      await mkdir(photoRoot, { mode: 0o750 });
      const photoSources = sources.filter((source) => source.legacyId === photo.legacyId);
      const assets = [];
      for (const source of photoSources) {
        const fileName = `${source.width}.${source.extension}`;
        const target = join(photoRoot, fileName);
        await copyFile(source.path, target, constants.COPYFILE_EXCL);
        await chmod(target, 0o640);
        assets.push(outputAsset(photo.photoId, source, fileName, 'responsive'));
      }
      const masterSource = photoSources.find(
        (source) => source.width === 960 && source.extension === 'jpg',
      );
      if (masterSource === undefined) throw new Error('旧照片主图源不存在');
      await copyFile(masterSource.path, join(photoRoot, 'master.jpg'), constants.COPYFILE_EXCL);
      await chmod(join(photoRoot, 'master.jpg'), 0o640);
      assets.unshift(outputAsset(photo.photoId, masterSource, 'master.jpg', 'master'));
      manifestPhotos.push({ legacyId: photo.legacyId, photoId: photo.photoId, assets });
    }
    await writeFile(
      mediaManifestPath,
      `${JSON.stringify({ version: 1, photos: manifestPhotos }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o640 },
    );
    await verifyLegacySeed({ outputRoot: realOutput });
  } catch (error) {
    await Promise.allSettled([
      rm(mediaRoot, { recursive: true, force: true }),
      rm(mediaManifestPath, { force: true }),
    ]);
    throw error;
  }
}

function defaultPaths() {
  const repositoryRoot = resolve(import.meta.dirname, '../..');
  return {
    repositoryRoot,
    sourceRoot: join(repositoryRoot, 'src/assets/generated'),
    manifestPath: join(repositoryRoot, 'apps/api/seed/legacy-photos.json'),
  };
}

async function run(argv) {
  const defaults = defaultPaths();
  if (argv.length === 1 && argv[0] === '--check') {
    const temporaryOutput = await mkdtemp(join(tmpdir(), 'sweet-memories-legacy-seed-'));
    try {
      await buildLegacySeed({ ...defaults, outputRoot: temporaryOutput });
      await verifyLegacySeed({ outputRoot: temporaryOutput });
      process.stdout.write('旧照片 seed 校验通过\n');
      return 0;
    } finally {
      await rm(temporaryOutput, { recursive: true, force: true });
    }
  }
  if (argv.length === 2 && argv[0] === '--output') {
    await buildLegacySeed({ ...defaults, outputRoot: argv[1] });
    process.stdout.write('旧照片 seed 已生成\n');
    return 0;
  }
  process.stderr.write('用法: prepare-legacy-seed.mjs --check | --output <绝对空目录>\n');
  return 1;
}

async function isDirectExecution() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return await realpath(fileURLToPath(import.meta.url)) === await realpath(resolve(entry));
  } catch {
    return false;
  }
}

if (await isDirectExecution()) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch {
    process.stderr.write('旧照片 seed 构建失败\n');
    process.exitCode = 1;
  }
}
