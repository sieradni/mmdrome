/**
 * Lyrics orchestration — the thin, injectable glue between the pure
 * `lyricsCore` model and the world (Navidrome API, Dexie).
 *
 * Contract (pinned by tests/lyricsService.test.ts):
 * - Navidrome tracks ONLY (`navidrome-` prefix — the same gate as scrobbling).
 * - A module generation counter guards every load: rapid skips never race, a
 *   stale response never overwrites a newer track's state (preloader/scanner
 *   pattern).
 * - In-flight dedupe: a second request for the same track reuses the promise.
 * - Dexie persistence with a NEGATIVE-cache TTL: lyric-less tracks record a
 *   null doc; re-plays skip the network until the TTL lapses (newly added
 *   server lyrics surface then). Positive rows live until evicted.
 * - Network failures are NOT negative-cached (a dead connection must not
 *   poison the row for a week) — the next play retries.
 * - Cache cap: oldest-fetched eviction keeps the table bounded.
 */
import { writable } from 'svelte/store'
import { db } from './db'
import { getCachedConfig, getLyricsBySongId } from './navidromeApi'
import { credentialsHealthy, authBaseKey } from './authHealth'
import {
  deriveLineEnds,
  normalizeStructuredLyrics,
  lyricsFromPlainText,
  pickLyricsVariant,
  parseLrc,
  type LyricDoc,
  type RawStructuredLyrics,
} from './lyricsCore'

/** Tracks without lyrics re-probe the server after this long. */
export const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Max cached rows (positive + negative). Worst case ≈ 1 MB. */
export const LYRICS_CACHE_CAP = 500

export interface LyricsState {
  trackId: string | null
  doc: LyricDoc | null
  /** Server had no lyrics for the current track. */
  unavailable: boolean
  loading: boolean
}

/** The store the view renders. `loadLyricsForTrack` is its only writer. */
export const lyricsState = writable<LyricsState>({ trackId: null, doc: null, unavailable: false, loading: false })

interface LyricsDeps {
  /** Overridable clock for TTL tests. */
  now: () => number
  fetcher: (config: { baseUrl: string; username: string; password: string }, songId: string) => Promise<RawStructuredLyrics[] | null>
}

const defaultDeps: LyricsDeps = {
  now: () => Date.now(),
  fetcher: (config, songId) => getLyricsBySongId(config, songId),
}

let deps: LyricsDeps = { ...defaultDeps }

/** Test seam: swap the clock/fetcher (call with no args to restore defaults). */
export function __setLyricsDepsForTests(next?: Partial<LyricsDeps>): void {
  deps = { ...defaultDeps, ...next }
}

interface CacheRow {
  trackId: string
  /** Null = NEGATIVE row (checked, server has none). */
  doc: LyricDoc | null
  fetchedAt: number
}

async function readCache(trackId: string): Promise<CacheRow | undefined> {
  try {
    return await db.lyricsCache.get(trackId)
  } catch {
    return undefined
  }
}

async function writeCache(row: CacheRow): Promise<void> {
  try {
    await db.lyricsCache.put(row)
    await evictOverflow()
  } catch {
    /* cache is best-effort */
  }
}

/** Keeps the table bounded: drop the OLDEST rows past the cap; negative rows
 *  evict first (they carry the least value). */
async function evictOverflow(): Promise<void> {
  const rows = await db.lyricsCache.toArray()
  if (rows.length <= LYRICS_CACHE_CAP) return
  const negative = rows.filter((r) => r.doc === null).sort((a, b) => a.fetchedAt - b.fetchedAt)
  const positive = rows.filter((r) => r.doc !== null).sort((a, b) => a.fetchedAt - b.fetchedAt)
  const overflow = rows.length - LYRICS_CACHE_CAP
  const victims = [...negative.slice(0, overflow), ...positive.slice(0, Math.max(0, overflow - negative.length))]
  if (victims.length > 0) await db.lyricsCache.bulkDelete(victims.map((r) => r.trackId))
}

