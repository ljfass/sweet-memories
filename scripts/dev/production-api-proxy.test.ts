// @vitest-environment node
import { describe, expect, it } from 'vitest'

import config from '../../vite.config'
import {
  LOCAL_SESSION_COOKIE,
  PRODUCTION_ORIGIN,
  PRODUCTION_SESSION_COOKIE,
  rewriteProxyRequest,
  rewriteProxyResponse,
} from './production-api-proxy'

function requestWriter(initialCookie?: string) {
  const headers = new Map<string, string>()
  if (initialCookie !== undefined) {
    headers.set('cookie', initialCookie)
  }

  return {
    headers,
    request: {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value)
      },
      removeHeader(name: string) {
        headers.delete(name.toLowerCase())
      },
    },
  }
}

describe('local production API development server', () => {
  it('binds only to loopback on the stable development port', () => {
    expect(config.server).toMatchObject({
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    })
  })

  it('proxies only API and media paths to the fixed production origin', () => {
    expect(Object.keys(config.server?.proxy ?? {}).sort()).toEqual(['/api', '/media'])

    for (const route of ['/api', '/media']) {
      expect(config.server?.proxy?.[route]).toMatchObject({
        target: 'https://huangjianfen.cn',
        changeOrigin: true,
        secure: true,
      })
      expect(config.server?.proxy?.[route]).toHaveProperty('configure')
    }
  })
})

describe('production proxy session boundary', () => {
  it('rewrites only the canonical local session and production origin', () => {
    const token = 'a'.repeat(43)
    const writer = requestWriter('previous=must-be-removed')

    rewriteProxyRequest(writer.request, {
      headers: {
        cookie: `analytics=private; ${LOCAL_SESSION_COOKIE}=${token}; preference=dark`,
      },
    })

    expect(writer.headers.get('origin')).toBe(PRODUCTION_ORIGIN)
    expect(writer.headers.get('cookie')).toBe(`${PRODUCTION_SESSION_COOKIE}=${token}`)
  })

  it.each([
    undefined,
    '',
    `${LOCAL_SESSION_COOKIE}=short`,
    `${LOCAL_SESSION_COOKIE}=${'a'.repeat(42)}!`,
    `${LOCAL_SESSION_COOKIE}=${'a'.repeat(44)}`,
    `another_cookie=${'a'.repeat(43)}`,
  ])('removes outbound cookies when the local session is absent or malformed', (cookie) => {
    const writer = requestWriter('previous=must-be-removed')

    rewriteProxyRequest(writer.request, { headers: { cookie } })

    expect(writer.headers.get('origin')).toBe(PRODUCTION_ORIGIN)
    expect(writer.headers.has('cookie')).toBe(false)
  })

  it('maps the production session to a local HttpOnly cookie without Secure', () => {
    const response = {
      headers: {
        'set-cookie': [
          `${PRODUCTION_SESSION_COOKIE}=token; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`,
          'unrelated=private; Path=/; Secure',
        ],
      },
    }

    rewriteProxyResponse(response)

    expect(response.headers['set-cookie']).toEqual([
      `${LOCAL_SESSION_COOKIE}=token; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`,
    ])
  })

  it('maps logout cookies and strips Secure case-insensitively', () => {
    const response = {
      headers: {
        'set-cookie': [
          `${PRODUCTION_SESSION_COOKIE}=; Path=/; HttpOnly; sEcUrE; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
        ],
      },
    }

    rewriteProxyResponse(response)

    expect(response.headers['set-cookie']).toEqual([
      `${LOCAL_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    ])
  })

  it('does not expose unrelated upstream cookies to localhost', () => {
    const response: { headers: { 'set-cookie'?: string[] } } = {
      headers: { 'set-cookie': ['unrelated=private; Path=/; Secure'] },
    }

    rewriteProxyResponse(response)

    expect(response.headers['set-cookie']).toBeUndefined()
  })
})
