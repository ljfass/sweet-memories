import { describe, expect, it } from 'vitest'
import {
  calculateMakeWayTransforms,
  type MakeWayBounds,
  type MakeWayRect,
} from './calculateMakeWayTransforms'

const wideBounds: MakeWayBounds = {
  left: -240,
  top: -240,
  right: 1240,
  bottom: 1240,
}

describe('calculateMakeWayTransforms', () => {
  it('enlarges the selected desktop card and pushes neighbors radially outward', () => {
    const items: MakeWayRect[] = [
      { id: 'left', left: 20, top: 100, width: 280, height: 360 },
      { id: 'selected', left: 340, top: 100, width: 280, height: 360 },
      { id: 'right', left: 660, top: 100, width: 280, height: 360 },
    ]

    const result = calculateMakeWayTransforms({
      items,
      selectedId: 'selected',
      mode: 'desktop',
      bounds: wideBounds,
      selectedScale: 1.7,
    })

    expect(result.selected).toMatchObject({
      scale: 1.7,
      rotation: 0,
      zIndex: 20,
    })
    expect(result.left?.x).toBeLessThan(0)
    expect(result.right?.x).toBeGreaterThan(0)
    expect(Math.abs(result.left?.x ?? 0)).toBeLessThanOrEqual(160)
    expect(Math.abs(result.right?.x ?? 0)).toBeLessThanOrEqual(160)
    expect(Math.abs(result.left?.rotation ?? 0)).toBeLessThanOrEqual(6)
    expect(Math.abs(result.right?.rotation ?? 0)).toBeLessThanOrEqual(6)
  })

  it('corrects an enlarged edge card back inside the safe bounds', () => {
    const result = calculateMakeWayTransforms({
      items: [
        { id: 'edge', left: 0, top: 100, width: 280, height: 360 },
        { id: 'neighbor', left: 320, top: 100, width: 280, height: 360 },
      ],
      selectedId: 'edge',
      mode: 'desktop',
      bounds: { left: 0, top: 0, right: 920, bottom: 720 },
      selectedScale: 1.7,
    })

    expect(result.edge?.x).toBeCloseTo(98)
    expect(result.edge?.y).toBeCloseTo(26)
  })

  it('uses vertical-only displacement on mobile', () => {
    const items: MakeWayRect[] = [
      { id: 'above', left: 20, top: 20, width: 280, height: 360 },
      { id: 'selected', left: 20, top: 420, width: 280, height: 360 },
      { id: 'below', left: 20, top: 820, width: 280, height: 360 },
    ]

    const result = calculateMakeWayTransforms({
      items,
      selectedId: 'selected',
      mode: 'mobile',
      bounds: wideBounds,
      selectedScale: 1.08,
    })

    expect(result.selected?.scale).toBe(1.08)
    expect(result.above).toMatchObject({ x: 0, rotation: 0 })
    expect(result.below).toMatchObject({ x: 0, rotation: 0 })
    expect(result.above?.y).toBeLessThan(0)
    expect(result.below?.y).toBeGreaterThan(0)
  })

  it('enlarges a single photo without requiring neighbors', () => {
    const result = calculateMakeWayTransforms({
      items: [{ id: 'only', left: 120, top: 120, width: 280, height: 360 }],
      selectedId: 'only',
      mode: 'desktop',
      bounds: wideBounds,
      selectedScale: 1.7,
    })

    expect(result.only).toMatchObject({
      scale: 1.7,
      rotation: 0,
      zIndex: 20,
    })
  })

  it('returns idle transforms when the selected ID is absent', () => {
    const result = calculateMakeWayTransforms({
      items: [{ id: 'only', left: 20, top: 20, width: 280, height: 360 }],
      selectedId: 'missing',
      mode: 'desktop',
      bounds: wideBounds,
      selectedScale: 1.7,
    })

    expect(result.only).toEqual({
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      zIndex: 0,
    })
  })
})
