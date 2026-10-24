import { trackMatchesGenre, type LibraryFilterState } from './libraryFilters'
import { parseSearchQuery, trackMatchesQuery } from './searchCore'
import type { Track, AutoQueueFilters, AutoQueueFilterFields, AutoQueueSort } from '../stores/appState'
import type { LocalMetadataStore } from './db'

/**
 * The pure half of the auto-queue fill (queueManager._buildPool): given a
 * snapshot of queue/library/filter state, decide exactly which tracks the
 * auto queue should hold next. Extracted so the tier admission, the shared-
 * sort ranking, and the anchor rotation are unit-tested without the store
 * writes — `queueManager` is a thin interpreter that applies the returned
 * plan (queue update + saveQueue + queueWrapNotice from the plan's flag).
 *
 * Fill contract:
 *  - tier 3 (rotation) deliberately admits USER-QUEUED tracks (B4 — a
 *    starvation tradeoff, not a bug);
 *  - the `activeId` (playing track) is excluded from tier 3 only;
 *  - tier admission compares against VACANCIES, not total queue capacity;
 *  - shuffle sampling (`selectAutoQueueFill`) and sort/rotation preserve
 *    tier priority: fresh → cool-down → recycling; shuffle is uniform WITHIN
 *    a full tier before slicing, never across tiers;
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
  /** The audible occurrence's index in `autoQueue`, or -1 when it is a user
   *  row. Between an anchor move and its post-load promotion the audible row
   *  still SITS in auto: an ordered fill must pin the rows up to and including
   *  it (dropping them would shift the anchor off the playing song) and
   *  continue from it. */
  activeAutoIndex: number
  shuffle: boolean
  /** The fill's own sort order — the persisted `autoQueueSort` setting
   *  (structurally the shared `{sortBy, sortAsc}` pair). */
  sort: AutoQueueSort
  filters: AutoQueueFilters
  meta: Map<string, LocalMetadataStore>
}

export interface AutoQueueFillPlan {
  /** keepAuto replenishes: the prefix that stays exactly where it is. Ordered
   *  fill: the leading run the sorted pool still starts with (what the
   *  continuation already has in place). Shuffle: the still-matching sampled
   *  prefix. Empty for a rebuild (`keepAuto: false`). */
  kept: string[]
  /** The candidates the fill may take, in order: tiers 1–3 sorted + rotated
   *  after the anchor (`kept` removed). */
  pool: Track[]
  /** When true, selectAutoQueueFill samples full tiers before slicing. */
  shuffle: boolean
  /** The non-shuffle rotation wrapped back to the top of the sort order (queueWrapNotice). */
  wrapNotice: boolean
  /**
   * Per-TIER membership at pool-build time (2026-09-27): which stage admitted
   * each candidate — tier 1 fresh / tier 2 cool-down / tier 3 rotation.
   * Selection priority AND provenance: the manager mirrors it into `queueProvenance` for the
   * HUD Copy dump (a tier-3-heavy dump is the exhausted-pool signature).
   * Stage arrays are DISJOINT; the anchor rotation reorders but never moves
   * rows between stages, so the tiering stays valid for the sliced fill.
   */
  tiers: { 1: string[]; 2: string[]; 3: string[] }
}

/** A shared-semantics bound arrives as `number | ''` on BOTH models; coerce
 *  both sides through the same `'' ⇔ null` fold so `0` is preserved but empty
 *  and null compare equal (the auto fields may hold null from older rows). */
function boundVal(v: number | '' | null | undefined): number | '' {
  if (v === '' || v === null || v === undefined) return ''
  return Number(v)
}

/**
 * Compare a `LibraryFilterState` with the auto-queue's filter/sort settings
 * over the shared-semantics fields. Returns true when an apply would change
 * anything — the visibility predicate for the apply button.
 *
 * Defined AS the plan's non-emptiness (single comparison source — the two
 * predicates can never disagree about whether an apply does something).
 *
 * Deliberately ignored: UI flags (filterOpen/sortOpen) and auto-only fields
 * (searchQuery, session scope). `sortAsc` is only compared when a sort key is
 * active (with no key, direction is meaningless).
 */
export function autoQueueSettingsDiffer(
  lib: LibraryFilterState,
  autoFilters: AutoQueueFilterFields,
  autoSort: AutoQueueSort,
): boolean {
  const plan = planApplyLibraryToAutoQueue(lib, autoFilters, autoSort)
  return plan.filters !== undefined || plan.sort !== undefined
}

