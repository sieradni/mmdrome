import { Capacitor } from '@capacitor/core'
import { CapacitorHttp, type HttpResponse } from '@capacitor/core'
import { authHeaders, buildWebdavUrl, isTempFile, normalizeUrl, webdavTempPath } from './webdavPaths'

// The URL/auth/temp helpers live in `webdavPaths` (Capacitor-free) so the pure
// write core and Node tests share ONE derivation with this transport layer —
// they were previously duplicated here and mirrored there, and the copies
// drifted. Re-exported here because this is the module the scanners import.
export { authHeaders, buildWebdavUrl, isTempFile, normalizeUrl, webdavTempPath }
export { MMDROME_TMP_SUFFIX } from './webdavPaths'

export type WebdavTransportPhase = 'headers' | 'body' | 'decode'

export class WebdavTransportError extends Error {
  readonly method: string
  readonly transport: 'web' | 'native'
  readonly phase: WebdavTransportPhase
  readonly timedOut: boolean
  readonly code?: string | number
  readonly domain?: string
  readonly elapsedMs: number

  constructor(
    message: string,
    opts: {
      method: string
      transport: 'web' | 'native'
      phase: WebdavTransportPhase
      timedOut?: boolean
      code?: string | number
      domain?: string
      elapsedMs: number
      cause?: unknown
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'WebdavTransportError'
    this.method = opts.method
    this.transport = opts.transport
    this.phase = opts.phase
    this.timedOut = opts.timedOut === true
    this.code = opts.code
    this.domain = opts.domain
    this.elapsedMs = opts.elapsedMs
  }
}

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

const ALLOWLISTED_REQUEST_ID_HEADERS = [
  'x-request-id',
  'x-correlation-id',
  'cf-ray',
  'x-amz-request-id',
] as const

export function extractAllowlistedRequestId(headers: { get(name: string): string | null }): string | undefined {
  for (const name of ALLOWLISTED_REQUEST_ID_HEADERS) {
    const val = headers.get(name)?.trim()
    if (val) return val.slice(0, 128)
  }
  return undefined
}

export async function webdavFetch(url: string, options: RequestInit, timeoutMs: number): Promise<WebdavResponse> {
  if (Capacitor.isNativePlatform()) {
    return nativeWebdavFetch(url, options, timeoutMs)
  }
  const method = (options.method ?? 'GET').toUpperCase()
  const startedAt = Date.now()
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  let rawRes: Response
  try {
    rawRes = await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    clearTimeout(timer)
    const elapsedMs = Date.now() - startedAt
    const msg = timedOut
      ? `WebDAV ${method} timed out after ${timeoutMs}ms (headers)`
      : err instanceof Error
        ? err.message
        : String(err)
    throw new WebdavTransportError(msg, {
      method,
      transport: 'web',
      phase: 'headers',
      timedOut,
      elapsedMs,
      cause: err,
    })
  }

  let bodyConsumed = false
  const finishBodyTimer = () => {
    if (!bodyConsumed) {
      bodyConsumed = true
      clearTimeout(timer)
    }
  }

  // If the caller never reads the body (e.g., PUT/MOVE/DELETE status check),
  // clear the timer after `timeoutMs` automatically via the existing timeout,
  // or immediately when `arrayBuffer()` / `text()` settles. For bodiless
  // methods where callers only inspect `.ok` / `.status`, clear the timer on
  // the next microtask unless a body reader is invoked.
  if (method !== 'GET' && method !== 'PROPFIND') {
    queueMicrotask(finishBodyTimer)
  }

  return {
    ok: rawRes.ok,
    status: rawRes.status,
    statusText: rawRes.statusText,
    headers: {
      get(name: string): string | null {
        return rawRes.headers.get(name)
      },
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      try {
        return await rawRes.arrayBuffer()
      } catch (err) {
        const elapsedMs = Date.now() - startedAt
        const msg = timedOut
          ? `WebDAV ${method} timed out after ${timeoutMs}ms (body)`
          : err instanceof Error
            ? err.message
            : String(err)
        throw new WebdavTransportError(msg, {
          method,
          transport: 'web',
          phase: 'body',
          timedOut,
          elapsedMs,
          cause: err,
        })
      } finally {
        finishBodyTimer()
      }
    },
    async text(): Promise<string> {
      try {
        return await rawRes.text()
      } catch (err) {
        const elapsedMs = Date.now() - startedAt
        const msg = timedOut
          ? `WebDAV ${method} timed out after ${timeoutMs}ms (body)`
          : err instanceof Error
            ? err.message
            : String(err)
        throw new WebdavTransportError(msg, {
          method,
          transport: 'web',
          phase: 'body',
          timedOut,
          elapsedMs,
          cause: err,
        })
      } finally {
        finishBodyTimer()
      }
    },
  }
}

/**
 * Native iOS path: routes WebDAV through CapacitorHttp (URLSession), which is
 * free of browser CORS — plain `fetch` from the `capacitor://localhost` webview
 * is blocked by servers that whitelist web origins (e.g. Cloudflare Workers
 * hardcoding `Access-Control-Allow-Origin`), regardless of URL validity.
 */
export async function nativeWebdavFetch(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  httpRequest: typeof CapacitorHttp.request = CapacitorHttp.request.bind(CapacitorHttp),
): Promise<WebdavResponse> {
  const method = (options.method ?? 'GET').toUpperCase()
  const startedAt = Date.now()
  const body = options.body
  const data = body instanceof ArrayBuffer ? arrayBufferToBase64(body) : typeof body === 'string' ? body : undefined
  const dataType = body instanceof ArrayBuffer ? 'file' : undefined
  // CapacitorHttp does not accept RequestInit.cache. Preserve the native
  // push reads' revalidation directive when callers request fresh bytes.
  const headers = new Headers(options.headers)
  if (options.cache === 'no-store') headers.set('Cache-Control', 'no-cache')

  let response: HttpResponse
  try {
    response = await httpRequest({
      url,
      method,
      headers: Object.fromEntries(headers),
      data,
      dataType,
      responseType: 'arraybuffer',
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    })
  } catch (err) {
    const elapsedMs = Date.now() - startedAt
    const rawObj = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : null
    const code =
      typeof rawObj?.code === 'string' || typeof rawObj?.code === 'number'
        ? rawObj.code
        : typeof rawObj?.errorCode === 'string' || typeof rawObj?.errorCode === 'number'
          ? rawObj.errorCode
          : undefined
    const domain = typeof rawObj?.domain === 'string' ? rawObj.domain : undefined
    const baseMsg =
      err instanceof Error
        ? err.message
        : typeof rawObj?.message === 'string'
          ? rawObj.message
          : String(err)
    const timedOut = code === 'NSURLErrorTimedOut' || code === -1001 || /timed?\s*out/i.test(baseMsg)
    throw new WebdavTransportError(baseMsg, {
      method,
      transport: 'native',
      phase: 'headers',
      timedOut,
      code,
      domain,
      elapsedMs,
      cause: err,
    })
  }

  const headerMap: Record<string, string> = {}
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    headerMap[key.toLowerCase()] = value
  }

