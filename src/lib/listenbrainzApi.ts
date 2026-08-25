/**
 * Stateless ListenBrainz method layer. Unlike Last.fm, ListenBrainz supports
 * CORS and bearer-style tokens (from listenbrainz.org/settings/) — plain
 * `fetch` works on both platforms, no signing, no redirect dance.
 *
 * Hearts: the feedback endpoint keys on recording MBIDs, so a love/unlove is a
 * two-step chain — metadata lookup by artist/track name → feedback submit.
 * A track with no MBID match is skipped gracefully (counted), never an error.
 */

const LB_ROOT = 'https://api.listenbrainz.org'
/** Plain fetch has no default timeout — a stalled connection must not wedge the flush engine. */
const REQUEST_TIMEOUT_MS = 15000

export class ListenBrainzError extends Error {
  readonly status: number
  constructor(status: number, message?: string) {
    super(message ?? `ListenBrainz request failed (HTTP ${status})`)
    this.name = 'ListenBrainzError'
    this.status = status
  }
}

function lbHeaders(token: string): Record<string, string> {
  return { Authorization: `Token ${token}`, 'Content-Type': 'application/json' }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function lbJson(token: string, path: string, init: RequestInit): Promise<unknown> {
  const resp = await fetchWithTimeout(`${LB_ROOT}${path}`, {
    ...init,
    headers: { ...lbHeaders(token), ...(init.headers ?? {}) },
  })
  if (!resp.ok) throw new ListenBrainzError(resp.status)
  return resp.json()
}

export interface LbValidation {
  valid: boolean
  username: string
}

export async function lbValidateToken(token: string): Promise<LbValidation> {
  const data = (await lbJson(token, '/1/validate-token', { method: 'GET' })) as {
    valid?: boolean
    user_name?: string
  }
  return { valid: !!data.valid, username: data.user_name ?? '' }
}

export interface LbListenMeta {
  artist: string
  track: string
  album?: string
  /** Seconds. */
  duration?: number
}

/**
 * Submits one listen. `listenedAtSec` is the unix-seconds moment the listen
 * STARTED; omit it (playingNow) for a now-playing notification.
 */
export async function lbSubmitListen(
  token: string,
  meta: LbListenMeta,
  opts?: { playingNow?: boolean; listenedAtSec?: number },
): Promise<void> {
  const body = {
    listen_type: opts?.playingNow ? 'playing_now' : 'single',
    payload: [
      {
        ...(opts?.playingNow ? {} : { listened_at: Math.floor(opts?.listenedAtSec ?? Date.now() / 1000) }),
        track_metadata: {
          artist_name: meta.artist,
          track_name: meta.track,
          ...(meta.album ? { release_name: meta.album } : {}),
          ...(meta.duration && meta.duration > 0 ? { additional_info: { duration_ms: Math.round(meta.duration * 1000) } } : {}),
        },
      },
    ],
  }
  await lbJson(token, '/1/submit-listens', { method: 'POST', body: JSON.stringify(body) })
}

/** Metadata lookup by name; returns the top recording MBID or null (no match). */
export async function lbLookupRecordingMbid(artist: string, track: string): Promise<string | null> {
  const search = new URLSearchParams({ artist_name: artist, recording_name: track })
  const resp = await fetchWithTimeout(`${LB_ROOT}/1/metadata/lookup?${search.toString()}`, { method: 'GET' })
  if (!resp.ok) throw new ListenBrainzError(resp.status)
  const data = (await resp.json()) as { recording_mbids?: { recording_mbid?: string }[] }
  const first = data.recording_mbids?.[0]?.recording_mbid
  return typeof first === 'string' ? first : null
}

/** score: 1 = love, 0 = remove feedback (the unlove direction). */
export async function lbSubmitFeedback(token: string, mbid: string, score: 1 | 0 | -1): Promise<void> {
  await lbJson(token, '/1/feedback/submit-log', {
    method: 'POST',
    body: JSON.stringify({ recordings: [{ recording_mbid: mbid, score }] }),
  })
}