/** Parses one raw variant list into a LyricDoc, or null when empty. */
function toDoc(raws: RawStructuredLyrics[] | null): LyricDoc | null {
  const chosen = pickLyricsVariant(raws ?? [])
  if (!chosen) return null
  if (chosen.synced === true) return normalizeStructuredLyrics(chosen)

  // Unsynced payload. Some taggers stuff an LRC blob into an unsynced
  // container — if the text carries timestamps, parse it as LRC (synced).
  const flat = (chosen.line ?? []).map((l) => l.value ?? '').join('\n')
  if (/\[\d{1,3}:\d{1,2}/.test(flat)) {
    const parsed = parseLrc(flat)
    if (parsed.length > 0) return { synced: true, lines: parsed }
  }
  const doc = normalizeStructuredLyrics(chosen)
  if (doc) return doc
  return flat.trim().length > 0 ? lyricsFromPlainText(flat) : null
}

let loadGeneration = 0
const inFlight = new Map<string, Promise<LyricDoc | null>>()

/**
 * Resolves lyrics for a Navidrome track: cache (with negative TTL) → network.
 * Never throws; returns the doc, or null when unavailable. `durationMs` (the
 * A1-effective duration, when known) is used to derive the last line's end.
 */
export async function getLyricsForTrack(trackId: string, durationMs: number | null): Promise<LyricDoc | null> {
  if (!trackId.startsWith('navidrome-')) return null
  const config = getCachedConfig()
  if (!config) return null
  // Auth-health gate: rejected credentials re-probing every play is exactly
  // the spam the ledger exists to stop (the doc stays a cache miss).
  if (!credentialsHealthy(authBaseKey(config.baseUrl, config.username))) return null

  const cached = await readCache(trackId)
  if (cached) {
    const isPositive = cached.doc !== null
    const freshEnough = isPositive || deps.now() - cached.fetchedAt < NEGATIVE_TTL_MS
    if (freshEnough && cached.doc) {
      // Clone before re-deriving: the cached row keeps its stored shape.
      const doc: LyricDoc = { ...cached.doc, lines: cached.doc.lines.map((l) => ({ ...l })) }
      if (doc.synced) deriveLineEnds(doc.lines, durationMs)
      return doc
    }
    if (freshEnough) return null
  }

  const existing = inFlight.get(trackId)
  if (existing) return existing

  const serverId = trackId.slice('navidrome-'.length)
  const promise = (async () => {
    try {
      const raws = await deps.fetcher(config, serverId)
      const doc = toDoc(raws)
      if (doc?.synced) deriveLineEnds(doc.lines, durationMs)
      await writeCache({ trackId, doc, fetchedAt: deps.now() })
      return doc
    } catch {
      // Network/parse failure: NOT negative-cached — retry next play.
      return null
    } finally {
      inFlight.delete(trackId)
    }
  })()
  inFlight.set(trackId, promise)
  return promise
}

export interface LoadOptions {
  /** A1-effective duration in SECONDS, when known. */
  duration?: number
}

/**
 * Loads lyrics for the given track and publishes them to `lyricsState`.
 * The view calls this from its track-change effect (fire-and-forget).
 */
export function loadLyricsForTrack(trackId: string, opts: LoadOptions = {}): void {
  const gen = ++loadGeneration
  const durationMs = opts.duration != null ? Math.round(opts.duration * 1000) : null

  if (!trackId.startsWith('navidrome-') || !getCachedConfig()) {
    lyricsState.set({ trackId, doc: null, unavailable: false, loading: false })
    return
  }

  lyricsState.set({ trackId, doc: null, unavailable: false, loading: true })
  void getLyricsForTrack(trackId, durationMs)
    .then((doc) => {
      if (gen !== loadGeneration) return
      lyricsState.set({ trackId, doc, unavailable: doc === null, loading: false })
    })
    .catch(() => {
      if (gen !== loadGeneration) return
      lyricsState.set({ trackId, doc: null, unavailable: true, loading: false })
    })
}
