// @vitest-environment node

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const globalCss = readFileSync(
  new URL('../src/styles/global.css', import.meta.url),
  'utf8',
)

describe('album visual fidelity styles', () => {
  it('stacks and centers the subtitle and age counter', () => {
    expect(globalCss).toMatch(
      /\.subtitle,\s*\.age-counter\s*{[^}]*display:\s*block;[^}]*width:\s*fit-content;[^}]*margin-inline:\s*auto;/s,
    )
  })

  it('uses the original recording indicator', () => {
    expect(globalCss).toContain('content: "REC 🔴";')
  })

  it('matches the original sleep control footprint and surfaces', () => {
    expect(globalCss).toMatch(
      /\.sleep-toggle\s*{[^}]*width:\s*55px;[^}]*height:\s*55px;[^}]*background:\s*rgb\(255 255 255 \/ 60%\);/s,
    )
    expect(globalCss).toMatch(
      /\.sleep-icon\s*{[^}]*font-size:\s*35px;[^}]*line-height:\s*1;/s,
    )
    expect(globalCss).toMatch(
      /\.is-sleeping \.sleep-toggle\s*{[^}]*background:\s*rgb\(30 41 59 \/ 80%\);/s,
    )
    expect(globalCss).toMatch(
      /@media \(max-width: 768px\)[\s\S]*?\.sleep-toggle\s*{[^}]*width:\s*45px;[^}]*height:\s*45px;[^}]*}[\s\S]*?\.sleep-icon\s*{[^}]*font-size:\s*28px;/s,
    )
  })

  it('anchors music notes and animates only transforms and opacity', () => {
    expect(globalCss).toMatch(
      /\.music-control\s*{[^}]*position:\s*fixed;[^}]*right:\s*30px;[^}]*bottom:\s*30px;/s,
    )
    expect(globalCss).toMatch(
      /\.music-note\s*{[^}]*pointer-events:\s*none;[^}]*will-change:\s*transform, opacity;[^}]*animation:\s*music-note-flow/s,
    )
    expect(globalCss).toMatch(
      /@keyframes music-note-flow\s*{[\s\S]*?transform:[^;]+;[\s\S]*?opacity:\s*0;/s,
    )
  })

  it('keeps make-way transforms on a responsive outer photo slot', () => {
    expect(globalCss).toMatch(
      /\.photo-slot\s*{[^}]*width:\s*280px;[^}]*flex:\s*0 0 280px;[^}]*transform-origin:\s*50% 50%;/s,
    )
    expect(globalCss).toMatch(
      /\.gallery\.has-selection \.photo-slot\s*{[^}]*will-change:\s*transform;/s,
    )
    expect(globalCss).toMatch(
      /\.polaroid-trigger:focus-visible\s*{[^}]*outline:\s*3px solid var\(--focus-color\);/s,
    )
    expect(globalCss).toMatch(
      /\.gallery:not\(\.has-selection\) \.polaroid:hover\s*{[^}]*scale\(1\.12\);/s,
    )
    expect(globalCss).toMatch(
      /@media \(max-width: 768px\)[\s\S]*?\.photo-slot\s*{[^}]*width:\s*min\(100%, 320px\);[^}]*flex-basis:\s*auto;/s,
    )
  })
})
