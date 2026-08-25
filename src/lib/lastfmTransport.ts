import { Capacitor, CapacitorHttp } from '@capacitor/core'

/**
 * The ONE network path to ws.audioscrobbler.com (D10 analog of `webdavFetch`):
 * POST form-urlencoded on BOTH platforms.
 *
 * Field finding (2026-08-25, real PWA rollout): Last.fm REJECTS GET for write
 * methods (`track.scrobble`, `track.updatenowplaying`) with error 4 "You must
 * use POST method" — the old GET+JSONP client pattern is dead. The same
 * rollout showed ws.audioscrobbler.com sends `Access-Control-Allow-Origin: *`
 * (+ allow-methods POST/GET), and a form-urlencoded POST is a CORS simple
 * request (no preflight) — so the web uses plain `fetch` and native uses
 * CapacitorHttp (URLSession, CORS-free). Params handed here are already
 * SIGNED; `format=json` is appended into the body AFTER signing by
 * construction.
 *
 * Body-first error handling: Last.fm reports API failures INSIDE non-2xx
 * responses (`{error:n}`) — the parsed body is always preferred over the HTTP
 * status so typed codes (rate-limit 29, unauthorized 14, …) survive; only a
 * non-JSON/unreachable response becomes a transport error.
 */

export type LfmTransport = (params: Record<string, string>) => Promise<unknown>

const LFM_ROOT = 'https://ws.audioscrobbler.com/2.0/'
const TIMEOUT_MS = 10000

export async function lfmRequest(params: Record<string, string>): Promise<unknown> {
  const body = new URLSearchParams({ ...params, format: 'json' }).toString()
  if (Capacitor.isNativePlatform()) return nativeRequest(body)
  return webRequest(body)
}

async function webRequest(body: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(LFM_ROOT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    })
  } catch (err) {
    throw new Error(`Last.fm request failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
  return parseBody(resp.status, await resp.text().catch(() => ''))
}

async function nativeRequest(body: string): Promise<unknown> {
  let response
  try {
    response = await CapacitorHttp.request({
      url: LFM_ROOT,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: body,
      connectTimeout: TIMEOUT_MS,
      readTimeout: TIMEOUT_MS,
    })
  } catch (err) {
    throw new Error(`Last.fm request failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  // CapacitorHttp may auto-parse JSON bodies into objects — pass them through.
  const raw = typeof response.data === 'string' ? response.data : ''
  const parsed = typeof response.data === 'string' ? undefined : response.data
  return parseBody(response.status, raw, parsed)
}

/** Prefers the JSON body (typed `{error:n}` payloads ride non-2xx statuses too). */
function parseBody(status: number, raw: string, preParsed?: unknown): unknown {
  let data = preParsed ?? null
  if (data === null && raw) {
    try {
      data = JSON.parse(raw)
    } catch {
      data = null
    }
  }
  if (data !== null) {
    // API-level payloads (success OR `{error:n}`) win over the HTTP status.
    return data
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Last.fm request failed: HTTP ${status}`)
  }
  return {}
}
