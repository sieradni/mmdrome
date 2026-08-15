import { trackMatchesGenre, type LibraryFilterState } from './libraryFilters'
import type { Track, AutoQueueFilters, AutoQueueFilterFields } from '../stores/appState'
import type { LocalMetadataStore } from './db'

/**
 * The pure half of the auto-queue fill (queueManager._buildPool): given a
 * snapshot of queue/library/filter state, decide exactly which tracks the
 * auto queue should hold next. Extracted so the tier admission, the shared-
 * sort ranking, and the anchor rotation are unit-tested without the store
 * writes — `queueManager` is a thin interpreter that applies the returned
 * plan (queue update + saveQueue + queueWrapNotice from the plan's flag).
 *
 * Parity notes (must not drift from the pre-extraction behavior):
 *  - tier 3 (rotation) deliberately admits USER-QUEUED tracks (B4 — a
 *    starvation tradeoff, not a bug);
 *  - the `activeId` (playing track) is excluded from tier 3 only;
 *  - the shuffle branch does NOT permute here — it returns `shuffle: true`
 *    and the caller permutes the FULL pool BEFORE slicing (slicing first
 *    would change the sampled subset);
 *  - `wrapNotice` is false whenever the pool is empty, so a caller's no-op
 *    guard can never leave a stale wrap hint behind.
 */
export interface AutoQueuePlanState {
  library: Track[]
  userQueue: string[]
  autoQueue: string[]
  recentTrackIds: string[]
  /** The currently playing track id (combined[activeIndex]) — rotation-tier exclusion. */
  activeId: string | undefined
  shuffle: boolean
  sort: Pick<LibraryFilterState, 'sortBy' | 'sortAsc'>
  filters: AutoQueueFilters
  meta: Map<string, LocalMetadataStore>
}

export interface AutoQueueFillPlan {
  /** keepAuto replenishes: the queued auto tracks that still match the filters (the kept prefix). */
  kept: string[]
  /** The full ordered candidate pool (tiers 1–3, sorted + anchor-rotated). */
  pool: Track[]
  /** When true, the caller must permute the FULL pool before slicing (shuffle mode). */
  shuffle: boolean
  /** The non-shuffle rotation wrapped back to the top of the sort order (queueWrapNotice). */
  wrapNotice: boolean
}

/**
 * The queue filter predicate: does this track belong in the auto queue under
 * `filters`? Rating/recency come from the metadata cache (unrated = 0); year
 * and length bounds reject tracks with missing values (unknown year fails
 * BOTH fromYear and toYear via the ?? 0 / ?? 9999 fallbacks); album/artist
 * scopes match exactly; genre and search are substring/token matches.
 */
export function matchesAutoQueueFilters(
  track: Track,
  filters: AutoQueueFilters,
  meta: Map<string, LocalMetadataStore>,
): boolean {
  const m = meta.get(track.trackId)
  const r = m?.rating ?? 0
  if (r < filters.minRating || r > filters.maxRating) return false
  if (filters.lovedOnly && !m?.loved) return false

  const fromYear = filters.fromYear !== null && filters.fromYear !== undefined && filters.fromYear !== '' ? Number(filters.fromYear) : null
  const toYear = filters.toYear !== null && filters.toYear !== undefined && filters.toYear !== '' ? Number(filters.toYear) : null
  const minLength = filters.minLength !== null && filters.minLength !== undefined && filters.minLength !== '' ? Number(filters.minLength) : null
  const maxLength = filters.maxLength !== null && filters.maxLength !== undefined && filters.maxLength !== '' ? Number(filters.maxLength) : null

  if (fromYear !== null && (track.year ?? 0) < fromYear) return false
  if (toYear !== null && (track.year ?? 9999) > toYear) return false
  if (minLength !== null && track.duration < minLength) return false
  if (maxLength !== null && track.duration > maxLength) return false

  if (filters.albumScope && track.album !== filters.albumScope) return false
  if (filters.artistScope && track.artist !== filters.artistScope) return false

  if (filters.genre && !trackMatchesGenre(track, filters.genre)) return false

  if (filters.searchQuery) {
    const sq = filters.searchQuery.trim().toLowerCase()
    if (sq) {
      const matches =
        track.title.toLowerCase().includes(sq) ||
        track.artist.toLowerCase().includes(sq) ||
        track.album.toLowerCase().includes(sq) ||
        (track.composer ?? '').toLowerCase().includes(sq)
      if (!matches) return false
    }
  }

  return true
}

/**
 * Rank map for every library track using the shared library-filter sort
 * ordering (the same order shown in the Songs view). When no sort is active,
 * ranks equal the library index (library-order fallback). Tie values are
 * broken by library index so the order is always total and the anchor
 * rotation below is deterministic.
 */
export function buildOrderRank(
  library: Track[],
  sort: Pick<LibraryFilterState, 'sortBy' | 'sortAsc'>,
  meta: Map<string, LocalMetadataStore>,
): Map<string, number> {
  const base = library.map((t, i) => [t, i] as const)
  if (sort.sortBy) {
    base.sort((a, b) => {
      let cmp = 0
      switch (sort.sortBy) {
        case 'rating':
          cmp = (meta.get(a[0].trackId)?.rating ?? 0) - (meta.get(b[0].trackId)?.rating ?? 0)
          break
        case 'loved':
          cmp = Number(meta.get(a[0].trackId)?.loved ?? false) - Number(meta.get(b[0].trackId)?.loved ?? false)
          break
        case 'year':
          cmp = (a[0].year ?? 0) - (b[0].year ?? 0)
          break
        case 'length':
          cmp = a[0].duration - b[0].duration
          break
      }
      if (cmp !== 0) return cmp * (sort.sortAsc ? 1 : -1)
      return a[1] - b[1]
    })
  }
  // The rank value is the SORTED POSITION, not the pre-sort index: the old
  // code mapped `[t, i]` with i = the ORIGINAL library index, so the primary
  // sort was computed and then discarded — the fill stayed in library order
  // under every active sort (B7's documented behavior wasn't wired). The
  // no-sort case is unaffected (sorted position == library index).
  return new Map(base.map(([t], sortedIndex) => [t.trackId, sortedIndex]))
}

