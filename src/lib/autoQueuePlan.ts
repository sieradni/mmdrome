import type { LibraryFilterState } from './libraryFilters'
import { parseSearchQuery, trackMatchesQuery } from './searchCore'
import {
  cloneFilterRuleSet,
  filterRuleSetsEqual,
  matchesFilterRuleSet,
  type FilterRuleSet,
} from './filterCore'
import {
  isRandomSort,
  normalizeSort,
  sortSignature,
  sortWithTiers,
  trackSortCmp,
  type SortInput,
} from './sortCore'
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
  /** The fill's own sort order — the persisted `autoQueueSort` setting, i.e.
   *  the shared two-tier stack. SHUFFLE IS THIS STACK'S RANDOM KEY (2026-11-01):
   *  there is no separate `shuffle` field, so the setting and the sampling can
   *  never disagree. */
  sort: AutoQueueSort
  /** How many recent plays count as "recent" (the user's window setting). Part
   *  of the ordering RULE for hand-order identity; the caller has already
   *  applied it to `recentTrackIds` (`effectiveRecent`). */
  recentLimit?: number
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

/**
 * Compare a `LibraryFilterState` with the auto-queue's filter/sort settings
 * over the shared-semantics fields. Returns true when an apply would change
 * anything — the visibility predicate for the apply button.
 *
 * Defined AS the plan's non-emptiness (single comparison source — the two
 * predicates can never disagree about whether an apply does something).
 *
 * Deliberately ignored: UI flags (filterOpen/sortOpen) and auto-only fields
 * (searchQuery, session scope). The sort is compared by `sortSignature`, so
 * the random SEED is ignored: two random orders are the same RULE.
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
  filters?: FilterRuleSet
  sort?: AutoQueueSort
}

/**
 * Pure half of the apply button: copy the library filter/sort into the
 * auto-queue settings. Returns ONLY the stores whose values actually differ,
 * so the manager's existing reaction layer picks the right refill semantics
 * for free (filters-only apply → replenish; a sort change → rebuild, or a
 * random-boundary crossing → rebuild without a window reset).
 */
export function planApplyLibraryToAutoQueue(
  lib: LibraryFilterState,
  autoFilters: AutoQueueFilterFields,
  autoSort: AutoQueueSort,
): ApplyLibraryPlan {
  const plan: ApplyLibraryPlan = {}
  if (!filterRuleSetsEqual(lib, autoFilters)) {
    plan.filters = cloneFilterRuleSet(lib)
  }
  if (sortSignature(lib.sort) !== sortSignature(autoSort)) {
    plan.sort = normalizeSort(lib.sort)
  }
  return plan
}

/**
 * The queue filter predicate: does this track belong in the auto queue under
 * `filters`? The rating range, loved switch and every elemental clause are the
 * SHARED `filterCore` predicate (so a genre/artist/year filter means exactly
 * the same thing in the queue as in the library); album/artist scopes match
 * exactly; the search filter is the keyword-token core (`searchCore`) — every
 * whitespace/quoted token must substring-hit one of
 * title/artist/album/composer/albumArtist.
 */
export function matchesAutoQueueFilters(
  track: Track,
  filters: AutoQueueFilters,
  meta: Map<string, LocalMetadataStore>,
): boolean {
  const ctx = {
    ratingOf: (id: string) => meta.get(id)?.rating ?? 0,
    lovedOf: (id: string) => meta.get(id)?.loved ?? false,
  }
  if (!matchesFilterRuleSet(track, filters, ctx)) return false

  if (filters.albumScope && track.album !== filters.albumScope) return false
  if (filters.artistScope && track.artist !== filters.artistScope) return false

  if (filters.searchQuery) {
    const tokens = parseSearchQuery(filters.searchQuery)
    if (tokens.length > 0 && !trackMatchesQuery(track, tokens)) return false
  }

  return true
}

