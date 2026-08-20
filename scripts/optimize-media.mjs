import { spawn } from 'node:child_process'
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import sharp from 'sharp'
import {
  AUDIO_OUTPUTS,
  OUTPUT_DIR,
  PHOTO_IDS,
  PHOTO_OUTPUTS,
  PHOTO_QUALITY,
  POSTER_OUTPUT,
  ROOT_DIR,
  SOURCE_AUDIO_PATH,
  SOURCE_VIDEO_PATH,
  VIDEO_OUTPUT,
} from './media-config.mjs'

function run(executable, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: ROOT_DIR,
      stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${path.basename(executable)} exited with ${code}`))
        return
      }
      resolve(stdout)
    })
  })
}

async function renderPhoto(output) {
  const image = sharp(output.sourcePath)
    .rotate()
    .resize(output.width, output.height, { fit: 'cover', position: 'centre' })

  if (output.format === 'avif') {
    await image.avif({ quality: PHOTO_QUALITY.avif, effort: 5 }).toFile(output.outputPath)
    return
  }
  if (output.format === 'webp') {
    await image.webp({ quality: PHOTO_QUALITY.webp, effort: 5 }).toFile(output.outputPath)
    return
  }
  await image.jpeg({ quality: PHOTO_QUALITY.jpg, mozjpeg: true }).toFile(output.outputPath)
}

async function renderPhotos() {
  for (const id of PHOTO_IDS) {
    await Promise.all(PHOTO_OUTPUTS.filter((output) => output.id === id).map(renderPhoto))
  }
}

async function renderPoster() {
  await sharp(POSTER_OUTPUT.sourcePath)
    .rotate()
    .resize(POSTER_OUTPUT.width, POSTER_OUTPUT.height, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .jpeg({ quality: 78, mozjpeg: true })
    .toFile(POSTER_OUTPUT.outputPath)
}

async function renderAudio() {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary path')

  await run(ffmpegPath, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    SOURCE_AUDIO_PATH,
    '-map_metadata',
    '-1',
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    AUDIO_OUTPUTS[0].outputPath,
  ])
  await copyFile(SOURCE_AUDIO_PATH, AUDIO_OUTPUTS[1].outputPath)
}

async function sourceVideoCodec() {
  const result = await run(
    ffprobeStatic.path,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      SOURCE_VIDEO_PATH,
    ],
    { capture: true },
  )
  return result.trim()
}

async function renderVideo() {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary path')

  const candidatePath = path.join(OUTPUT_DIR, '.memory-h264-candidate.mp4')
  const remuxPath = path.join(OUTPUT_DIR, '.memory-faststart-remux.mp4')
  const scaleFilter =
    "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"

  await run(ffmpegPath, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    SOURCE_VIDEO_PATH,
    '-map_metadata',
    '-1',
    '-vf',
    scaleFilter,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
    candidatePath,
  ])

  if ((await sourceVideoCodec()) !== 'h264') {
    await rename(candidatePath, VIDEO_OUTPUT.outputPath)
    return
  }

  await run(ffmpegPath, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    SOURCE_VIDEO_PATH,
    '-map_metadata',
    '-1',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    remuxPath,
  ])

  const [candidate, remux] = await Promise.all([stat(candidatePath), stat(remuxPath)])
  const selectedPath = candidate.size < remux.size ? candidatePath : remuxPath
  const discardedPath = selectedPath === candidatePath ? remuxPath : candidatePath
  await rename(selectedPath, VIDEO_OUTPUT.outputPath)
  await unlink(discardedPath)
}

await mkdir(OUTPUT_DIR, { recursive: true })
await renderPhotos()
await renderPoster()
await renderAudio()
await renderVideo()
await run(process.execPath, [path.join(ROOT_DIR, 'scripts', 'verify-media.mjs')])

console.log('Generated and verified optimized media.')
