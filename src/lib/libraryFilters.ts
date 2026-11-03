import { writable } from 'svelte/store'
import type { Track } from '../stores/appState'
import {
  EMPTY_SORT,
  normalizeSort,
  sortWithTiers,
  sortLabels,
  type SortKey,
  type SortState,
} from './sortCore'
import {
  cloneFilterRuleSet,
  decodeFilterRuleSet,
  emptyFilterRuleSet,
  matchesFilterRuleSetGroup,
  type FilterRuleSet,
} from './filterCore'

/** Every key the shared library sort may use (random included, 2026-11-01). */
export type LibrarySortKey = SortKey

export { sortLabels }
export type { SortState, SortTier, SortKey } from './sortCore'
export type { FilterRuleSet, FilterClause } from './filterCore'

/**
 * The shared library view state: the persisted filter RULE SET (rating range +
 * loved switch + elemental AND clauses — see `filterCore`), the two-tier sort,
 * and the dialog flags (never persisted meaningfully; they always load closed).
 *
 * The old scalar `genre` / `fromYear` / `toYear` / `minLength` / `maxLength`
 * fields are GONE as of 2026-11-03 — they were folded into clauses so every
 * field has one typed editor. `load()` migrates a row that still holds them.
 */
export interface LibraryFilterState extends FilterRuleSet {
  filterOpen: boolean
  sortOpen: boolean
  /** The TWO-TIER sort stack (primary first) — see `sortCore`. */
  sort: SortState
}

const STORAGE_KEY = 'mmdrome/libraryFilters'

function defaults(): LibraryFilterState {
  return {
    filterOpen: false,
    sortOpen: false,
    ...emptyFilterRuleSet(),
    sort: { ...EMPTY_SORT, tiers: [] },
  }
}

/**
 * The localStorage trust boundary. The rule set goes through the shared
 * `decodeFilterRuleSet` (which also migrates the pre-2026-11-03 scalar filter
 * fields into clauses) and the sort through `normalizeSort` (which migrates
 * the legacy `{sortBy, sortAsc}` pair). Dialog flags always load closed.
 */
function load(): LibraryFilterState {
  const base = defaults()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Record<string, unknown> & { sortBy?: SortKey | null; sortAsc?: boolean }
      return {
        ...base,
        ...decodeFilterRuleSet(p),
        sort: normalizeSort(p.sort ?? p),
        filterOpen: false,
        sortOpen: false,
      }
    }
  } catch {
    /* ignore corrupt saved filters */
  }
  return base
}

/**
 * Filter/sort state shared by the Songs, Albums, and Artists views.
 * Persisted to localStorage so it survives tab switches and app restarts.
 */
export const libraryFilters = writable<LibraryFilterState>(load())

libraryFilters.subscribe((s) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* ignore quota errors */
  }
})

export interface TrackGroupAggregates {
  /** Stable identity for the seeded random order (album/artist name). */
  groupKey?: string
  avgRating: number
  lovedCount: number
  year: number | null
  length: number
  /** Newest track's `createdAt` (epoch ms) in the group; 0 when none carry a
   *  date. Lets an album/artist surface by its most recently added track. */
  latestAdded: number
}

/** Aggregates a track list into album/artist-level values used by the shared filter/sort. */
export function makeGroupAggregates(
  tracks: readonly Track[],
  ratingOf: (trackId: string) => number,
  lovedOf: (trackId: string) => boolean,
  groupKey = '',
): TrackGroupAggregates {
  let sum = 0
  let ratedCount = 0
  let lovedCount = 0
  let minYear: number | null = null
  let length = 0
  let latestAdded = 0
  for (const t of tracks) {
    const r = ratingOf(t.trackId)
    if (r > 0) {
      sum += r
      ratedCount++
    }
    if (lovedOf(t.trackId)) lovedCount++
    if (t.year !== undefined && t.year !== null) {
      minYear = minYear === null ? t.year : Math.min(minYear, t.year)
    }
    length += t.duration
    const added = t.createdAt ?? 0
    if (added > latestAdded) latestAdded = added
  }
  return {
    groupKey: groupKey || tracks[0]?.trackId || '',
    avgRating: ratedCount > 0 ? sum / ratedCount : 0,
    lovedCount,
    year: minYear,
    length,
    latestAdded,
  }
}

/** Distinct genres in the library, sorted, with legacy casing trimmed. */
export function distinctGenres(tracks: readonly Track[]): string[] {
  const seen = new Set<string>()
  for (const t of tracks) {
    const g = t.genre
    if (!g) continue
    for (const token of g.split(/[/;,]/)) {
      const trimmed = token.trim()
      if (trimmed) seen.add(trimmed)
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/** The group key comparator (rating/loved/year/length/added aggregates). */
function compareGroupKey(
  key: SortKey,
  a: TrackGroupAggregates,
  b: TrackGroupAggregates,
): number {
  switch (key) {
    case 'rating':
      return a.avgRating - b.avgRating
    case 'loved':
      return a.lovedCount - b.lovedCount
    case 'year':
      return (a.year ?? 0) - (b.year ?? 0)
    case 'length':
      return a.length - b.length
    case 'added':
      return a.latestAdded - b.latestAdded
    default:
      return 0
  }
}

/**
 * Applies the shared filter/sort to album/artist groups (each group must carry
 * TrackGroupAggregates fields plus its `tracks` array). Returns a new array;
 * input groups are untouched.
 *
 * The filter predicate is `filterCore.matchesFilterRuleSetGroup` — the SAME
 * clauses the Songs list and the auto queue use, with the documented group
 * semantics (rating/text = any track, year = earliest, length = total,
 * added = newest). Sorting is the shared two-tier stack (`sortCore`): tied
 * groups keep their incoming (alphabetical) order — a list never reverses on a
 * direction flip.
 */
export function applyFilterSort<T extends TrackGroupAggregates & { tracks: readonly Track[] }>(
  groups: T[],
  f: LibraryFilterState,
  ratingOf: (trackId: string) => number,
  lovedOf: (trackId: string) => boolean = () => false,
): T[] {
  const ctx = { ratingOf, lovedOf }
  const result = groups.filter((g) => matchesFilterRuleSetGroup(g, f, ctx))

  // The arrow wrapper keeps T as the CALLER's group type (passing the
  // comparator directly would widen it to the aggregate base type and drop
  // `album`/`artist` from the result).
  const sorted: T[] = sortWithTiers(result, {
    sort: f.sort,
    cmp: (key, a, b) => compareGroupKey(key, a, b),
    idOf: (g) => g.groupKey ?? g.tracks[0]?.trackId ?? '',
    tie: 'natural',
  })
  return sorted
}

/** Re-exported for callers that only hold a partial rule set (saved views). */
export { cloneFilterRuleSet }
