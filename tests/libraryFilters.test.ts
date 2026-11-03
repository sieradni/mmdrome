import { test } from 'node:test'
import { sortOf } from '../src/lib/sortCore'
import assert from 'node:assert/strict'
import {
  applyFilterSort,
  distinctGenres,
  makeGroupAggregates,
  type LibraryFilterState,
  type TrackGroupAggregates,
} from '../src/lib/libraryFilters'
import {
  emptyFilterRuleSet,
  type RangeFilterClause,
  type RangeFilterField,
  type TextFilterClause,
  type TextFilterField,
} from '../src/lib/filterCore'
import type { Track } from '../src/stores/appState'

function mkTrack(id: string, over: Partial<Track> = {}): Track {
  return { trackId: id, title: id, artist: 'A', album: 'B', duration: 0, fileType: 'mp3', ...over } as unknown as Track
}

function textClause(field: TextFilterField, query: string): TextFilterClause {
  return { id: `c-${field}`, kind: 'text', field, query }
}

function rangeClause(field: RangeFilterField, min: number | null, max: number | null): RangeFilterClause {
  return { id: `c-${field}`, kind: 'range', field, min, max }
}

function defaults(over: Partial<LibraryFilterState> = {}): LibraryFilterState {
  return {
    filterOpen: false,
    sortOpen: false,
    ...emptyFilterRuleSet(),
    sort: sortOf(null, true),
    ...over,
  }
}

interface G extends TrackGroupAggregates {
  id: string
  tracks: Track[]
}

