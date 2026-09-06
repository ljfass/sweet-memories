import type { ProxyOptions } from 'vite'

export const PRODUCTION_ORIGIN = 'https://huangjianfen.cn'
export const PRODUCTION_SESSION_COOKIE = '__Host-sweet_memories_session'
export const LOCAL_SESSION_COOKIE = 'sweet_memories_dev_session'

interface WritableProxyRequest {
  setHeader(name: string, value: string): void
  removeHeader(name: string): void
}

interface IncomingProxyRequest {
  readonly headers: {
    readonly cookie?: string
  }
}

interface MutableProxyResponse {
  readonly headers: {
    'set-cookie'?: string[]
  }
}

export function rewriteProxyRequest(
  proxyRequest: WritableProxyRequest,
  request: IncomingProxyRequest,
): void {
  proxyRequest.setHeader('origin', PRODUCTION_ORIGIN)

  const token = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCAL_SESSION_COOKIE}=`))
    ?.slice(LOCAL_SESSION_COOKIE.length + 1)

  if (token !== undefined && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    proxyRequest.setHeader('cookie', `${PRODUCTION_SESSION_COOKIE}=${token}`)
  } else {
    proxyRequest.removeHeader('cookie')
  }
}

export function rewriteProxyResponse(response: MutableProxyResponse): void {
  const cookies = response.headers['set-cookie']
    ?.filter((cookie) => cookie.startsWith(`${PRODUCTION_SESSION_COOKIE}=`))
    .map((cookie) => cookie
      .replace(PRODUCTION_SESSION_COOKIE, LOCAL_SESSION_COOKIE)
      .replace(/;\s*Secure(?=;|$)/gi, ''))

  if (cookies === undefined || cookies.length === 0) {
    delete response.headers['set-cookie']
  } else {
    response.headers['set-cookie'] = cookies
  }
}

function createProxyOptions(): ProxyOptions {
  return {
    target: PRODUCTION_ORIGIN,
    changeOrigin: true,
    secure: true,
    configure(proxy) {
      proxy.on('proxyReq', rewriteProxyRequest)
      proxy.on('proxyRes', rewriteProxyResponse)
    },
  }
}

export function createProductionApiProxy(): Record<string, ProxyOptions> {
  return {
    '/api': createProxyOptions(),
    '/media': createProxyOptions(),
  }
}
