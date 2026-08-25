import { Capacitor, CapacitorHttp } from '@capacitor/core'

/**
 * The ONE network path to ws.audioscrobbler.com (D10 analog of `webdavFetch`).
 *
 * - Native iOS: POST via CapacitorHttp (URLSession) — no CORS in the way,
 *   proper write semantics.
 * - Web/PWA: JSONP (`format=json&callback=`). ws.audioscrobbler.com sends no
 *   CORS headers, but honors JSONP for every method including writes over
 *   GET. Params are appended AFTER signing by construction — callers hand us
 *   an already-signed body (`signedCallParams`), and this layer alone adds
 *   the transport-only fields.
 *
 * Returns the parsed JSON envelope verbatim; `{error:n}` payloads are mapped
 * to typed errors one layer up (`lastfmApi`).
 */

export type LfmTransport = (params: Record<string, string>) => Promise<unknown>

const LFM_ROOT = 'https://ws.audioscrobbler.com/2.0/'
const WEB_TIMEOUT_MS = 10000

let jsonpCounter = 0

export async function lfmRequest(params: Record<string, string>): Promise<unknown> {
  if (Capacitor.isNativePlatform()) return nativeRequest(params)
  return jsonpRequest(params)
}

async function nativeRequest(params: Record<string, string>): Promise<unknown> {
  let data: unknown
  try {
    const response = await CapacitorHttp.request({
      url: LFM_ROOT,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: new URLSearchParams(params).toString(),
      connectTimeout: WEB_TIMEOUT_MS,
      readTimeout: WEB_TIMEOUT_MS,
    })
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}`)
    }
    data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
  } catch (err) {
    throw new Error(`Last.fm request failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return data
}

function jsonpRequest(params: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cbName = `__mmdromeLfmCb${Date.now().toString(36)}${jsonpCounter++}`
    const search = new URLSearchParams({ ...params, format: 'json', callback: cbName })
    const script = document.createElement('script')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scope = window as unknown as Record<string, ((data: unknown) => void) | undefined>

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Last.fm request timed out'))
    }, WEB_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timer)
      delete scope[cbName]
      script.remove()
    }

    scope[cbName] = (data: unknown) => {
      cleanup()
      resolve(data)
    }
    script.onerror = () => {
      cleanup()
      reject(new Error('Last.fm request failed'))
    }
    script.src = `${LFM_ROOT}?${search.toString()}`
    document.head.appendChild(script)
  })
}