  let buffer: ArrayBuffer
  try {
    buffer = typeof response.data === 'string' ? base64ToArrayBuffer(response.data) : new ArrayBuffer(0)
  } catch (err) {
    const elapsedMs = Date.now() - startedAt
    throw new WebdavTransportError(
      `WebDAV ${method} native base64 decode failed: ${err instanceof Error ? err.message : String(err)}`,
      {
        method,
        transport: 'native',
        phase: 'decode',
        elapsedMs,
        cause: err,
      },
    )
  }

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

/**
 * Strips the PROPFIND base URL off a returned href, producing the relative
 * path the index keys on. Absolute and path-form hrefs are both handled; a
 * malformed href (e.g. a stray '%' that `decodeURIComponent` rejects) falls
 * back to the raw value instead of aborting the whole index build (TODO 3.6d).
 */
export function stripBasePath(baseUrl: string, href: string): string {
  let decoded = href
  try {
    decoded = decodeURIComponent(href)
  } catch {
    // A malformed href (e.g. a stray '%') must not abort the whole index
    // build — fall back to the raw value and let the strip below proceed.
  }
  try {
    const urlPath = new URL(normalizeUrl(baseUrl)).pathname.replace(/\/+$/, "")
    if (urlPath && decoded.toLowerCase().startsWith(urlPath.toLowerCase())) {
      return decoded.slice(urlPath.length).replace(/^\/+/, "")
    }
  } catch {}
  const urlStr = normalizeUrl(baseUrl)
  const escaped = urlStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return decoded.replace(new RegExp(`^${escaped}/?`, "i"), "")
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
