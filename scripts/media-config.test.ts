// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  AUDIO_OUTPUTS,
  PHOTO_FORMATS,
  PHOTO_IDS,
  PHOTO_OUTPUTS,
  PHOTO_WIDTHS,
  POSTER_OUTPUT,
  VIDEO_OUTPUT,
} from './media-config.mjs'

describe('media config', () => {
  it('defines every responsive photo variant', () => {
    expect(PHOTO_IDS).toEqual(['1', '2', '3', '4', '5'])
    expect(PHOTO_WIDTHS).toEqual([320, 640, 960])
    expect(PHOTO_FORMATS).toEqual(['avif', 'webp', 'jpg'])
    expect(PHOTO_OUTPUTS).toHaveLength(45)
  })

  it('defines the poster, deferred audio sources, and video output', () => {
    expect(POSTER_OUTPUT).toMatchObject({
      filename: 'video-poster.jpg',
      width: 1280,
      height: 720,
    })
    expect(AUDIO_OUTPUTS.map((output) => output.filename)).toEqual([
      'lullaby.m4a',
      'lullaby.mp3',
    ])
    expect(VIDEO_OUTPUT.filename).toBe('memory.mp4')
  })

  it('uses unique generated filenames', () => {
    const filenames = [
      ...PHOTO_OUTPUTS.map((output) => output.filename),
      POSTER_OUTPUT.filename,
      ...AUDIO_OUTPUTS.map((output) => output.filename),
      VIDEO_OUTPUT.filename,
    ]

    expect(new Set(filenames).size).toBe(filenames.length)
  })
})
