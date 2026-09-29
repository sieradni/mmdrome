import { buildCoverArtUrl, requestableCoverArtId, type NavidromeConfig } from './navidromeApi'
import type { Track } from '../stores/appState'

const urlCache = new Map<string, string>()

export function getCoverUrl(track: Track, config: NavidromeConfig, size: number): string {
  // Key on the full config too: auth token/salt and baseUrl are baked into the
  // URL, so switching servers or credentials must not reuse stale cached URLs.
  const cfgKey = `${config.baseUrl}|${config.username}|${config.password}`
  // Key on the RESOLVED art id, not trackId: the hash suffix changes when the
  // art itself changes (a re-tagged cover), so a key on trackId alone would
  // keep serving the STALE pre-change URL from this cache after a re-sync.
  const artId = requestableCoverArtId(track)
  const key = `${cfgKey}|${artId || `track:${track.trackId}`}-${size}`
  let url = urlCache.get(key)
  if (!url) {
    const id = artId || track.albumId
    if (!id) return ''
    url = buildCoverArtUrl(config, id, size)
    urlCache.set(key, url)
  }
  return url
}

/** The micro-rendition size for the blurred placeholder underlay. Tiny by
 *  design (~1–2 KB served, one extra server resize-cache entry shared by the
 *  whole ladder family) — it exists to paint SOMETHING instantly while the
 *  row's real rendition downloads. */
export const MICRO_COVER_SIZE = 32

/** The blurred-placeholder underlay URL for a track (empty string when the
 *  track has no art id). */
export function microCoverUrl(track: Track, config: NavidromeConfig): string {
  return getCoverUrl(track, config, MICRO_COVER_SIZE)
}

/**
 * Canonical thumbnail sizes, descending — the fallback ladder LazyThumb walks
 * when a larger rendition fails (A13 keeps this list canonical so the server's
 * resize cache is reused). Single source for the ladder so LazyThumb and any
 * future consumer can never disagree on the step order.
 */
export const COVER_FALLBACK_SIZES = [512, 256, 128, 96] as const

/**
 * Pure ladder builder: the FULL ordered list of cover-art URLs to attempt for
 * a requested size — the requested canonical size first, then each smaller
 * canonical size (A13 keeps the list canonical so the server's resize cache is
 * reused). Duplicates removed (a requested non-canonical size rounds down to
 * its canonical ladder via `<=`). Empty when the track has no art id.
 * Failure tracking lives in the caller (DOM state); this stays testable.
 */
export function coverLadderUrls(
  track: Track,
  config: NavidromeConfig,
  requested: number,
): string[] {
  const ladder = COVER_FALLBACK_SIZES.filter((s) => s <= requested)
  const attempts: string[] = []
  for (const s of ladder) {
    const url = getCoverUrl(track, config, s)
    if (url && !attempts.includes(url)) attempts.push(url)
  }
  return attempts
}

// --- Session loaded-URL memory (2026-09-28 ship review) ---------------------
//
// Virtual windows destroy and recreate row components on every scroll hop,
// and LazyThumb's loaded-URL memory was component-lifetime — a remounted row
// could NEVER claim the cached lane, so every revisit after a teleport
// re-requested at fresh pace and re-ran the placeholder choreography, even
// though the cover was an immutable HTTP-cache hit away. This module-level
// LRU gives the claim a SESSION lifetime: `noteCoverLoaded` records every
// successful main-cover onload, and a remounted row whose URL appears here
// arms through the loader's cached lane (frame cadence, no micro wash
// request). Two tracks of one album share the art URL, so the memory also
// dedupes same-album rows for free.

/** Entries kept. ~2000 covers is far beyond any browsing window; eviction
 *  is LRU, so the scroll-back warm set survives while once-seen distant
 *  regions age out. */
export const LOADED_URL_MEMORY_CAP = 2000
const loadedUrlMemory = new Map<string, true>()

/** Record a successful main-cover load (LazyThumb's main-img onload). */
export function noteCoverLoaded(url: string): void {
  if (!url) return
  loadedUrlMemory.delete(url)
  loadedUrlMemory.set(url, true)
  if (loadedUrlMemory.size > LOADED_URL_MEMORY_CAP) {
    const oldest = loadedUrlMemory.keys().next().value
    if (oldest !== undefined) loadedUrlMemory.delete(oldest)
  }
}

/** Whether this cover URL loaded successfully earlier this session. A `true`
 *  answer refreshes the entry's recency — a claimed URL is a wanted URL.
 *  Failed URLs are never recorded (LazyThumb's onload-only contract), so an
 *  error retry re-arms as fresh, exactly as before. */
export function hasCoverBeenLoaded(url: string | null): boolean {
  if (!url) return false
  const hit = loadedUrlMemory.has(url)
  if (hit) {
    loadedUrlMemory.delete(url)
    loadedUrlMemory.set(url, true)
  }
  return hit
}
