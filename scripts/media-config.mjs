import { fileURLToPath } from 'node:url'
import path from 'node:path'

const KB = 1024
const MB = 1024 * KB

export const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url))
export const SOURCE_MEDIA_DIR = path.join(ROOT_DIR, 'codebase', 'assets')
export const SOURCE_IMAGE_DIR = path.join(SOURCE_MEDIA_DIR, 'images')
export const OUTPUT_DIR = path.join(ROOT_DIR, 'src', 'assets', 'generated')

export const PHOTO_IDS = Object.freeze(['1', '2', '3', '4', '5'])
export const PHOTO_WIDTHS = Object.freeze([320, 640, 960])
export const PHOTO_FORMATS = Object.freeze(['avif', 'webp', 'jpg'])
export const PHOTO_QUALITY = Object.freeze({ avif: 62, webp: 78, jpg: 82 })

const photoBudgets = {
  avif: { 320: 120 * KB, 640: 240 * KB, 960: 400 * KB },
  webp: { 320: 160 * KB, 640: 320 * KB, 960: 550 * KB },
  jpg: { 320: 220 * KB, 640: 450 * KB, 960: 700 * KB },
}

export const PHOTO_OUTPUTS = Object.freeze(
  PHOTO_IDS.flatMap((id) =>
    PHOTO_WIDTHS.flatMap((width) =>
      PHOTO_FORMATS.map((format) => {
        const filename = `photo-${id}-${width}.${format}`
        return Object.freeze({
          id,
          width,
          height: width,
          format,
          filename,
          sourcePath: path.join(SOURCE_IMAGE_DIR, `${id}.jpg`),
          outputPath: path.join(OUTPUT_DIR, filename),
          maxBytes: photoBudgets[format][width],
        })
      }),
    ),
  ),
)

export const POSTER_OUTPUT = Object.freeze({
  filename: 'video-poster.jpg',
  sourcePath: path.join(SOURCE_IMAGE_DIR, '7777.jpg'),
  outputPath: path.join(OUTPUT_DIR, 'video-poster.jpg'),
  width: 1280,
  height: 720,
  format: 'jpeg',
  maxBytes: 400 * KB,
})

export const AUDIO_OUTPUTS = Object.freeze([
  Object.freeze({
    filename: 'lullaby.m4a',
    outputPath: path.join(OUTPUT_DIR, 'lullaby.m4a'),
    codec: 'aac',
    maxBytes: 1.6 * MB,
  }),
  Object.freeze({
    filename: 'lullaby.mp3',
    outputPath: path.join(OUTPUT_DIR, 'lullaby.mp3'),
    codec: 'mp3',
    maxBytes: 3.5 * MB,
  }),
])

export const VIDEO_OUTPUT = Object.freeze({
  filename: 'memory.mp4',
  outputPath: path.join(OUTPUT_DIR, 'memory.mp4'),
  codec: 'h264',
  maxBytes: 3.2 * MB,
})

export const SOURCE_AUDIO_PATH = path.join(SOURCE_MEDIA_DIR, '1.mp3')
export const SOURCE_VIDEO_PATH = path.join(SOURCE_MEDIA_DIR, '1.mp4')

export const ALL_OUTPUTS = Object.freeze([
  ...PHOTO_OUTPUTS,
  POSTER_OUTPUT,
  ...AUDIO_OUTPUTS,
  VIDEO_OUTPUT,
])
