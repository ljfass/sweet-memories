export interface AgeParts {
  years: number
  days: number
  hours: number
  minutes: number
  seconds: number
}

export interface ResponsiveImageSources {
  avif: string
  webp: string
  jpeg: string
  fallback: string
}

export interface MemoryTransform {
  rotation: number
  x: number
  y: number
}

export interface Memory {
  id: string
  caption: string
  alt: string
  sources: ResponsiveImageSources
  transform: MemoryTransform
}
