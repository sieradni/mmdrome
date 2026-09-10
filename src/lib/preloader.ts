import { get } from 'svelte/store'
import { settings, currentTrack, queue } from '../stores/appState'
import { emitPreloadEvent, resetLoadStatusForTests } from '../stores/loadStatus'
import { advanceTargetIndex } from './queueMutation'
// NOTE: the preloader deliberately does NOT read effectiveLowData — the LDM
// plan's Principle (docs/plans/2026-09-06, §2) keeps auto-preload ON under
// low data mode: it is bounded to the next few tracks, serialized one-fetch-
// per-tick, and is exactly what makes LDM streaming viable on a marginal
// connection. The 2026-09-06 commit shipped a poll bail against the plan's
// own Principle (its §4 table row 3); corrected 2026-09-07.

const CACHE_NAME = 'mmdrome-preload-cache'
const MAX_CACHE_ENTRIES = 50
/** One fetch per tick: the queue's order IS the priority (the next track must
 *  never wait behind track 5's download on a slow connection), and a tick
 *  cadence of 1 s re-attempts the head after a failure — offline blips and
 *  captive portals self-heal on a later tick without any event wiring. */
const FETCH_TIMEOUT_MS = 15000
/** Non-ok responses are the SERVER's verdict (unlike a fetch exception, which
 *  is the network's) — two of them mark the row dead for the session so one
 *  vanished file can't head-of-line block the whole preload window. */
const NON_OK_DEAD_THRESHOLD = 2

export type TrackUrlResolver = (trackId: string) => string

let getAudioEl: (() => HTMLAudioElement) | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let urlForTrack: TrackUrlResolver | null = null
let unsubCurrentTrack: (() => void) | null = null
let unsubSettings: (() => void) | null = null
let blobUrls: Map<string, string> = new Map()
let preloading = false
/** Per-URL count of NON-OK responses this session; entries past the
 *  threshold move to `deadUrls` and are skipped by every later fill. */
const nonOkFailures: Map<string, number> = new Map()
const deadUrls: Set<string> = new Set()

export function setup(getEl: () => HTMLAudioElement, resolver: TrackUrlResolver): void {
  teardown()
  getAudioEl = getEl
  urlForTrack = resolver

  let prevId: string | null = get(currentTrack)?.trackId ?? null
  unsubCurrentTrack = currentTrack.subscribe(track => {
    if (prevId && track && track.trackId !== prevId && urlForTrack) {
      cleanup(urlForTrack(prevId), prevId)
    }
    prevId = track?.trackId ?? null
  })

  unsubSettings = settings.subscribe(s => {
    const n = s.preloadTracks ?? 0
    const wasRunning = pollTimer !== null
    const shouldRun = n > 0
    if (shouldRun && !wasRunning) {
      pollTimer = setInterval(poll, 1000)
    } else if (!shouldRun && pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  })
}

export function teardown(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (unsubCurrentTrack) { unsubCurrentTrack(); unsubCurrentTrack = null }
  if (unsubSettings) { unsubSettings(); unsubSettings = null }
  getAudioEl = null
  urlForTrack = null
}

/**
 * Cache-first src resolution. A cache HIT returns a blob URL — that track
 * plays fully offline. A MISS returns the ORIGINAL URL: the element still
 * streams (a miss must never hard-fail a load), but over a dead connection
 * it fires the transport's error/retry chain instead of playing silently.
 * The cache key is the exact URL the resolver produces, so this only hits
 * when the preloader warmed THAT url (transcode params included).
 */
export async function resolveSrc(url: string): Promise<string> {
  try {
    const cache = await caches.open(CACHE_NAME)
    const match = await cache.match(url)
    if (match) {
      const old = blobUrls.get(url)
      if (old) URL.revokeObjectURL(old)
      const blob = await match.blob()
      const blobUrl = URL.createObjectURL(blob)
      blobUrls.set(url, blobUrl)
      return blobUrl
    }
  } catch {}
  return url
}

export async function cleanup(url: string, trackId?: string): Promise<void> {
  if (trackId) emitPreloadEvent({ type: 'evict', trackId })
  const old = blobUrls.get(url)
  if (old) { URL.revokeObjectURL(old); blobUrls.delete(url) }
  try {
    const cache = await caches.open(CACHE_NAME)
    await cache.delete(url)
  } catch {}
}

/**
 * A transcode-affecting settings change (mode/format/bitrate/probe fallback)
 * rewrites the stream-URL query, so preloaded entries keyed by the OLD URLs
 * can never match again — dead cache slots the FIFO would only evict after 50
 * new fills. Swept (fire-and-forget) from the manager's transcode-change edge;
 * web-only (the native loader has its own disk cache). No-op without the
 * Cache Storage API (old browsers / Node tests).
 */
export async function sweepStaleTranscodeEntries(): Promise<void> {
  // The store mirrors cache keys by trackId — a param rewrite orphans every
  // entry, so the map resets alongside the cache (never show stale "cached").
  emitPreloadEvent({ type: 'reset' })
  try {
    if (typeof caches === 'undefined') return
    const cache = await caches.open(CACHE_NAME)
    const keys = await cache.keys()
    await Promise.all(keys.map((req) => {
      const u = new URL(req.url)
      // Entries WITHOUT a format param are current raw URLs; entries WITH one
      // are transcode-era keys — stale once the params changed.
      return u.searchParams.has('format') ? cache.delete(req) : Promise.resolve()
    }))
  } catch {}
}

function poll(): void {
  void pollOnce()
}

/** The element holds the whole current file: the range containing the
 *  playhead extends to (metadata) duration − ε. Measured from the PLAYHEAD's
 *  range — a buffered tail behind a gap doesn't count (the element still
 *  fetches the gap when the playhead reaches it). ε covers encoder padding:
 *  metadata duration can exceed the real file by a moment. */
function bufferCoversEnd(el: HTMLAudioElement, metaDur: number): boolean {
  try {
    const b = el.buffered
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= el.currentTime && el.currentTime <= b.end(i)) {
        return b.end(i) >= metaDur - 0.75
      }
    }
  } catch { /* TimeRanges on a torn-down element */ }
  return false
}