/**
 * The apply plan: which store writes the confirm modal's Apply performs.
 * `filters` is present when the library filter fields differ from the auto
 * filter fields (auto-only fields preserved), `sort` when the shared sort
 * differs. Both absent = nothing to do (the button is hidden in that case).
 */
export interface ApplyLibraryPlan {
  filters?: Omit<AutoQueueFilterFields, 'searchQuery'>
  sort?: AutoQueueSort
}

/**
 * Pure half of the apply button: copy the library filter/sort into the
 * auto-queue settings. Returns ONLY the stores whose values actually differ,
 * so the manager's existing reaction layer picks the right refill semantics
 * for free (filters-only apply → replenish; any sort change → rebuild).
 */
export function planApplyLibraryToAutoQueue(
  lib: LibraryFilterState,
  autoFilters: AutoQueueFilterFields,
  autoSort: AutoQueueSort,
): ApplyLibraryPlan {
  const plan: ApplyLibraryPlan = {}
  const filtersDiffer =
    lib.minRating !== autoFilters.minRating ||
    lib.maxRating !== autoFilters.maxRating ||
    lib.lovedOnly !== autoFilters.lovedOnly ||
    (lib.genre ?? '') !== (autoFilters.genre ?? '') ||
    boundVal(lib.fromYear) !== boundVal(autoFilters.fromYear) ||
    boundVal(lib.toYear) !== boundVal(autoFilters.toYear) ||
    boundVal(lib.minLength) !== boundVal(autoFilters.minLength) ||
    boundVal(lib.maxLength) !== boundVal(autoFilters.maxLength)
  if (filtersDiffer) {
    plan.filters = {
      minRating: lib.minRating,
      maxRating: lib.maxRating,
      lovedOnly: lib.lovedOnly,
      genre: lib.genre,
      fromYear: lib.fromYear,
      toYear: lib.toYear,
      minLength: lib.minLength,
      maxLength: lib.maxLength,
    }
  }
  const sortDiffers = lib.sortBy !== autoSort.sortBy || (lib.sortBy !== null && lib.sortAsc !== autoSort.sortAsc)
  if (sortDiffers) {
    plan.sort = { sortBy: lib.sortBy, sortAsc: lib.sortAsc }
  }
  return plan
}

/**
 * The queue filter predicate: does this track belong in the auto queue under
 * `filters`? Rating/recency come from the metadata cache (unrated = 0); year
 * and length bounds reject tracks with missing values (unknown year fails
 * BOTH fromYear and toYear via the ?? 0 / ?? 9999 fallbacks); album/artist
 * scopes match exactly; genre is a shared token match; the search filter is
 * the keyword-token core (`searchCore`) — every whitespace/quoted token must
 * substring-hit one of title/artist/album/composer/albumArtist.
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
    const tokens = parseSearchQuery(filters.searchQuery)
    if (tokens.length > 0 && !trackMatchesQuery(track, tokens)) return false
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
        case 'added':
          cmp = (a[0].createdAt ?? 0) - (b[0].createdAt ?? 0)
          break
      }
      if (cmp !== 0) return cmp * (sort.sortAsc ? 1 : -1)
      // Ties MIRROR the arrow (2026-09-29, the "arrow flips but the queue
      // doesn't change" report): an unrated/unloved library ties on every
      // comparison, and the old fixed library-index tie-break made the
      // direction a no-op — the whole order must answer the arrow.
      return sort.sortAsc ? a[1] - b[1] : b[1] - a[1]
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
 * then sort + anchor rotation (non-shuffle) or a shuffle marker.
 *
 * NON-SHUFFLE is an ORDERED CONTINUATION (2026-10-24): the auto rows are
 * ordinary candidates of the same filtered+sorted set, the tiers are ranked
 * and rotated after the anchor (the user-queue tail — the point playback is
 * headed from), and `kept` is the leading run of the current auto queue that
 * this order still starts with. A pressed song, a manual jump or a re-rank
 * therefore re-derives the whole tail; a plain advance keeps it (the consumed
 * head was the next ordered row, so the remainder is still the continuation).
 * `pool` then holds the ordered candidates AFTER that run, so the caller's
 * `kept + selectAutoQueueFill(...)` always equals the leading slice of the
 * continuation. `wrapNotice` is false whenever the pool is empty.
 *
 * A HAND-ORDERED tail (`respectManualOrder`, set while a drag order is in
 * effect) outranks the derived order: the tail is the user's own sequence, so
 * it stays verbatim (minus rows that no longer exist or match) and the fill
 * appends AFTER its last row. The caller clears that intent on a rule change,
 * which is what lets a new filter/sort win (2026-10-25).
 *
 * SHUFFLE keeps a SAMPLED prefix on a keepAuto replenish: the kept rows are
 * excluded from admission and only the still-matching ones are retained, so a
 * replenish cannot reshuffle the audible head. The shuffle branch never ranks
 * (its tiers stay in library order for `selectAutoQueueFill` to sample).
 */
