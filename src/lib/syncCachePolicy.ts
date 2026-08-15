import type { SongLibraryCache } from './db'
import type { NavidromeLoadResult } from './navidromeApi'

export interface CacheUseOptions {
  /** "Connect & Load" forces a live re-pagination even when the cache is valid. */
  forceRefresh?: boolean
  /** The server's lastScan timestamp; when present AND `requireFreshScan` is
   *  set, the cache must match it to be trusted. */
  lastScan?: string
  /** Fresh-cache path (reachable server): a mismatched scan timestamp
   *  invalidates the cache. Offline/failed-load fallbacks leave this unset —
   *  any cached snapshot for this server is the best available. */
  requireFreshScan?: boolean
}

/**
 * Pure D14 cache policy: may the cached song library be served for this
 * connect? The cache belongs to `baseKey` (`baseUrl|username`), must be
 * non-empty, and — on the fresh path — must match the server's scan timestamp
 * when the server exposes one. `forceRefresh` never invalidates the offline
 * fallback (an unreachable server has nothing fresher to offer).
 */
export function cachedLibraryUsable(cached: SongLibraryCache | undefined, baseKey: string, opts: CacheUseOptions = {}): boolean {
  if (!cached) return false
  if (cached.baseKey !== baseKey) return false
  if (cached.tracks.length === 0) return false
  // Fresh-path semantics only: forceRefresh and scan freshness gate the
  // reachable-server path. Offline/failed-load fallbacks (no opts) accept any
  // snapshot for this server — an unreachable server has nothing fresher.
  if (opts.requireFreshScan) {
    if (opts.forceRefresh) return false
    if (opts.lastScan && cached.lastScan !== opts.lastScan) return false
  }
  return true
}

/**
 * Pure D6 policy (TODO 3.2): may this connect's songs seed rating/loved
 * feedback into the metadata cache? A cached connect carries a stale server
 * snapshot — in `ratingSource: 'navidrome'` mode the server always wins, so
 * re-seeding would clobber local edits (which commit straight to the server
 * and land as `synced`, not `pending_sync`) with the pre-edit values. The
 * persisted Dexie metadata cache is already authoritative for a cached
 * connect, so seeding is skipped for it regardless of rating source.
 */
export function shouldSeedFeedback(loadResult: Partial<NavidromeLoadResult>): boolean {
  return loadResult.cached !== true
}