/**
 * Rank map for every library track using the fill's sort ordering (the shared
 * two-tier stack, same comparator the Songs view uses). When no sort is active,
 * ranks equal the library index (library-order fallback).
 *
 * The TIE rule is `mirror`: ties mirror the last tier's arrow, so the order is
 * always total and the anchor rotation below is deterministic, and a fully
 * tied library still answers a direction flip (QUEUE-INVARIANTS E6, the
 * 2026-09-29 "arrow flips but the queue doesn't change" report).
 *
 * A random sort ranks by the seeded per-id hash — the *ordered* branch never
 * runs under random (the fill samples instead), but the rank map stays
 * meaningful for callers that ask for an order anyway.
 */
export function buildOrderRank(
  library: Track[],
  sort: SortInput,
  meta: Map<string, LocalMetadataStore>,
): Map<string, number> {
  const ctx = {
    ratingOf: (id: string) => meta.get(id)?.rating ?? 0,
    lovedOf: (id: string) => meta.get(id)?.loved ?? false,
  }
  const ordered = sortWithTiers(library, {
    sort,
    cmp: (key, a, b) => trackSortCmp(key, a, b, ctx),
    idOf: (t) => t.trackId,
    tie: 'mirror',
  })
  // The rank value is the SORTED POSITION, not the pre-sort index: the old
  // code mapped `[t, i]` with i = the ORIGINAL library index, so the primary
  // sort was computed and then discarded — the fill stayed in library order
  // under every active sort (B7's documented behavior wasn't wired). The
  // no-sort case is unaffected (sorted position == library index).
  return new Map(ordered.map((t, sortedIndex) => [t.trackId, sortedIndex]))
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
 * The fill decision (the old QueueManager._buildPool): tiers 1–3 admission,
 * then sort + anchor rotation (non-random) or a shuffle marker.
 *
 * RANDOM IS THE SORT (2026-11-01): `isRandomSort(state.sort)` decides sampling,
 * so the old separate `shuffle` flag and its store cannot drift. Everything
 * else is unchanged from the ordered-continuation design (2026-10-24):
 * a pressed song, a manual jump or a re-rank re-derives the whole tail; a
 * plain advance keeps it. `pool` holds the ordered candidates AFTER the kept
 * run, so the caller's `kept + selectAutoQueueFill(...)` is always the leading
 * slice of the continuation. `wrapNotice` is false whenever the pool is empty.
 *
 * A HAND-ORDERED tail (a drop the user made — `HandOrder`) outranks the
 * derived order: the tail is the user's own sequence, so it stays verbatim
 * (minus rows that no longer exist or match) and the fill appends AFTER its
 * last row. The intent carries the RULE it was captured under, and
 * `resolveHandOrder` voids it against the live state.
 *
 * RANDOM keeps a SAMPLED prefix on a keepAuto replenish: the kept rows are
 * excluded from admission and only the still-matching ones are retained, so a
 * replenish cannot reshuffle the audible head. The random branch never ranks
 * (its tiers stay in library order for `selectAutoQueueFill` to sample).
 */
/**
 * A hand-ordered auto tail plus the RULE it was captured under (2026-10-24e).
 * The intent is DATA, not a flag: `resolveHandOrder` decides whether it still
 * applies to the live queue, so every rule change or queue replacement voids
 * it by construction — no rebuild path has to remember to clear it.
 */
export interface HandOrder {
  /** The auto tail as the drop left it — the sequence this intent asserts. */
  tail: string[]
  /** `handOrderRule` of the state it was captured under. */
  rule: string
}

/**
 * Identity of the ORDERING RULE: the fields whose change makes a hand order
 * moot. Folded from the objects themselves (keys sorted), so a future filter
 * field is part of the rule automatically — the alternative (an explicit
 * field list) would silently let a new filter keep a stale hand order.
 *
 * The sort participates as its SIGNATURE (tiers + directions, random included,
 * seed excluded) and the recently-played HORIZON participates too: shrinking
 * or growing the window changes which rows the order considers, so it voids a
 * drag just like a filter edit does.
 */
export function handOrderRule(state: Pick<AutoQueuePlanState, 'filters' | 'sort'> & { recentLimit?: number }): string {
  const fold = (o: object) => Object.keys(o).sort().map((k) => [k, (o as Record<string, unknown>)[k] ?? null])
  return JSON.stringify([fold(state.filters), sortSignature(state.sort), state.recentLimit ?? null])
}

/**
 * The hand order the live queue can still honour, or null. Valid only while
 * the rule is unchanged, the auto tail is non-empty, and the tail still STARTS
 * on a row the drop placed. That last part is the replacement check: rows are
 * only ever consumed from the head and appended at the end, so a live head the
 * drop never placed means this is not the user's sequence any more (the tail
 * was rebuilt). Rows removed from inside the tail keep the intent — the
 * documented precedence — so no ordering check is made beyond the head.
 */
export function resolveHandOrder(
  intent: HandOrder | null | undefined,
  state: Pick<AutoQueuePlanState, 'autoQueue' | 'filters' | 'sort' | 'recentLimit'>,
): HandOrder | null {
  if (!intent || intent.tail.length === 0) return null
  if (intent.rule !== handOrderRule(state)) return null
  if (state.autoQueue.length === 0) return null
  if (!intent.tail.includes(state.autoQueue[0])) return null
  return intent
}

export function planAutoQueueFill(
  state: AutoQueuePlanState,
  needed: number,
  opts: { keepAuto: boolean; handOrder?: HandOrder | null },
): AutoQueueFillPlan {
  const { library: lib, userQueue, autoQueue, recentTrackIds, activeId, sort, filters, meta } = state
  // The ONE derivation of "is this a random fill" (2026-11-01).
  const shuffle = isRandomSort(sort)
  const inUser = new Set(userQueue)
  const recent = new Set(recentTrackIds)
  const matches = (t: Track) => matchesAutoQueueFilters(t, filters, meta)

  // Only a RANDOM replenish keeps its already-sampled prefix: the order below
  // it is a permutation, so re-deriving it would reshuffle the audible head on
  // every fill. The old queue (not just the kept subset) is excluded from
  // admission — a non-matching track being dropped cannot re-enter any tier
  // (all tiers require a match). An ordered fill re-derives the order, so
  // there the auto rows are ordinary candidates (inAuto stays empty) and the
  // leading run is computed from that order below.
  const keepsSampledPrefix = shuffle && opts.keepAuto
  const libById = new Map(lib.map((t) => [t.trackId, t]))
  // A tail the user ordered by hand (a drag) is not re-derived: it stays as
  // it is, and the sort only decides what gets appended after it. The intent
  // survives only while the live state still matches what the drop asserted
  // (`resolveHandOrder`); rows that no longer exist or match still drop out.
  const handOrder = !shuffle && opts.keepAuto ? resolveHandOrder(opts.handOrder, state) : null
  const manualTail = handOrder
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

/**
 * D6 repeat pass (QUEUE-DESIGN §2): unique candidates are always admitted
 * first; only when a fill can add NO new id does the tail cycle the rows it
 * already holds. `section` is the auto section AFTER the unique fill (kept
 * prefix + everything this fill added) and `vacancies` what is still missing
 * to reach the target length.
 *
 * The cycle runs over that section in order, from its head, so the repeats are
 * balanced (a 3-row section filling 50 vacancies yields ~17 copies of each
 * rather than 50 copies of the first). This is what makes "the pool is
 * exhausted" mean exactly one thing — the filter matches nothing — and it is
 * what gives repeat-all a single definition (D8): with any match the tail
 * never ends.
 *
 * Each repeat is a real row; callers append these ids verbatim. Empty when
 * there is nothing to cycle (nothing matches) or no vacancy — NEVER invent a
 * row.
 */
export function planRepeatPass(section: readonly string[], vacancies: number): string[] {
  if (section.length === 0 || vacancies <= 0) return []
  const out: string[] = []
  for (let i = 0; i < vacancies; i++) out.push(section[i % section.length])
  return out
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
