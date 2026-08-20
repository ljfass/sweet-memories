import type { Memory, ResponsiveImageSources } from '../types/album'

const generatedAssets = import.meta.glob<string>('../assets/generated/*', {
  eager: true,
  query: '?url',
  import: 'default',
})

const imageWidths = [320, 640, 960] as const

function asset(filename: string): string {
  const url = generatedAssets[`../assets/generated/${filename}`]

  if (!url) {
    throw new Error(`Missing generated asset: ${filename}`)
  }

  return url
}

function imageSrcset(id: string, extension: 'avif' | 'webp' | 'jpg'): string {
  return imageWidths
    .map((width) => `${asset(`photo-${id}-${width}.${extension}`)} ${width}w`)
    .join(', ')
}

function photoSources(id: string): ResponsiveImageSources {
  return {
    avif: imageSrcset(id, 'avif'),
    webp: imageSrcset(id, 'webp'),
    jpeg: imageSrcset(id, 'jpg'),
    fallback: asset(`photo-${id}-640.jpg`),
  }
}

export const memories: readonly Memory[] = Object.freeze([
  {
    id: '1',
    caption: '刚出生的时候 🍼',
    alt: '刚出生的宝宝裹在粉色襁褓中安静熟睡',
    sources: photoSources('1'),
    transform: { rotation: -5, x: 0, y: 10 },
  },
  {
    id: '2',
    caption: '第一次笑得这么开心 😄',
    alt: '宝宝睁着眼睛躺在印花被褥中',
    sources: photoSources('2'),
    transform: { rotation: 3, x: 10, y: -5 },
  },
  {
    id: '3',
    caption: '满月啦 🎈',
    alt: '爸爸妈妈抱着宝宝在蛋糕前庆祝满月',
    sources: photoSources('3'),
    transform: { rotation: -2, x: -10, y: 0 },
  },
  {
    id: '4',
    caption: '睡觉的样子最乖 💤',
    alt: '宝宝躺在圆点枕头上安静熟睡',
    sources: photoSources('4'),
    transform: { rotation: 4, x: 5, y: 15 },
  },
  {
    id: '5',
    caption: '带去公园玩 🌳',
    alt: '宝宝坐在婴儿车里游览开满玫瑰的公园',
    sources: photoSources('5'),
    transform: { rotation: -4, x: 0, y: -10 },
  },
])

export const videoPosterUrl = asset('video-poster.jpg')
export const videoUrl = asset('memory.mp4')

export const audioSources = Object.freeze({
  aac: asset('lullaby.m4a'),
  mp3: asset('lullaby.mp3'),
})