export function planAutoQueueFill(
  state: AutoQueuePlanState,
  needed: number,
  opts: { keepAuto: boolean; respectManualOrder?: boolean },
): AutoQueueFillPlan {
  const { library: lib, userQueue, autoQueue, recentTrackIds, activeId, shuffle, sort, filters, meta } = state
  const inUser = new Set(userQueue)
  const recent = new Set(recentTrackIds)
  const matches = (t: Track) => matchesAutoQueueFilters(t, filters, meta)

  // Only a SHUFFLE replenish keeps its already-sampled prefix: the order below
  // it is a permutation, so re-deriving it would reshuffle the audible head on
  // every fill. The old queue (not just the kept subset) is excluded from
  // admission — a non-matching track being dropped cannot re-enter any tier
  // (all tiers require a match). A non-shuffle fill re-derives the order, so
  // there the auto rows are ordinary candidates (inAuto stays empty) and the
  // leading run is computed from that order below.
  const keepsSampledPrefix = shuffle && opts.keepAuto
  const libById = new Map(lib.map((t) => [t.trackId, t]))
  // A tail the user ordered by hand (a drag) is not re-derived: it stays as
  // it is, and the sort only decides what gets appended after it. Rows that
  // no longer exist or match the filters still drop out (a filter edit is a
  // rule change that clears the intent anyway — this is the safe backstop).
  const manualTail = !shuffle && opts.keepAuto && opts.respectManualOrder
    ? autoQueue.filter((id) => {
        const t = libById.get(id)
        return t !== undefined && matches(t)
      })
    : []
  // The audible auto occurrence (and whatever sits above it) is PINNED for an
  // ordered replenish: it is still in auto until the post-load promotion
  // appends it, and re-deriving the tail under it would move the anchor off
  // the playing row. The continuation then starts AFTER it. A hand-ordered
  // tail needs no extra pin — it already carries every row, the audible one
  // included.
  const pinnedHead = manualTail.length === 0 && !shuffle && opts.keepAuto && state.activeAutoIndex >= 0 && state.activeAutoIndex < autoQueue.length
    ? autoQueue.slice(0, state.activeAutoIndex + 1)
    : []
  const anchorId = manualTail.length > 0
    ? manualTail[manualTail.length - 1]
    : pinnedHead.length > 0 ? activeId : userQueue[userQueue.length - 1]
  const inAuto = new Set(keepsSampledPrefix ? autoQueue : manualTail.length > 0 ? manualTail : pinnedHead)

  let kept: string[] = []
  if (keepsSampledPrefix) {
    kept = autoQueue.filter((id) => {
      const t = libById.get(id)
      return t && matches(t)
    })
    if (kept.length >= needed) {
      // Queue already full of matching tracks — nothing to fill, and an empty
      // pool means wrapNotice stays false (parity with the old early return).
      return { kept, pool: [], shuffle: false, wrapNotice: false, tiers: { 1: [], 2: [], 3: [] } }
    }
  }

  const vacancies = Math.max(0, needed - kept.length)
  // Tier 1: fresh — matching, not queued anywhere, not cooling down.
  let pool = lib.filter((t) => matches(t) && !inUser.has(t.trackId) && !inAuto.has(t.trackId) && !recent.has(t.trackId))
  const tier1 = pool.map((t) => t.trackId)
  // Tier 2: top-up — cooling-down tracks, admitted when the fresh pool is short.
  let tier2: string[] = []
  if (pool.length < vacancies) {
    const tier2Rows = lib.filter((t) => matches(t) && !inUser.has(t.trackId) && !inAuto.has(t.trackId) && recent.has(t.trackId))
    tier2 = tier2Rows.map((t) => t.trackId)
    pool = pool.concat(tier2Rows)
  }
  // Tier 3: rotation — every matching track not already sitting in the auto
  // queue and not the actively playing one. Deliberately admits user-queued
  // and recent tracks (B4): the session recycles instead of the queue dying.
  let tier3: string[] = []
  if (pool.length < vacancies) {
    const poolIds = new Set(pool.map((t) => t.trackId))
    const tier3Rows = lib.filter((t) => matches(t) && !inAuto.has(t.trackId) && t.trackId !== activeId && !poolIds.has(t.trackId))
    tier3 = tier3Rows.map((t) => t.trackId)
    pool = pool.concat(tier3Rows)
  }

  if (pool.length > 0) {
    if (shuffle) {
      return { kept, pool, shuffle: true, wrapNotice: false, tiers: { 1: tier1, 2: tier2, 3: tier3 } }
    }
    const orderRank = buildOrderRank(lib, sort, meta)
    // Sort/rotate WITHIN each priority tier. Recycling must never overtake a
    // fresh candidate merely because its rating or library position is earlier.
    const byId = new Map(pool.map((t) => [t.trackId, t]))
    let wrapNotice = false
    let orderedHeadUnset = true
    const ordered = [tier1, tier2, tier3].flatMap((ids) => {
      const rows = ids.map((id) => byId.get(id)!)
      rows.sort((a, b) => (orderRank.get(a.trackId) ?? 0) - (orderRank.get(b.trackId) ?? 0))
      const rotated = rotateAfterAnchor(rows, orderRank, anchorId)
      if (rows.length > 0 && orderedHeadUnset) {
        wrapNotice = rotated.wrapNotice
        orderedHeadUnset = false
      }
      return rotated.pool
    })
    // The ordered list is the ONE owner of the fill order: keep the leading
    // run the current auto queue still shares with it (nothing, once the anchor
    // moved or the order changed) and hand the caller everything after that
    // run. `kept + selectAutoQueueFill(...)` is therefore always the leading
    // slice of the continuation.
    if (manualTail.length > 0) {
      // The user's sequence wins: keep it whole and append the ordered
      // candidates after it (`needed` slices the head of `pool`).
      return { kept: manualTail, pool: ordered, shuffle: false, wrapNotice, tiers: { 1: tier1, 2: tier2, 3: tier3 } }
    }
    const orderedIds = ordered.map((t) => t.trackId)
    const queuedTail = autoQueue.slice(pinnedHead.length)
    const keepable = opts.keepAuto ? leadingRun(queuedTail, orderedIds) : 0
    kept = [...pinnedHead, ...orderedIds.slice(0, keepable)]
    return { kept, pool: ordered.slice(keepable), shuffle: false, wrapNotice, tiers: { 1: tier1, 2: tier2, 3: tier3 } }
  }
  const fallbackKept = manualTail.length > 0 ? manualTail : pinnedHead
  return { kept: keepsSampledPrefix ? kept : fallbackKept, pool, shuffle: false, wrapNotice: false, tiers: { 1: tier1, 2: tier2, 3: tier3 } }
}

/** Longest leading run where the queued rows still equal `ordered`, one by one
 *  — the kept prefix of an ordered-continuation fill (0 = nothing is in place). */
function leadingRun(queued: string[], ordered: string[]): number {
  let i = 0
  while (i < queued.length && i < ordered.length && queued[i] === ordered[i]) i++
  return i
}

/** Uniform sampling within each tier, strict priority across tiers. Injectable
 * randomness keeps selection deterministic in tests; never mutate a plan. */
export function selectAutoQueueFill(plan: AutoQueueFillPlan, count: number, random: () => number = Math.random): Track[] {
  if (!plan.shuffle) return plan.pool.slice(0, count)
  const byId = new Map(plan.pool.map((t) => [t.trackId, t]))
  const selected: Track[] = []
  for (const tier of [1, 2, 3] as const) {
    if (selected.length >= count) break
    const rows = plan.tiers[tier].map((id) => byId.get(id)!)
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[rows[i], rows[j]] = [rows[j], rows[i]]
    }
    selected.push(...rows.slice(0, count - selected.length))
  }
  return selected
}
