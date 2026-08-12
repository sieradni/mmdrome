import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyFilterSort,
  distinctGenres,
  makeGroupAggregates,
  trackMatchesGenre,
  type LibraryFilterState,
  type TrackGroupAggregates,
} from '../src/lib/libraryFilters'
import type { Track } from '../src/stores/appState'

function mkTrack(id: string, over: Partial<Track> = {}): Track {
  return { trackId: id, title: id, artist: 'A', album: 'B', duration: 0, fileType: 'mp3', ...over } as unknown as Track
}

function defaults(over: Partial<LibraryFilterState> = {}): LibraryFilterState {
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
    sortBy: null,
    sortAsc: true,
    ...over,
  }
}

interface G extends TrackGroupAggregates {
  id: string
  tracks: Track[]
}

function group(id: string, tracks: Track[], over: Partial<TrackGroupAggregates> = {}): G {
  return { id, tracks, avgRating: 0, lovedCount: 0, year: null, length: 0, ...over }
}

test('makeGroupAggregates averages only rated tracks', () => {
  const tracks = [mkTrack('a', { duration: 100 }), mkTrack('b', { duration: 200 }), mkTrack('c', { duration: 300 })]
  const g = makeGroupAggregates(
    tracks,
    (id) => (id === 'a' ? 50 : id === 'c' ? 90 : 0),
    () => false,
  )
  assert.equal(g.avgRating, 70)
  assert.equal(g.length, 600)
})

test('makeGroupAggregates: unrated-only group has avg 0; lovedCount and min year are exact', () => {
  const tracks = [mkTrack('a', { year: 2001 }), mkTrack('b', { year: 1999 }), mkTrack('c', { year: 2005 })]
  const g = makeGroupAggregates(tracks, () => 0, (id) => id !== 'b')
  assert.equal(g.avgRating, 0)
  assert.equal(g.lovedCount, 2)
  assert.equal(g.year, 1999)
})

test('makeGroupAggregates: year is null when no track carries one', () => {
  const g = makeGroupAggregates([mkTrack('a')], () => 0, () => false)
  assert.equal(g.year, null)
})

test('trackMatchesGenre is case-insensitive and token-aware', () => {
  const t = mkTrack('a', { genre: 'Alt Rock / Indie' })
  assert.equal(trackMatchesGenre(t, 'alt rock'), true)
  assert.equal(trackMatchesGenre(t, 'Indie'), true)
  assert.equal(trackMatchesGenre(t, 'alt'), false)
  assert.equal(trackMatchesGenre(t, ''), true)
  assert.equal(trackMatchesGenre(mkTrack('b'), 'anything'), false)
})

test('distinctGenres dedupes tokens, trims, and sorts (case preserved)', () => {
  const tracks = [mkTrack('a', { genre: 'Rock; Punk' }), mkTrack('b', { genre: 'Instrumental, Jazz' }), mkTrack('c', { genre: ' Punk ' })]
  assert.deepEqual(distinctGenres(tracks), ['Instrumental', 'Jazz', 'Punk', 'Rock'])
  assert.deepEqual(distinctGenres([]), [])
})

test('applyFilterSort: rating filtering is any-track (an unrated track never blocks)', () => {
  const ratings: Record<string, number> = { a: 80, b: 0, c: 20 }
  const g1 = group('g1', [mkTrack('a'), mkTrack('b')])
  const g2 = group('g2', [mkTrack('c')])
  const g3 = group('g3', [mkTrack('b')])
  const result = applyFilterSort([g1, g2, g3], defaults({ minRating: 50, maxRating: 100 }), (id) => ratings[id] ?? 0)
  assert.deepEqual(result.map((g) => g.id), ['g1'])
})

test('applyFilterSort: a group with only out-of-range tracks fails the rating filter', () => {
  const ratings: Record<string, number> = { a: 10 }
  const result = applyFilterSort([group('g1', [mkTrack('a')])], defaults({ minRating: 50 }), (id) => ratings[id] ?? 0)
  assert.deepEqual(result, [])
})

