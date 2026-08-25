import { md5 } from './md5'

/**
 * Pure Last.fm protocol core: request signing, param assembly, batch/flush
 * planning and the auth-poll decision step. DOM-free and network-free so every
 * invariant below is pinned without a transport (F2); `lastfmTransport.ts` /
 * `lastfmApi.ts` are thin adapters over these builders.
 *
 * Signing rule (Last.fm auth spec): sort params lexicographically by key,
 * concatenate `key + value`, append the shared secret, MD5 → lowercase hex.
 * `format` / `callback` are transport concerns and must be appended AFTER
 * signing — they are deliberately absent from everything this module builds.
 */

export interface LfmCreds {
  apiKey: string
  secret: string
}

export interface LfmSession {
  key: string
  name: string
}

export const AUTH_POLL_INTERVAL_MS = 3000
/** Tokens live 60 min; stop polling well before expiry so the UI can offer a clean retry. */
export const AUTH_POLL_TIMEOUT_MS = 10 * 60 * 1000

/** Queue entry kinds — one Dexie table feeds all outbound destinations.
 *  Heart kinds carry the polarity in the kind itself (the row shape has no
 *  score column): `lfm-love`/`lfm-unlove` → track.love/unlove,
 *  `lb-love`/`lb-unlove` → ListenBrainz feedback score 1/0. */
export type ScrobbleKind = 'lfm-scrobble' | 'lfm-love' | 'lfm-unlove' | 'lb-listen' | 'lb-love' | 'lb-unlove'

/** Kinds whose value decays server-side (Last.fm rejects listens older than ~2 weeks). */
const TIME_SENSITIVE_KINDS: ReadonlySet<string> = new Set(['lfm-scrobble', 'lb-listen'])

/** Give up on an entry after this many failed flush attempts (poison guard). */
export const FLUSH_MAX_ATTEMPTS = 8
/** Safety margin under Last.fm's 14-day rejection cutoff. */
export const FLUSH_MAX_AGE_MS = 13 * 24 * 60 * 60 * 1000
/** track.scrobble hard limit per request. */
export const LFM_SCROBBLE_BATCH_MAX = 50

export function apiSig(params: Record<string, string>, secret: string): string {
  // Default Array.sort is lexicographic by UTF-16 code unit — exactly the order
  // Last.fm specifies. Do NOT replace it with numeric-aware sorting: batch keys
  // like `artist[10]` must sort before `artist[2]`.
  const keys = Object.keys(params).sort()
  let concat = ''
  for (const k of keys) concat += k + params[k]
  return md5(concat + secret)
}

/** Assembles a signed call body: caller's params + method/api_key (+ sk when authenticated). */
export function signedCallParams(
  method: string,
  params: Record<string, string>,
  creds: LfmCreds,
  sessionKey?: string,
): Record<string, string> {
  const base: Record<string, string> = { ...params, method, api_key: creds.apiKey }
  if (sessionKey) base.sk = sessionKey
  return { ...base, api_sig: apiSig(base, creds.secret) }
}

export interface ScrobbleMeta {
  artist: string
  track: string
  album?: string
  albumArtist?: string
  /** Seconds. */
  duration?: number
  trackNumber?: number
  /** Unix seconds — the moment the listen STARTED. */
  timestamp: number
}

/** The subset now-playing needs (no start time). */
export interface NowPlayingMeta extends Omit<ScrobbleMeta, 'timestamp'> {}

/** Flattens listen metadata into the repeated `[i]` array syntax of track.scrobble. */
export function buildScrobbleParams(entries: ScrobbleMeta[]): Record<string, string> {
  const params: Record<string, string> = {}
  entries.forEach((e, i) => {
    params[`artist[${i}]`] = e.artist
    params[`track[${i}]`] = e.track
    params[`timestamp[${i}]`] = String(Math.floor(e.timestamp))
    if (e.album) params[`album[${i}]`] = e.album
    if (e.albumArtist) params[`albumArtist[${i}]`] = e.albumArtist
    if (e.duration && e.duration > 0) params[`duration[${i}]`] = String(Math.round(e.duration))
    if (e.trackNumber && e.trackNumber > 0) params[`trackNumber[${i}]`] = String(e.trackNumber)
  })
  return params
}

