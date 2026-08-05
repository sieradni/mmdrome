import { writable } from 'svelte/store'
import type { Track } from '../stores/appState'

export type LibrarySortKey = 'rating' | 'loved' | 'year' | 'length'

export interface LibraryFilterState {
  filterOpen: boolean
  sortOpen: boolean
  minRating: number
  maxRating: number
  lovedOnly: boolean
  fromYear: number | ''
  toYear: number | ''
  minLength: number | ''
  maxLength: number | ''
  sortBy: LibrarySortKey | null
  sortAsc: boolean
}

const STORAGE_KEY = 'mmdrome/libraryFilters'

const defaults: LibraryFilterState = {
  filterOpen: false,
  sortOpen: false,
  minRating: 0,
  maxRating: 100,
  lovedOnly: false,
  fromYear: '',
  toYear: '',
  minLength: '',
  maxLength: '',
  sortBy: null,
  sortAsc: true,
}

function load(): LibraryFilterState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<LibraryFilterState>
      return { ...defaults, ...p }
    }
  } catch {
    /* ignore corrupt saved filters */
  }
  return { ...defaults }
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

export const sortLabels: Record<LibrarySortKey, string> = {
  rating: 'Rating',
  loved: 'Loved',
  year: 'Year',
  length: 'Length',
}

export interface TrackGroupAggregates {
  avgRating: number
  lovedCount: number
  year: number | null
  length: number
}

/** Aggregates a track list into album/artist-level values used by the shared filter/sort. */
export function makeGroupAggregates(
  tracks: readonly Track[],
  ratingOf: (trackId: string) => number,
  lovedOf: (trackId: string) => boolean
): TrackGroupAggregates {
  let sum = 0
  let lovedCount = 0
  let minYear: number | null = null
  let length = 0
  for (const t of tracks) {
    sum += ratingOf(t.trackId)
    if (lovedOf(t.trackId)) lovedCount++
    if (t.year !== undefined && t.year !== null) {
      minYear = minYear === null ? t.year : Math.min(minYear, t.year)
    }
    length += t.duration
  }
  return {
    avgRating: tracks.length > 0 ? sum / tracks.length : 0,
    lovedCount,
    year: minYear,
    length,
  }
}

function toNum(v: number | ''): number | null {
  return v !== null && v !== undefined && v !== '' ? Number(v) : null
}

/**
 * Applies the shared filter/sort to album/artist groups (each group must carry
 * TrackGroupAggregates fields). Returns a new array; input groups are untouched.
 */
export function applyFilterSort<T extends TrackGroupAggregates>(groups: T[], f: LibraryFilterState): T[] {
  const fromY = toNum(f.fromYear)
  const toY = toNum(f.toYear)
  const minL = toNum(f.minLength)
  const maxL = toNum(f.maxLength)

  let result = groups.filter((g) => {
    if (g.avgRating < f.minRating || g.avgRating > f.maxRating) return false
    if (f.lovedOnly && g.lovedCount <= 0) return false
    if (fromY !== null && (g.year ?? 0) < fromY) return false
    if (toY !== null && (g.year ?? 9999) > toY) return false
    if (minL !== null && g.length < minL) return false
    if (maxL !== null && g.length > maxL) return false
    return true
  })

  if (f.sortBy) {
    result = [...result].sort((a, b) => {
      let cmp = 0
      switch (f.sortBy) {
        case 'rating':
          cmp = a.avgRating - b.avgRating
          break
        case 'loved':
          cmp = a.lovedCount - b.lovedCount
          break
        case 'year':
          cmp = (a.year ?? 0) - (b.year ?? 0)
          break
        case 'length':
          cmp = a.length - b.length
          break
      }
      return cmp * (f.sortAsc ? 1 : -1)
    })
  }

  return result
}
