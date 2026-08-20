import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import ffprobeStatic from 'ffprobe-static'
import sharp from 'sharp'
import {
  ALL_OUTPUTS,
  AUDIO_OUTPUTS,
  PHOTO_OUTPUTS,
  POSTER_OUTPUT,
  VIDEO_OUTPUT,
} from './media-config.mjs'

function probe(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobeStatic.path,
      ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', filePath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe exited with ${code}`))
        return
      }
      resolve(JSON.parse(stdout))
    })
  })
}

const errors = []
let totalBytes = 0

for (const output of ALL_OUTPUTS) {
  if (!existsSync(output.outputPath)) {
    errors.push(`Missing: ${output.filename}`)
    continue
  }

  const file = await stat(output.outputPath)
  totalBytes += file.size
  if (file.size === 0) errors.push(`Empty: ${output.filename}`)
  if (file.size > output.maxBytes) {
    errors.push(`Oversize: ${output.filename} (${file.size} > ${output.maxBytes})`)
  }
}

for (const output of [...PHOTO_OUTPUTS, POSTER_OUTPUT]) {
  if (!existsSync(output.outputPath)) continue

  const metadata = await sharp(output.outputPath).metadata()
  const expectedFormat =
    output.format === 'jpg' ? 'jpeg' : output.format === 'avif' ? 'heif' : output.format
  if (metadata.width !== output.width || metadata.height !== output.height) {
    errors.push(
      `Dimensions: ${output.filename} (${metadata.width}x${metadata.height}, expected ${output.width}x${output.height})`,
    )
  }
  if (metadata.format !== expectedFormat) {
    errors.push(`Format: ${output.filename} (${metadata.format}, expected ${expectedFormat})`)
  }
}

for (const output of AUDIO_OUTPUTS) {
  if (!existsSync(output.outputPath)) continue

  try {
    const result = await probe(output.outputPath)
    const audioStream = result.streams?.find((stream) => stream.codec_type === 'audio')
    if (audioStream?.codec_name !== output.codec) {
      errors.push(`Codec: ${output.filename} (${audioStream?.codec_name ?? 'none'}, expected ${output.codec})`)
    }
  } catch (error) {
    errors.push(`Probe: ${output.filename} (${error.message})`)
  }
}

if (existsSync(VIDEO_OUTPUT.outputPath)) {
  try {
    const result = await probe(VIDEO_OUTPUT.outputPath)
    const videoStream = result.streams?.find((stream) => stream.codec_type === 'video')
    if (videoStream?.codec_name !== VIDEO_OUTPUT.codec) {
      errors.push(
        `Codec: ${VIDEO_OUTPUT.filename} (${videoStream?.codec_name ?? 'none'}, expected ${VIDEO_OUTPUT.codec})`,
      )
    }
  } catch (error) {
    errors.push(`Probe: ${VIDEO_OUTPUT.filename} (${error.message})`)
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error)
  process.exitCode = 1
} else {
  console.log(
    `Verified ${ALL_OUTPUTS.length} media files (${(totalBytes / 1024 / 1024).toFixed(2)} MiB).`,
  )
}
