// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import eslintConfig from '../../eslint.config.js'

interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: Record<string, string>
  files?: string[]
  name?: string
  scripts?: Record<string, string>
}

interface WorkspaceManifest {
  packages?: string[]
}

const workspacePath = fileURLToPath(
  new URL('../../pnpm-workspace.yaml', import.meta.url),
)
const rootPackagePath = fileURLToPath(
  new URL('../../package.json', import.meta.url),
)
const apiPackagePath = fileURLToPath(
  new URL('../../apps/api/package.json', import.meta.url),
)
const apiEntryPath = fileURLToPath(
  new URL('../../apps/api/src/index.ts', import.meta.url),
)

function readRequiredFile(path: string, label: string): string {
  expect(existsSync(path), `${label} must exist`).toBe(true)
  return readFileSync(path, 'utf8')
}

function loadPackage(path: string, label: string): PackageManifest {
  return JSON.parse(readRequiredFile(path, label)) as PackageManifest
}

describe('photo API workspace contract', () => {
  it('registers only application workspaces', () => {
    const workspace = parse(
      readRequiredFile(workspacePath, 'pnpm-workspace.yaml'),
    ) as WorkspaceManifest

    expect(workspace).toEqual({ packages: ['apps/*'] })
  })

  it('pins the API package contract', () => {
    const apiPackage = loadPackage(apiPackagePath, 'apps/api/package.json')

    expect(apiPackage.name).toBe('@sweet-memories/api')
    expect(apiPackage.engines).toEqual({ node: '>=24 <25' })
    expect(apiPackage.files).toEqual(['dist', 'migrations', 'seed'])
    expect(apiPackage.scripts).toEqual({
      build: 'tsc -p tsconfig.json',
      typecheck: 'tsc -p tsconfig.json --noEmit',
      test: 'vitest run src',
    })
    expect(apiPackage.dependencies).toEqual({
      '@fastify/cookie': '11.1.2',
      '@fastify/multipart': '10.1.1',
      argon2: '0.45.1',
      'better-sqlite3': '13.0.3',
      exifr: '7.1.3',
      fastify: '5.12.1',
      'file-type': '22.0.2',
      sharp: '0.35.4',
    })
    expect(apiPackage.devDependencies).toEqual({
      '@types/better-sqlite3': '9.6.0',
      '@types/node': '24.13.3',
      typescript: '6.0.3',
      vitest: '4.1.11',
    })
  })

  it('provides a minimal compilable API entry point', () => {
    expect(readRequiredFile(apiEntryPath, 'apps/api/src/index.ts')).toBe(
      'export {};\n',
    )
  })

  it('runs frontend and API quality commands from the root', () => {
    const rootPackage = loadPackage(rootPackagePath, 'package.json')

    expect(rootPackage.scripts).toMatchObject({
      typecheck:
        'vue-tsc --noEmit -p tsconfig.app.json && pnpm --dir apps/api typecheck',
      'build:frontend': 'vite build',
      'build:api': 'pnpm --dir apps/api build',
      build: 'pnpm build:frontend && pnpm build:api',
      'test:api': 'pnpm --dir apps/api test',
    })
  })

  it('lints API source files as Node TypeScript', () => {
    const nodeConfig = eslintConfig.find(
      (config) =>
        Array.isArray(config.files) &&
        config.files.includes('scripts/**/*.{cjs,mjs,ts}'),
    )

    expect(nodeConfig?.files).toContain('apps/api/src/**/*.ts')
  })

  it('ignores build output at every workspace depth', () => {
    const ignoreConfig = eslintConfig.find((config) =>
      Array.isArray(config.ignores),
    )

    expect(ignoreConfig?.ignores).toContain('**/dist/**')
  })
})
