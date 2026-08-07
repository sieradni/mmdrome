import { writable } from 'svelte/store'
import type { Track } from '../stores/appState'

export type LibrarySortKey = 'rating' | 'loved' | 'year' | 'length'

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
  genre: '',
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
  let ratedCount = 0
  let lovedCount = 0
  let minYear: number | null = null
  let length = 0
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
  }
  return {
    avgRating: ratedCount > 0 ? sum / ratedCount : 0,
    lovedCount,
    year: minYear,
    length,
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

/**
 * Applies the shared filter/sort to album/artist groups (each group must carry
 * TrackGroupAggregates fields plus its `tracks` array). Returns a new array;
 * input groups are untouched.
 *
 * Rating filtering is any-track based: a group passes when at least one of its
 * tracks falls inside the configured rating range (an unrated track never
 * blocks a group). `avgRating` (computed over rated tracks only) is still used
 * for sorting.
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

  let result = groups.filter((g) => {
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