/**
 * Rotates a library-position-sorted pool so the first track positioned AFTER
 * the anchor (the last user-queue track) leads, with earlier tracks wrapping
 * to the tail. When the anchor is missing from the library, or the first
 * candidate already follows it, the pool is unchanged. When nothing ranks
 * after the anchor, the pool regenerates from the top — the returned
 * `wrapNotice` lets the UI surface that wrap-around as intentional.
 */
export function rotateAfterAnchor<T extends { trackId: string }>(
  pool: T[],
  libPos: Map<string, number>,
  anchorId: string | undefined,
): { pool: T[]; wrapNotice: boolean } {
  if (!anchorId) return { pool, wrapNotice: false }
  const anchorPos = libPos.get(anchorId)
  if (anchorPos === undefined) return { pool, wrapNotice: false }
  const splitAt = pool.findIndex((t) => (libPos.get(t.trackId) ?? 0) > anchorPos)
  if (splitAt > 0) {
    return { pool: [...pool.slice(splitAt), ...pool.slice(0, splitAt)], wrapNotice: false }
  }
  return { pool, wrapNotice: splitAt < 0 && pool.length > 0 }
}

/**
 * Input validation for the filter panel: inverted ranges can never match a
 * track (min > max fails every candidate), so surface them instead of letting
 * the auto queue silently go empty. One-sided bounds are fine; only a
 * min-over-max pair is invalid.
 */
export function filterRangesValid(f: Pick<AutoQueueFilterFields, 'minRating' | 'maxRating' | 'fromYear' | 'toYear' | 'minLength' | 'maxLength'>): boolean {
  if (f.minRating > f.maxRating) return false
  if (f.fromYear !== '' && f.toYear !== '' && Number(f.fromYear) > Number(f.toYear)) return false
  if (f.minLength !== '' && f.maxLength !== '' && Number(f.minLength) > Number(f.maxLength)) return false
  return true
}

/**
 * The fill decision (the old QueueManager._buildPool): tiers 1–3 admission,
 * then sort + anchor rotation (non-shuffle) or a shuffle marker. `kept` is
 * the still-matching auto prefix for keepAuto replenishes (when the queue is
 * already full of matching tracks the pool build is skipped — the caller's
 * no-op guard needs nothing more, and the wrap hint is false for an empty
 * pool). For rebuilds (`keepAuto: false`) the old auto tracks are ordinary
 * pool members and `kept` is empty.
 */
export function planAutoQueueFill(
  state: AutoQueuePlanState,
  needed: number,
  opts: { keepAuto: boolean },
): AutoQueueFillPlan {
  const { library: lib, userQueue, autoQueue, recentTrackIds, activeId, shuffle, sort, filters, meta } = state
  const inUser = new Set(userQueue)
  // keepAuto: the kept prefix is computed below and the OLD auto queue (not
  // just the kept subset) is excluded from the fill — a non-matching track
  // being dropped cannot re-enter any tier (all tiers require a match).
  const inAuto = new Set(opts.keepAuto ? autoQueue : [])
  const recent = new Set(recentTrackIds)
  const matches = (t: Track) => matchesAutoQueueFilters(t, filters, meta)

  let kept: string[] = []
  if (opts.keepAuto) {
    const libById = new Map(lib.map((t) => [t.trackId, t]))
    kept = autoQueue.filter((id) => {
      const t = libById.get(id)
      return t && matchesAutoQueueFilters(t, filters, meta)
    })
    if (kept.length >= needed) {
      // Queue already full of matching tracks — nothing to fill, and an empty
      // pool means wrapNotice stays false (parity with the old early return).
      return { kept, pool: [], shuffle: false, wrapNotice: false }
    }
  }

  // Tier 1: fresh — matching, not queued anywhere, not cooling down.
  let pool = lib.filter((t) => matches(t) && !inUser.has(t.trackId) && !inAuto.has(t.trackId) && !recent.has(t.trackId))
  // Tier 2: top-up — cooling-down tracks, admitted when the fresh pool is short.
  if (pool.length < needed) {
    pool = pool.concat(lib.filter((t) => matches(t) && !inUser.has(t.trackId) && !inAuto.has(t.trackId) && recent.has(t.trackId)))
  }
  // Tier 3: rotation — every matching track not already sitting in the auto
  // queue and not the actively playing one. Deliberately admits user-queued
  // and recent tracks (B4): the session recycles instead of the queue dying.
  if (pool.length < needed) {
    const poolIds = new Set(pool.map((t) => t.trackId))
    pool = pool.concat(lib.filter((t) => matches(t) && !inAuto.has(t.trackId) && t.trackId !== activeId && !poolIds.has(t.trackId)))
  }

  if (pool.length > 0) {
    if (shuffle) {
      return { kept, pool, shuffle: true, wrapNotice: false }
    }
    const orderRank = buildOrderRank(lib, sort, meta)
    pool.sort((a, b) => (orderRank.get(a.trackId) ?? 0) - (orderRank.get(b.trackId) ?? 0))
    const rotated = rotateAfterAnchor(pool, orderRank, userQueue[userQueue.length - 1])
    return { kept, pool: rotated.pool, shuffle: false, wrapNotice: rotated.wrapNotice }
  }
  return { kept, pool, shuffle: false, wrapNotice: false }
}
