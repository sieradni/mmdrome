import type { SongLibraryCache } from './db'
import type { NavidromeLoadResult } from './navidromeApi'

export interface CacheUseOptions {
  /** "Connect & Load" forces a live re-pagination even when the cache is valid. */
  forceRefresh?: boolean
  /** The server's lastScan timestamp; when present AND `requireFreshScan` is
   *  set, the cache must match it to be trusted. */
  lastScan?: string
  /** The live server's version (ping.view `serverVersion`); when present, the
   *  cache must carry the SAME version. A server UPGRADE invalidates the
   *  cache even when its lastScan timestamp survived the migration — the
   *  Navidrome 0.64 ID re-encoding rewrote every item id while leaving scan
   *  timestamps alone, so a scan-timestamp-only check would happily serve a
   *  full library of dead ids (every stream/cover/scrobble request 404s).
   *  Offline/failed-load fallbacks leave this unset (the live version is
   *  unknown) — any cached snapshot for this server is the best available. */
  serverVersion?: string
  /** Fresh-cache path (reachable server): a mismatched scan timestamp
   *  invalidates the cache. Offline/failed-load fallbacks leave this unset —
   *  any cached snapshot for this server is the best available. */
  requireFreshScan?: boolean
}

/**
 * Pure D14 cache policy: may the cached song library be served for this
 * connect? The cache belongs to `baseKey` (`baseUrl|username`), must be
 * non-empty, must carry the server's CURRENT version when the live version is
 * known (a server upgrade always invalidates — see `serverVersion`), and — on
 * the fresh path — must match the server's scan timestamp when the server
 * exposes one. `forceRefresh` never invalidates the offline fallback (an
 * unreachable server has nothing fresher to offer).
 */
export function cachedLibraryUsable(cached: SongLibraryCache | undefined, baseKey: string, opts: CacheUseOptions = {}): boolean {
  if (!cached) return false
  if (cached.baseKey !== baseKey) return false
  if (cached.tracks.length === 0) return false
  // Version gate (ALL paths where the live version is known): a legacy cache
  // row (no version recorded) mismatches any known live version, so the
  // first connect after this rule ships performs exactly one full re-sync —
  // which is precisely the migration behavior we want. Strict per
  // point-release: a catalog re-sync is cheap and always safe.
  if (opts.serverVersion !== undefined && cached.serverVersion !== opts.serverVersion) return false
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
