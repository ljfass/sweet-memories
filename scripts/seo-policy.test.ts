// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { build } from 'vite'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const sourceIndexPath = fileURLToPath(new URL('../index.html', import.meta.url))
const sourceRobotsPath = fileURLToPath(new URL('../public/robots.txt', import.meta.url))
const expectedDescription = '记录宝宝成长瞬间的家庭纪念相册。'
const expectedRobotsMeta = 'noindex, nofollow, noarchive, nosnippet, noimageindex'
const expectedRobotsFile = 'User-agent: *\nDisallow: /\n'
const temporaryDirectories: string[] = []

function expectSearchMetadata(html: string) {
  const window = new Window({ url: 'http://example.test/' })

  try {
    const { document } = window
    document.write(html)
    document.close()

    const namedMetadata = [...document.querySelectorAll('meta[name]')]
    const descriptions = namedMetadata.filter(
      (meta) => meta.getAttribute('name')?.toLowerCase() === 'description',
    )
    const robots = namedMetadata.filter(
      (meta) => meta.getAttribute('name')?.toLowerCase() === 'robots',
    )

    expect(descriptions).toHaveLength(1)
    expect(descriptions[0]?.parentElement).toBe(document.head)
    expect(descriptions[0]?.getAttribute('content')).toBe(expectedDescription)
    expect(robots).toHaveLength(1)
    expect(robots[0]?.parentElement).toBe(document.head)
    expect(robots[0]?.getAttribute('content')).toBe(expectedRobotsMeta)
  } finally {
    window.close()
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe('search indexing privacy policy', () => {
  it('rejects required search metadata outside the document head', () => {
    expect(() =>
      expectSearchMetadata(`
        <!doctype html>
        <html>
          <head><title>Private album</title></head>
          <body>
            <meta name="description" content="${expectedDescription}" />
            <meta name="robots" content="${expectedRobotsMeta}" />
          </body>
        </html>
      `),
    ).toThrow()
  })

  it.each([
    ['DESCRIPTION', expectedDescription],
    ['ROBOTS', expectedRobotsMeta],
  ])('rejects a mixed-case duplicate %s metadata name', (name, content) => {
    expect(() =>
      expectSearchMetadata(`
        <!doctype html>
        <html>
          <head>
            <meta name="description" content="${expectedDescription}" />
            <meta name="robots" content="${expectedRobotsMeta}" />
            <meta name="${name}" content="${content}" />
          </head>
          <body></body>
        </html>
      `),
    ).toThrow()
  })

  it('declares the exact privacy-first metadata in the source HTML', async () => {
    expectSearchMetadata(await readFile(sourceIndexPath, 'utf8'))
  })

  it('publishes the exact deny-all robots policy', async () => {
    await expect(readFile(sourceRobotsPath, 'utf8')).resolves.toBe(expectedRobotsFile)
  })

  it('preserves the search policy in a real Vite build', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'sweet-memories-seo-build-'))
    temporaryDirectories.push(outputDirectory)

    await build({
      root: projectRoot,
      logLevel: 'silent',
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
      },
    })

    const [builtHtml, builtRobots] = await Promise.all([
      readFile(join(outputDirectory, 'index.html'), 'utf8'),
      readFile(join(outputDirectory, 'robots.txt'), 'utf8'),
    ])

    expectSearchMetadata(builtHtml)
    expect(builtRobots).toBe(expectedRobotsFile)
  })
})
