import { describe, expect, it } from 'vitest'
import { audioSources, memories, videoPosterUrl, videoUrl } from './memories'

describe('album data', () => {
  it('preserves the original memory order and transforms', () => {
    expect(memories.map(({ caption }) => caption)).toEqual([
      '刚出生的时候 🍼',
      '第一次笑得这么开心 😄',
      '满月啦 🎈',
      '睡觉的样子最乖 💤',
      '带去公园玩 🌳',
    ])
    expect(memories.map(({ transform }) => transform)).toEqual([
      { rotation: -5, x: 0, y: 10 },
      { rotation: 3, x: 10, y: -5 },
      { rotation: -2, x: -10, y: 0 },
      { rotation: 4, x: 5, y: 15 },
      { rotation: -4, x: 0, y: -10 },
    ])
  })

  it('provides unique ids, descriptive alt text, and responsive formats', () => {
    expect(new Set(memories.map(({ id }) => id))).toHaveLength(5)

    for (const memory of memories) {
      expect(memory.alt).not.toMatch(/^照片\d*$/)
      expect(memory.alt.length).toBeGreaterThan(8)

      for (const source of [
        memory.sources.avif,
        memory.sources.webp,
        memory.sources.jpeg,
      ]) {
        expect(source).toContain('320w')
        expect(source).toContain('640w')
        expect(source).toContain('960w')
      }
      expect(memory.sources.fallback).toContain('photo-')
    }
  })

  it('maps optimized video and audio delivery assets', () => {
    expect(videoPosterUrl).toContain('video-poster.jpg')
    expect(videoUrl).toContain('memory.mp4')
    expect(audioSources.aac).toContain('lullaby.m4a')
    expect(audioSources.mp3).toContain('lullaby.mp3')
  })
})