/** The poll body, awaitable for tests (the `__setScannerDeps` hook precedent)
 *  — production callers go through `poll` (fire-and-forget). */
async function pollOnce(): Promise<void> {
  const el = getAudioEl?.()
  if (!el || el.paused || preloading || !urlForTrack) return
  const metaDur = get(currentTrack)?.duration ?? 0
  if (!metaDur) return
  const remaining = metaDur - el.currentTime
  // Fill-start policy: near the end (the classic bandwidth-sharing guard) OR
  // as soon as the element has ALREADY buffered the whole current file — full
  // coverage means streaming the current track needs no more bandwidth, so
  // the serialized window fill is free bandwidth and the offline buffer
  // starts minutes earlier than the 30 s rule on connections that download
  // ahead. Browsers that cap their buffer below the file length never
  // satisfy the coverage check and fall back to the time rule.
  if (remaining > 30 && !bufferCoversEnd(el, metaDur)) return

  const n = get(settings).preloadTracks ?? 0
  if (n === 0) return

  await preloadNext(n)
}

/** Test hook: runs the full poll body (gates included) and resolves when the
 *  fill attempt has settled — deterministic tests without timer juggling. */
export function __pollForTests(): Promise<void> {
  return pollOnce()
}

/** Test hook: clears the session-lifetime failure books (production keeps
 *  them for the whole session; tests need per-test isolation). */
export function __resetForTests(): void {
  nonOkFailures.clear()
  deadUrls.clear()
  blobUrls.clear()
  resetLoadStatusForTests()
}

async function enforceCacheLimit(): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME)
    const keys = await cache.keys()
    if (keys.length > MAX_CACHE_ENTRIES) {
      const toDelete = keys.slice(0, keys.length - MAX_CACHE_ENTRIES)
      await Promise.all(toDelete.map(req => {
        const url = req.url
        const old = blobUrls.get(url)
        if (old) { URL.revokeObjectURL(old); blobUrls.delete(url) }
        return cache.delete(req)
      }))
    }
  } catch {}
}

/**
 * Streams a response into the Cache API while reporting byte progress.
 * Progress is HONEST: it reports only when the server sent a Content-Length.
 * Without one (chunked/transcoded streams) the entry stays indeterminate and
 * the UI pulses instead of filling. Non-streamable stubs (tests) and missing
 * bodies fall back to a direct put — the body is never consumed unless the
 * stream branch runs.
 */
