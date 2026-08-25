import {
  describeLfmError,
  signedCallParams,
  buildScrobbleParams,
  type LfmCreds,
  type LfmSession,
  type ScrobbleMeta,
  type NowPlayingMeta,
} from './lastfmCore'
import { lfmRequest, type LfmTransport } from './lastfmTransport'

/**
 * Stateless Last.fm method layer (D7 analog): every function takes explicit
 * credentials/session — no config caching, no store reads. Transport is an
 * injectable parameter (default = the real JSONP/CapacitorHttp choke point)
 * so the request shapes are pinned without a DOM.
 *
 * The server signals failures inside a 200 response as `{error: n}`; those
 * become `LastfmError`. Network/timeout/parse failures surface as the
 * transport's generic Error and are treated as retryable by the flush engine.
 */

export class LastfmError extends Error {
  readonly code: number
  constructor(code: number) {
    super(describeLfmError(code))
    this.name = 'LastfmError'
    this.code = code
  }
}

function unwrap(data: unknown): Record<string, unknown> {
  if (data && typeof data === 'object' && 'error' in data) {
    const code = (data as { error: unknown }).error
    throw new LastfmError(typeof code === 'number' ? code : -1)
  }
  return (data ?? {}) as Record<string, unknown>
}

export async function lfmGetToken(creds: LfmCreds, transport: LfmTransport = lfmRequest): Promise<string> {
  const data = await transport(signedCallParams('auth.getToken', {}, creds))
  const token = unwrap(data).token
  if (typeof token !== 'string') throw new LastfmError(-2)
  return token
}

export async function lfmGetSession(
  creds: LfmCreds,
  token: string,
  transport: LfmTransport = lfmRequest,
): Promise<LfmSession> {
  const data = await transport(signedCallParams('auth.getSession', { token }, creds))
  const session = unwrap(data).session as Partial<LfmSession> | undefined
  if (!session || typeof session.key !== 'string' || typeof session.name !== 'string') {
    throw new LastfmError(4)
  }
  return { key: session.key, name: session.name }
}

/** Submits ONE batch (≤50 entries — chunking belongs to the flush planner). */
export async function lfmScrobbleBatch(
  creds: LfmCreds,
  sessionKey: string,
  metas: ScrobbleMeta[],
  transport: LfmTransport = lfmRequest,
): Promise<void> {
  const data = await transport(signedCallParams('track.scrobble', buildScrobbleParams(metas), creds, sessionKey))
  unwrap(data)
}

export async function lfmUpdateNowPlaying(
  creds: LfmCreds,
  sessionKey: string,
  meta: NowPlayingMeta,
  transport: LfmTransport = lfmRequest,
): Promise<void> {
  const params: Record<string, string> = {
    artist: meta.artist,
    track: meta.track,
    ...(meta.album ? { album: meta.album } : {}),
    ...(meta.albumArtist ? { albumArtist: meta.albumArtist } : {}),
    ...(meta.duration && meta.duration > 0 ? { duration: String(Math.round(meta.duration)) } : {}),
    ...(meta.trackNumber && meta.trackNumber > 0 ? { trackNumber: String(meta.trackNumber) } : {}),
  }
  const data = await transport(signedCallParams('track.updatenowplaying', params, creds, sessionKey))
  unwrap(data)
}

export async function lfmSetLoved(
  creds: LfmCreds,
  sessionKey: string,
  artist: string,
  track: string,
  loved: boolean,
  transport: LfmTransport = lfmRequest,
): Promise<void> {
  const data = await transport(
    signedCallParams(loved ? 'track.love' : 'track.unlove', { artist, track }, creds, sessionKey),
  )
  unwrap(data)
}

/** The approval page for the desktop auth flow — opened in a browser tab. */
export function lfmAuthUrl(apiKey: string, token: string): string {
  return `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`
}
