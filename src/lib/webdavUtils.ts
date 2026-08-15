import { Capacitor } from '@capacitor/core'
import { CapacitorHttp, type HttpResponse } from '@capacitor/core'

/**
 * Minimal fetch-compatible surface used across WebDAV call sites.
 * The native path cannot hand out a real `Response` (the HTTP plugin
 * returns base64-encoded bodies and a plain header dictionary), so the
 * native shim implements exactly what the callers consume.
 */
export interface WebdavResponse {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  readonly headers: {
    get(name: string): string | null
  }
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

export function webdavFetch(url: string, options: RequestInit, timeoutMs: number): Promise<WebdavResponse> {
  if (Capacitor.isNativePlatform()) {
    return nativeWebdavFetch(url, options, timeoutMs)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer))
}

/**
 * Native iOS path: routes WebDAV through CapacitorHttp (URLSession), which is
 * free of browser CORS — plain `fetch` from the `capacitor://localhost` webview
 * is blocked by servers that whitelist web origins (e.g. Cloudflare Workers
 * hardcoding `Access-Control-Allow-Origin`), regardless of URL validity.
 */
async function nativeWebdavFetch(url: string, options: RequestInit, timeoutMs: number): Promise<WebdavResponse> {
  const body = options.body
  const data = body instanceof ArrayBuffer ? arrayBufferToBase64(body) : typeof body === 'string' ? body : undefined
  const dataType = body instanceof ArrayBuffer ? 'file' : undefined

  let response: HttpResponse
  try {
    response = await CapacitorHttp.request({
      url,
      method: (options.method ?? 'GET').toUpperCase(),
      headers: (options.headers ?? {}) as Record<string, string>,
      data,
      dataType,
      responseType: 'arraybuffer',
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    })
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err))
  }

  const headerMap: Record<string, string> = {}
  for (const [key, value] of Object.entries(response.headers)) {
    headerMap[key.toLowerCase()] = value
  }

  const buffer = typeof response.data === 'string' ? base64ToArrayBuffer(response.data) : new ArrayBuffer(0)

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: '',
    headers: {
      get(name: string): string | null {
        return headerMap[name.toLowerCase()] ?? null
      },
    },
    arrayBuffer: () => Promise.resolve(buffer),
    text: () => Promise.resolve(new TextDecoder().decode(buffer)),
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  const CHUNK = 0x8000
  for (let i = 0; i < binary.length; i += CHUNK) {
    const slice = binary.slice(i, i + CHUNK)
    for (let j = 0; j < slice.length; j++) {
      bytes[i + j] = slice.charCodeAt(j)
    }
  }
  return bytes.buffer
}

export function authHeaders(user: string, token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`${user}:${token}`)}` }
}

export function normalizeUrl(base: string): string {
  return base.trim().replace(/\/+$/, "")
}

/**
 * Server identity key for metadata stamping (TODO 3.5): the ONE derivation
 * used by both the scan's `webdavBase` stamp and Push's current-server check,
 * so stray whitespace can never make the two sides diverge and flag the whole
 * library "Server URL updated". TRIM-ONLY by design: the trailing slash is
 * preserved to match how existing rows were stamped (the Settings placeholder
 * is a trailing-slash URL), and case is preserved because URL paths can be
 * case-sensitive — either change would invalidate already-stamped rows.
 */
export function webdavBaseKey(url: string, user: string): string {
  return `${url.trim()}|${user.trim()}`
}

export function buildWebdavUrl(baseUrl: string, filePath: string): string {
  const encodedPath = filePath.split("/").map((s) => encodeURIComponent(s)).join("/")
  return `${normalizeUrl(baseUrl)}/${encodedPath.replace(/^\/+/, "")}`
}