test('applyFilterSort: lovedOnly keeps groups with at least one loved track', () => {
  const g1 = group('g1', [mkTrack('a')], { lovedCount: 1 })
  const g2 = group('g2', [mkTrack('b')], { lovedCount: 0 })
  const result = applyFilterSort([g1, g2], defaults({ lovedOnly: true }), () => 0)
  assert.deepEqual(result.map((g) => g.id), ['g1'])
})

test('applyFilterSort: genre filter matches any track in the group', () => {
  const g1 = group('g1', [mkTrack('a'), mkTrack('b', { genre: 'Jazz' })])
  const g2 = group('g2', [mkTrack('c', { genre: 'Rock' })])
  const result = applyFilterSort([g1, g2], defaults({ genre: 'jazz' }), () => 0)
  assert.deepEqual(result.map((g) => g.id), ['g1'])
})

test('applyFilterSort: year bounds use the group min year', () => {
  const g1 = group('g1', [mkTrack('a', { year: 2000 })], { year: 2000 })
  const g2 = group('g2', [mkTrack('b', { year: 2010 })], { year: 2010 })
  assert.deepEqual(applyFilterSort([g1, g2], defaults({ fromYear: 2005 }), () => 0).map((g) => g.id), ['g2'])
  assert.deepEqual(applyFilterSort([g1, g2], defaults({ toYear: 2005 }), () => 0).map((g) => g.id), ['g1'])
  assert.deepEqual(applyFilterSort([g1], defaults({ fromYear: 2001 }), () => 0), [])
})

test('applyFilterSort: length bounds use the group total', () => {
  const g1 = group('g1', [mkTrack('a', { duration: 100 })], { length: 100 })
  const g2 = group('g2', [mkTrack('b', { duration: 400 })], { length: 400 })
  assert.deepEqual(applyFilterSort([g1, g2], defaults({ minLength: 300 }), () => 0).map((g) => g.id), ['g2'])
  assert.deepEqual(applyFilterSort([g1, g2], defaults({ maxLength: 300 }), () => 0).map((g) => g.id), ['g1'])
})

test('applyFilterSort sorts by rating (avg over rated tracks), loved, year, length x asc/desc', () => {
  const groups = [
    group('low', [mkTrack('a')], { avgRating: 20, lovedCount: 1, year: 1999, length: 300 }),
    group('mid', [mkTrack('b')], { avgRating: 50, lovedCount: 2, year: 2005, length: 100 }),
    group('high', [mkTrack('c')], { avgRating: 90, lovedCount: 0, year: 2010, length: 200 }),
  ]
  const byRating = applyFilterSort(groups, defaults({ sortBy: 'rating' }), () => 0).map((g) => g.id)
  assert.deepEqual(byRating, ['low', 'mid', 'high'])
  const byRatingDesc = applyFilterSort(groups, defaults({ sortBy: 'rating', sortAsc: false }), () => 0).map((g) => g.id)
  assert.deepEqual(byRatingDesc, ['high', 'mid', 'low'])
  assert.deepEqual(applyFilterSort(groups, defaults({ sortBy: 'loved', sortAsc: false }), () => 0).map((g) => g.id), ['mid', 'low', 'high'])
  assert.deepEqual(applyFilterSort(groups, defaults({ sortBy: 'year' }), () => 0).map((g) => g.id), ['low', 'mid', 'high'])
  assert.deepEqual(applyFilterSort(groups, defaults({ sortBy: 'length' }), () => 0).map((g) => g.id), ['mid', 'high', 'low'])
})

test('applyFilterSort returns a new array and never mutates the input', () => {
  const g1 = group('g1', [mkTrack('a')], { avgRating: 10 })
  const input = [g1]
  const result = applyFilterSort(input, defaults({ sortBy: 'rating', sortAsc: false }), () => 0)
  assert.notEqual(result, input)
  assert.equal(input.length, 1)
  assert.equal(result.length, 1)
})
