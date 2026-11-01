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

/** Every key the shared library sort may use (random included, 2026-11-01). */
export type LibrarySortKey = SortKey

export { sortLabels }
export type { SortState, SortTier, SortKey } from './sortCore'

export interface LibraryFilterState {
  filterOpen: boolean
  sortOpen: boolean
  minRating: number
  maxRating: number
  lovedOnly: boolean
  genre: string
  fromYear: number | ''
  toYear: number | ''
  minLength: number | ''
  maxLength: number | ''
  /** The TWO-TIER sort stack (primary first) — see `sortCore`. */
  sort: SortState
}

const STORAGE_KEY = 'mmdrome/libraryFilters'

function defaults(): LibraryFilterState {
  return {
    filterOpen: false,
    sortOpen: false,
    minRating: 0,
    maxRating: 100,
    lovedOnly: false,
    genre: '',
    fromYear: '',
    toYear: '',
    minLength: '',
    maxLength: '',
    sort: { ...EMPTY_SORT, tiers: [] },
  }
}

/**
 * The localStorage trust boundary. `sort` is decoded through the shared
 * `normalizeSort` (which also migrates the legacy `{sortBy, sortAsc}` pair a
 * row persisted before 2026-11-01 still holds); the scalar filter fields keep
 * their historical pass-through.
 */
function load(): LibraryFilterState {
  const base = defaults()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<LibraryFilterState> & { sortBy?: SortKey | null; sortAsc?: boolean }
      return { ...base, ...p, sort: normalizeSort(p.sort ?? p) }
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

function toNum(v: number | ''): number | null {
  return v !== null && v !== undefined && v !== '' ? Number(v) : null
}

/**
 * Genre matching is case-insensitive and token-aware: a track matches when its
 * genre string contains the sought value as a whole token (merged genres like
 * "Alt Rock / Indie" still match "Alt Rock"). Empty filter matches everything.
 */
export function trackMatchesGenre(track: Track, genre: string): boolean {
  const g = (genre || '').trim().toLowerCase()
  const t = (track.genre ?? '').toLowerCase()
  if (!g) return true
  if (!t) return false
  return t.split(/[/;,]/).some((token) => token.trim() === g)
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
 * Rating filtering is any-track based: a group passes when at least one of its
 * tracks falls inside the configured rating range (an unrated track never
 * blocks a group). `avgRating` (computed over rated tracks only) is still used
 * for sorting.
 *
 * Sorting is the shared two-tier stack (`sortCore`): tied groups keep their
 * incoming (alphabetical) order — a list never reverses on a direction flip.
 */
export function applyFilterSort<T extends TrackGroupAggregates & { tracks: readonly Track[] }>(
  groups: T[],
  f: LibraryFilterState,
  ratingOf: (trackId: string) => number,
): T[] {
  const fromY = toNum(f.fromYear)
  const toY = toNum(f.toYear)
  const minL = toNum(f.minLength)
  const maxL = toNum(f.maxLength)
  const ratingActive = f.minRating > 0 || f.maxRating < 100

  const result = groups.filter((g) => {
    if (ratingActive) {
      const anyMatch = g.tracks.some((t) => {
        const r = ratingOf(t.trackId)
        return r >= f.minRating && r <= f.maxRating
      })
      if (!anyMatch) return false
    }
    if (f.lovedOnly && g.lovedCount <= 0) return false
    if (f.genre && !g.tracks.some((t) => trackMatchesGenre(t, f.genre))) return false
    if (fromY !== null && (g.year ?? 0) < fromY) return false
    if (toY !== null && (g.year ?? 9999) > toY) return false
    if (minL !== null && g.length < minL) return false
    if (maxL !== null && g.length > maxL) return false
    return true
  })

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
