import type { SongLibraryCache } from './db'

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