function group(id: string, tracks: Track[], over: Partial<TrackGroupAggregates> = {}): G {
  return { id, tracks, avgRating: 0, lovedCount: 0, year: null, length: 0, latestAdded: 0, ...over }
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

test('makeGroupAggregates: latestAdded is the newest createdAt, 0 when none dated', () => {
  const g = makeGroupAggregates(
    [mkTrack('a', { createdAt: 1000 }), mkTrack('b', { createdAt: 3000 }), mkTrack('c')],
    () => 0,
    () => false,
  )
  assert.equal(g.latestAdded, 3000)
  assert.equal(makeGroupAggregates([mkTrack('a')], () => 0, () => false).latestAdded, 0)
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

test('applyFilterSort: a genre clause is fuzzy and matches any track in the group', () => {
  const g1 = group('g1', [mkTrack('a'), mkTrack('b', { genre: 'Jazz Fusion' })])
  const g2 = group('g2', [mkTrack('c', { genre: 'Rock' })])
  // "jaz" is a substring; "jazzz" is one edit away from "jazz" — both are
  // fuzzy hits, which is the point of field-scoped fuzzy genre search.
  assert.deepEqual(applyFilterSort([g1, g2], defaults({ clauses: [textClause('genre', 'jaz')] }), () => 0).map((g) => g.id), ['g1'])
  assert.deepEqual(applyFilterSort([g1, g2], defaults({ clauses: [textClause('genre', 'jazzz')] }), () => 0).map((g) => g.id), ['g1'])
  assert.deepEqual(applyFilterSort([g1, g2], defaults({ clauses: [textClause('genre', 'rock')] }), () => 0).map((g) => g.id), ['g2'])
})

test('applyFilterSort: a quoted genre is exact (a typo no longer matches)', () => {
  const g1 = group('g1', [mkTrack('a', { genre: 'Jazz' })])
  assert.deepEqual(applyFilterSort([g1], defaults({ clauses: [textClause('genre', '"jass"')] }), () => 0), [])
  assert.deepEqual(applyFilterSort([g1], defaults({ clauses: [textClause('genre', '"jazz"')] }), () => 0).map((g) => g.id), ['g1'])
})

test('applyFilterSort: year bounds use the group min year; a missing year is excluded by a bound', () => {
  const g1 = group('g1', [mkTrack('a', { year: 2000 })], { year: 2000 })
  const g2 = group('g2', [mkTrack('b', { year: 2010 })], { year: 2010 })
  const g3 = group('g3', [mkTrack('c')], { year: null })
  assert.deepEqual(applyFilterSort([g1, g2], defaults({ clauses: [rangeClause('year', 2005, null)] }), () => 0).map((g) => g.id), ['g2'])
  assert.deepEqual(applyFilterSort([g1, g2], defaults({ clauses: [rangeClause('year', null, 2005)] }), () => 0).map((g) => g.id), ['g1'])
  assert.deepEqual(applyFilterSort([g1], defaults({ clauses: [rangeClause('year', 2001, null)] }), () => 0), [])
  assert.deepEqual(applyFilterSort([g3], defaults({ clauses: [rangeClause('year', 2000, 2010)] }), () => 0), [], 'unknown year cannot satisfy a year bound')
})

test('applyFilterSort: length bounds use the group total', () => {
  const g1 = group('g1', [mkTrack('a', { duration: 100 })], { length: 100 })
  const g2 = group('g2', [mkTrack('b', { duration: 400 })], { length: 400 })
  assert.deepEqual(applyFilterSort([g1, g2], defaults({ clauses: [rangeClause('length', 300, null)] }), () => 0).map((g) => g.id), ['g2'])
  assert.deepEqual(applyFilterSort([g1, g2], defaults({ clauses: [rangeClause('length', null, 300)] }), () => 0).map((g) => g.id), ['g1'])
})

test('applyFilterSort: a date-added clause uses the group latestAdded', () => {
  const g1 = group('g1', [mkTrack('a', { createdAt: 1000 })], { latestAdded: 1000 })
  const g2 = group('g2', [mkTrack('b', { createdAt: 5000 })], { latestAdded: 5000 })
  assert.deepEqual(
    applyFilterSort([g1, g2], defaults({ clauses: [rangeClause('added', 2000, null)] }), () => 0).map((g) => g.id),
    ['g2'],
  )
})

test('applyFilterSort: clauses are ANDed, so every one must match', () => {
  const g1 = group('g1', [mkTrack('a', { genre: 'Jazz', year: 1959 })], { year: 1959 })
  const g2 = group('g2', [mkTrack('b', { genre: 'Jazz', year: 2020 })], { year: 2020 })
  const clauses = [textClause('genre', 'jazz'), rangeClause('year', null, 1969)]
  assert.deepEqual(applyFilterSort([g1, g2], defaults({ clauses }), () => 0).map((g) => g.id), ['g1'])
})

test('applyFilterSort sorts by rating (avg over rated tracks), loved, year, length x asc/desc', () => {
  const groups = [
    group('low', [mkTrack('a')], { avgRating: 20, lovedCount: 1, year: 1999, length: 300 }),
    group('mid', [mkTrack('b')], { avgRating: 50, lovedCount: 2, year: 2005, length: 100 }),
    group('high', [mkTrack('c')], { avgRating: 90, lovedCount: 0, year: 2010, length: 200 }),
  ]
  const byRating = applyFilterSort(groups, defaults({ sort: sortOf('rating', true) }), () => 0).map((g) => g.id)
  assert.deepEqual(byRating, ['low', 'mid', 'high'])
  const byRatingDesc = applyFilterSort(groups, defaults({ sort: sortOf('rating', false) }), () => 0).map((g) => g.id)
  assert.deepEqual(byRatingDesc, ['high', 'mid', 'low'])
  assert.deepEqual(applyFilterSort(groups, defaults({ sort: sortOf('loved', false) }), () => 0).map((g) => g.id), ['mid', 'low', 'high'])
  assert.deepEqual(applyFilterSort(groups, defaults({ sort: sortOf('year', true) }), () => 0).map((g) => g.id), ['low', 'mid', 'high'])
  assert.deepEqual(applyFilterSort(groups, defaults({ sort: sortOf('length', true) }), () => 0).map((g) => g.id), ['mid', 'high', 'low'])
})

test('applyFilterSort sorts by added (latestAdded) x asc/desc', () => {
  const groups = [
    group('old', [mkTrack('a')], { latestAdded: 1000 }),
    group('mid', [mkTrack('b')], { latestAdded: 2000 }),
    group('new', [mkTrack('c')], { latestAdded: 5000 }),
    group('undated', [mkTrack('d')], { latestAdded: 0 }),
  ]
  assert.deepEqual(
    applyFilterSort(groups, defaults({ sort: sortOf('added', true) }), () => 0).map((g) => g.id),
    ['undated', 'old', 'mid', 'new'],
  )
  assert.deepEqual(
    applyFilterSort(groups, defaults({ sort: sortOf('added', false) }), () => 0).map((g) => g.id),
    ['new', 'mid', 'old', 'undated'],
  )
})

test('applyFilterSort returns a new array and never mutates the input', () => {
  const g1 = group('g1', [mkTrack('a')], { avgRating: 10 })
  const input = [g1]
  const result = applyFilterSort(input, defaults({ sort: sortOf('rating', false) }), () => 0)
  assert.notEqual(result, input)
  assert.equal(input.length, 1)
  assert.equal(result.length, 1)
})
