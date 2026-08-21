export type MakeWayMode = 'desktop' | 'mobile'

export interface MakeWayRect {
  id: string
  left: number
  top: number
  width: number
  height: number
}

export interface MakeWayBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface MakeWayTransform {
  x: number
  y: number
  scale: number
  rotation: number
  zIndex: number
}

interface CalculateMakeWayInput {
  items: readonly MakeWayRect[]
  selectedId: string
  mode: MakeWayMode
  bounds: MakeWayBounds
  selectedScale: number
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value))

function constrainToBounds(
  rect: MakeWayRect,
  x: number,
  y: number,
  scale: number,
  bounds: MakeWayBounds,
) {
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const halfWidth = rect.width * scale / 2
  const halfHeight = rect.height * scale / 2
  let correctedX = x
  let correctedY = y

  const projectedLeft = centerX + correctedX - halfWidth
  if (projectedLeft < bounds.left) {
    correctedX += bounds.left - projectedLeft
  }

  const projectedRight = centerX + correctedX + halfWidth
  if (projectedRight > bounds.right) {
    correctedX -= projectedRight - bounds.right
  }

  const projectedTop = centerY + correctedY - halfHeight
  if (projectedTop < bounds.top) {
    correctedY += bounds.top - projectedTop
  }

  const projectedBottom = centerY + correctedY + halfHeight
  if (projectedBottom > bounds.bottom) {
    correctedY -= projectedBottom - bounds.bottom
  }

  return { x: correctedX, y: correctedY }
}

function createIdleTransforms(items: readonly MakeWayRect[]) {
  const transforms: Record<string, MakeWayTransform> = {}

  for (const item of items) {
    transforms[item.id] = {
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      zIndex: 0,
    }
  }

  return transforms
}

export function calculateMakeWayTransforms({
  items,
  selectedId,
  mode,
  bounds,
  selectedScale,
}: CalculateMakeWayInput) {
  const transforms = createIdleTransforms(items)
  const selectedIndex = items.findIndex((item) => item.id === selectedId)
  const selected = items[selectedIndex]

  if (!selected) {
    return transforms
  }

  const selectedCenterX = selected.left + selected.width / 2
  const selectedCenterY = selected.top + selected.height / 2
  const selectedCorrection = constrainToBounds(
    selected,
    0,
    0,
    selectedScale,
    bounds,
  )

  transforms[selected.id] = {
    ...selectedCorrection,
    scale: selectedScale,
    rotation: 0,
    zIndex: 20,
  }

  items.forEach((item, index) => {
    if (item.id === selected.id) {
      return
    }

    const deltaX = item.left + item.width / 2 - selectedCenterX
    const deltaY = item.top + item.height / 2 - selectedCenterY
    const distance = Math.hypot(deltaX, deltaY)
    const fallbackDirection = index < selectedIndex ? -1 : 1
    const influenceRange = mode === 'desktop' ? 920 : 720
    const influence = clamp(1 - distance / influenceRange, 0, 1)

    let x = 0
    let y = 0
    let rotation = 0

    if (mode === 'mobile') {
      const directionY = Math.sign(deltaY) || fallbackDirection
      y = directionY * (62 + 50 * influence)
    } else {
      const safeDistance = distance || 1
      const directionX = distance ? deltaX / safeDistance : 0
      const directionY = distance ? deltaY / safeDistance : fallbackDirection
      const displacement = 48 + 112 * influence
      x = directionX * displacement
      y = directionY * displacement
      rotation = clamp(directionX * (2 + 4 * influence), -6, 6)
    }

    const correction = constrainToBounds(item, x, y, 1, bounds)
    transforms[item.id] = {
      ...correction,
      scale: 1,
      rotation,
      zIndex: 1,
    }
  })

  return transforms
}