async function putWithProgress(
  cache: Cache,
  url: string,
  res: Response,
  report: (progress: number) => void,
): Promise<void> {
  const body = (res as unknown as { body?: unknown }).body as ReadableStream<Uint8Array> | null | undefined
  const lengthRaw = typeof res.headers?.get === 'function' ? res.headers.get('content-length') : null
  const total = lengthRaw !== null ? Number(lengthRaw) : NaN
  const canStream = !!body && typeof body.getReader === 'function' && isFinite(total) && total > 0
  if (!canStream) {
    await cache.put(url, res)
    return
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  let lastReported = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      loaded += value.byteLength
    }
    const p = loaded / (total as number)
    if (p - lastReported >= 0.05 || p >= 1) {
      lastReported = p
      report(Math.min(p, 1))
    }
  }
  const blob = new Blob(chunks as BlobPart[])
  await cache.put(url, new Response(blob, { status: res.status, statusText: res.statusText, headers: res.headers }))
}

/** One serial fetch: the head of the upcoming window, skipping rows already
 *  cached or marked dead. Called once per poll tick, so the queue order becomes
 *  the priority order (the next track fills first) and a failed fetch is
 *  naturally retried by the next tick. Returns the fetched id, or null.
 *
 *  Store mirror: every branch reports the row's preload entry — `done` for
 *  cache hits (this is also how rows cached by an earlier session surface),
 *  `start`/`progress`/`done` across a fetch, `evict` on a retryable failure
 *  (back to queued), `dead` past the strike threshold. */
async function fillOne(
  nextIds: string[],
  cache: Cache,
  resolver: TrackUrlResolver,
): Promise<string | null> {
  for (const id of nextIds) {
    const url = resolver(id)
    if (!url) return null
    if (deadUrls.has(url)) {
      emitPreloadEvent({ type: 'dead', trackId: id })
      continue
    }
    const exists = await cache.match(url)
    if (exists) {
      emitPreloadEvent({ type: 'done', trackId: id })
      continue
    }
    emitPreloadEvent({ type: 'start', trackId: id })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (res.ok) {
        await putWithProgress(cache, url, res, (progress) =>
          emitPreloadEvent({ type: 'progress', trackId: id, progress }),
        )
        nonOkFailures.delete(url)
        emitPreloadEvent({ type: 'done', trackId: id })
        return id
      }
      // The server answered and said no. Count it; past the threshold the row
      // is dead for the session (a vanished/404 file must not block every
      // later row in the window head-of-line). Network EXCEPTIONS never count
      // — those self-heal when the connection returns.
      const fails = (nonOkFailures.get(url) ?? 0) + 1
      nonOkFailures.set(url, fails)
      if (fails >= NON_OK_DEAD_THRESHOLD) {
        deadUrls.add(url)
        emitPreloadEvent({ type: 'dead', trackId: id })
      } else {
        emitPreloadEvent({ type: 'evict', trackId: id })
      }
    } catch {
      // Abort/timeout/network: leave the slot uncached — the next tick's
      // window recomputes (a changed queue just re-ranks the priorities) and
      // retries this row only if it still belongs.
      emitPreloadEvent({ type: 'evict', trackId: id })
    } finally {
      clearTimeout(timer)
    }
    // A non-ok response also stops this tick's fill; the next tick retries
    // (unless the row went dead).
    return null
  }
  return null
}

async function preloadNext(n: number): Promise<void> {
  preloading = true
  try {
    // Bail when playback stopped mid-fill: a paused element means the poll
    // gate would block further work anyway. (Deliberately NO low-data bail:
    // auto-preload stays ON under LDM by plan Principle — the serialized
    // one-fetch-per-tick cadence is the bandwidth control, not a mode gate.)
    const el = getAudioEl?.()
    if (!el || el.paused) return
    const q = get(queue)
    const ids = [...q.userQueue, ...q.autoQueue]
    // Playing-track-aware start (advanceTargetIndex) — the SAME function the
    // crossfade arm uses (playbackManager._setupNextTrack), so the preload
    // never disagrees with it: after an active-row removal the row AT
    // activeIndex IS the next row (the playing track left the queue), and a
    // plain `activeIndex + 1` would warm the cache one PAST the next-to-play
    // row. Normal case: target = activeIndex + 1, identical to the old math.
    const idx = advanceTargetIndex(q, ids, get(currentTrack)?.trackId)
    if (idx < 0 || idx >= ids.length) return
    const nextIds = ids.slice(idx, idx + n)
    if (nextIds.length === 0) return
    const cache = await caches.open(CACHE_NAME)
    const resolver = urlForTrack
    if (!resolver) return
    const filled = await fillOne(nextIds, cache, resolver)
    if (filled) await enforceCacheLimit()
  } catch {} finally {
    preloading = false
  }
}
