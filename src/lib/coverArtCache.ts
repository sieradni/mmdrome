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