export function chunkScrobbles<T>(entries: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < entries.length; i += size) {
    batches.push(entries.slice(i, i + size))
  }
  return batches
}

export interface FlushableEntry {
  kind: ScrobbleKind
  artist: string
  track: string
  album?: string
  albumArtist?: string
  duration?: number
  /** Unix seconds — listen start for time-sensitive kinds, enqueue time otherwise. */
  timestamp: number
  /** Epoch ms — arrival time in the queue (ordering + diagnostics). */
  queuedAt: number
  attempts: number
}

export interface FlushPlan {
  /** Ready-to-submit groups in queue order. */
  batches: FlushableEntry[][]
  /** Indices into the input: expired past the acceptance window (dropped forever). */
  expiredIdx: number[]
  /** Indices into the input: exceeded the attempt cap (poison, dropped forever). */
  droppedIdx: number[]
}

export function planFlush(
  entries: FlushableEntry[],
  opts: { nowMs: number; batchSize?: number; maxAttempts?: number; maxAgeMs?: number },
): FlushPlan {
  const maxAttempts = opts.maxAttempts ?? FLUSH_MAX_ATTEMPTS
  const maxAgeMs = opts.maxAgeMs ?? FLUSH_MAX_AGE_MS
  // Callers that group by kind themselves (the flush engine — request shapes
  // differ per destination) omit batchSize and consume only the partition.
  const plan: FlushPlan = { batches: [], expiredIdx: [], droppedIdx: [] }
  const deliverable: FlushableEntry[] = []
  entries.forEach((e, idx) => {
    if (e.attempts >= maxAttempts) {
      plan.droppedIdx.push(idx)
      return
    }
    if (TIME_SENSITIVE_KINDS.has(e.kind) && opts.nowMs - e.timestamp * 1000 > maxAgeMs) {
      plan.expiredIdx.push(idx)
      return
    }
    deliverable.push(e)
  })
  if (opts.batchSize !== undefined) {
    plan.batches = chunkScrobbles(deliverable, Math.max(1, opts.batchSize))
  }
  return plan
}

export type AuthPollResult = { ok: true; session: LfmSession } | { ok: false; code: number }

export type AuthStep =
  | 'poll'
  | { step: 'done'; session: LfmSession }
  | { step: 'fail'; reason: string }

/**
 * One pure decision per poll tick of the desktop-auth flow. `null` = no call
 * made yet (always poll). Error 14 ("unauthorized token") is EXPECTED while the
 * user hasn't clicked Allow yet — keep polling until the window closes. Any
 * other error is terminal; 15 (denied) gets its own message.
 */
export function nextAuthStep(
  result: AuthPollResult | null,
  elapsedMs: number,
  timeoutMs: number = AUTH_POLL_TIMEOUT_MS,
): AuthStep {
  if (!result) return 'poll'
  if (result.ok) return { step: 'done', session: result.session }
  if (result.code === 14) {
    return elapsedMs < timeoutMs ? 'poll' : { step: 'fail', reason: 'Timed out waiting for authorization' }
  }
  if (result.code === 15) return { step: 'fail', reason: 'Authorization was denied' }
  if (result.code === 26 || result.code === 10) return { step: 'fail', reason: describeLfmError(result.code) }
  return { step: 'fail', reason: describeLfmError(result.code) }
}

/** Human-facing text for Last.fm error codes we act on. */
export function describeLfmError(code: number): string {
  switch (code) {
    case 4: return 'Authentication failed'
    case 9: return 'Session invalid — reconnect Last.fm'
    case 10: return 'Invalid API key'
    case 11: return 'Last.fm service temporarily offline'
    case 13: return 'Request signature rejected'
    case 14: return 'Waiting for authorization…'
    case 15: return 'Authorization denied'
    case 16: return 'Operation failed — try again'
    case 29: return 'Rate limited by Last.fm'
    default: return `Last.fm error ${code}`
  }
}
