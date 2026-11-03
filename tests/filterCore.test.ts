// Pins the shared filter model (2026-11-03): typed field registry, dual-range
// clause semantics, fuzzy field text with quoted exactness, the elemental AND,
// the album/artist group projection, the reducers and the decode/migration
// trust boundary. Every library view, the auto queue and both dialogs read
// this module, so these are the rules those surfaces cannot drift from.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADDABLE_FILTER_FIELDS,
  DAY_MS,
  FILTER_FIELD_SPECS,
  MAX_FILTER_CLAUSES,
  addFilterClause,
  addedBoundsOf,
  clearFilterRuleSet,
  decodeFilterClauses,
  decodeFilterRuleSet,
  emptyFilterRuleSet,
  filterRuleSetActive,
  filterRuleSetSignature,
  filterRuleSetsEqual,
  filterTextMatches,
  formatDuration,
  matchesFilterRuleSet,
  parseFilterText,
  rangeDomain,
  rangeValueMatches,
  removeFilterClause,
  replaceFilterClause,
  setRangeClause,
  textValueMatches,
  type FilterRuleSet,
  type RangeFilterClause,
} from '../src/lib/filterCore'
import type { Track } from '../src/stores/appState'

const track = (id: string, over: Partial<Track> = {}): Track => ({
  trackId: id,
  title: `T${id}`,
  artist: 'Artist A',
  album: 'Album X',
  duration: 100,
  fileType: 'mp3',
  ...over,
})

const ctx = (ratings: Record<string, number> = {}, loved: string[] = []) => ({
  ratingOf: (id: string) => ratings[id] ?? 0,
  lovedOf: (id: string) => loved.includes(id),
})

const range = (field: RangeFilterClause['field'], min: number | null, max: number | null): RangeFilterClause => ({
  id: `c-${field}`,
  kind: 'range',
  field,
  min,
  max,
})

// ── field registry ─────────────────────────────────────────────────────

test('the registry offers every sortable/filterable field, with typed editors', () => {
  // Everything the old UI could filter (genre/year/length) plus every text
  // identity field and date-added; rating/loved stay permanently visible.
  for (const field of ['genre', 'artist', 'album', 'title', 'albumArtist', 'composer', 'year', 'length', 'added']) {
    assert.ok(ADDABLE_FILTER_FIELDS.includes(field as never), `${field} is addable`)
  }
  assert.equal(ADDABLE_FILTER_FIELDS.includes('rating' as never), false, 'rating is permanent, never duplicated in the picker')
  assert.equal(ADDABLE_FILTER_FIELDS.includes('loved' as never), false, 'loved is permanent')
  assert.equal(FILTER_FIELD_SPECS.genre.kind, 'text')
  assert.equal(FILTER_FIELD_SPECS.year.kind, 'range')
  assert.equal(FILTER_FIELD_SPECS.added.kind, 'range')
})

test('range domains span the maximum possible value rather than the current data', () => {
  assert.deepEqual(rangeDomain('rating'), { min: 0, max: 100, step: 10 })
  assert.deepEqual(rangeDomain('year'), { min: 1900, max: 2100, step: 1 })
  assert.deepEqual(rangeDomain('length'), { min: 0, max: 21600, step: 5 })
})

test('the date-added domain is anchored to the library and always reaches today', () => {
  const now = Date.parse('2026-06-15T12:00:00Z')
  const dom = rangeDomain('added', { now, addedMin: Date.parse('2024-02-15T00:00:00Z'), addedMax: Date.parse('2025-01-05T00:00:00Z') })
  assert.equal(dom.step, DAY_MS)
  assert.equal(dom.min, Date.parse('2024-02-15T00:00:00Z'), 'starts at the earliest added track')
  assert.ok(dom.max >= now, 'the domain reaches today, not just the newest stored track')
  // An empty library still yields a usable 5-year window.
  const empty = rangeDomain('added', { now })
  assert.equal(empty.max, Math.ceil(now / DAY_MS) * DAY_MS)
  assert.ok(empty.min < empty.max)
})

test('addedBoundsOf: min/max of dated tracks only, zeros for an undated library', () => {
  assert.deepEqual(addedBoundsOf([track('a', { createdAt: 500 }), track('b', { createdAt: 100 }), track('c')]), { min: 100, max: 500 })
  assert.deepEqual(addedBoundsOf([]), { min: 0, max: 0 })
})

test('formatDuration renders mm:ss and h:mm:ss', () => {
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(75), '1:15')
  assert.equal(formatDuration(3675), '1:01:15')
})

// ── fuzzy text + quotes ────────────────────────────────────────────────

test('parseFilterText: bare runs are fuzzy, quoted spans are exact, empty folds drop', () => {
  const tokens = parseFilterText('"indie rock" stone')
  assert.deepEqual(tokens, [
    { text: 'indie rock', exact: true },
    { text: 'stone', exact: false },
  ])
  assert.deepEqual(parseFilterText('!!!'), [])
  assert.deepEqual(parseFilterText(''), [])
  assert.deepEqual(parseFilterText('"Don\'t Stop"'), [{ text: 'dont stop', exact: true }], 'folding still applies inside quotes')
})

test('fuzzy tokens tolerate a typo and an in-order abbreviation', () => {
  assert.equal(textValueMatches('jazzz', 'Jazz'), true, 'one-edit typo (sticky key)')
  assert.equal(textValueMatches('beetles', 'The Beatles'), true)
  assert.equal(textValueMatches('inro', 'Indie Rock'), true, 'bounded subsequence')
  assert.equal(textValueMatches('ir', 'Indie Rock'), true, 'initials')
  assert.equal(textValueMatches('stones', 'The Beatles'), false)
})

test('quoted text is exact — no typo, no subsequence', () => {
  assert.equal(textValueMatches('"jass"', 'Jazz'), false)
  assert.equal(textValueMatches('"inro"', 'Indie Rock'), false)
  assert.equal(textValueMatches('"jazz"', 'Jazz'), true)
  assert.equal(textValueMatches('"indie ro"', 'Indie Rock'), true)
})

test('tokens are ANDed inside one field value', () => {
  const tokens = parseFilterText('indie rock')
  assert.equal(filterTextMatches('indie rock', tokens), true)
  assert.equal(filterTextMatches('indie pop', tokens), false)
  assert.equal(filterTextMatches('anything', []), true, 'no tokens pass everything')
})

test('fuzzy text folds case, punctuation and diacritics like the global search', () => {
  assert.equal(textValueMatches('beyonce', 'Beyoncé'), true)
  assert.equal(textValueMatches('dont stop', "Don't Stop Me Now"), true)
  assert.equal(textValueMatches('acdc', 'AC/DC'), true)
})

// ── range clauses ──────────────────────────────────────────────────────

test('rangeValueMatches: open bounds pass everything; one bound excludes missing values', () => {
  assert.equal(rangeValueMatches(null, null, null), true)
  assert.equal(rangeValueMatches(2000, null, null), true)
  assert.equal(rangeValueMatches(null, 1990, null), false, 'unknown year cannot satisfy a bound')
  assert.equal(rangeValueMatches(null, null, 2010), false)
  assert.equal(rangeValueMatches(2000, 1990, 2010), true, 'bounds are inclusive')
  assert.equal(rangeValueMatches(1990, 1990, 2010), true)
  assert.equal(rangeValueMatches(2010, 1990, 2010), true)
  assert.equal(rangeValueMatches(1989, 1990, 2010), false)
})

// ── track predicate: elemental AND ─────────────────────────────────────

test('matchesFilterRuleSet: rating, loved and every clause must pass', () => {
  const t = track('a', { genre: 'Jazz', year: 1959, duration: 300 })
  const rules: FilterRuleSet = {
    minRating: 50,
    maxRating: 100,
    lovedOnly: true,
    clauses: [
      { id: 'g', kind: 'text', field: 'genre', query: 'jaz' },
      range('year', null, 1969),
      range('length', 100, null),
    ],
  }
  const ok = ctx({ a: 90 }, ['a'])
  assert.equal(matchesFilterRuleSet(t, rules, ok), true)
  assert.equal(matchesFilterRuleSet(t, rules, ctx({ a: 40 }, ['a'])), false, 'rating range')
  assert.equal(matchesFilterRuleSet(t, rules, ctx({ a: 90 }, [])), false, 'loved switch')
  assert.equal(matchesFilterRuleSet(t, { ...rules, clauses: [range('year', 1970, null)] }, ok), false, 'every clause ANDs')
})

test('a text clause is scoped to ITS field — a genre query does not hit the title', () => {
  const t = track('a', { title: 'Jazz', genre: 'Rock' })
  const rules: FilterRuleSet = { ...emptyFilterRuleSet(), clauses: [{ id: 'g', kind: 'text', field: 'genre', query: 'jazz' }] }
  assert.equal(matchesFilterRuleSet(t, rules, ctx()), false, 'the title hit must not satisfy a genre filter')
  const titleRules: FilterRuleSet = { ...emptyFilterRuleSet(), clauses: [{ id: 't', kind: 'text', field: 'title', query: 'jazz' }] }
  assert.equal(matchesFilterRuleSet(t, titleRules, ctx()), true)
})

test('a date-added clause uses createdAt; an undated track fails a bound', () => {
  const dated = track('a', { createdAt: 10_000 })
  assert.equal(matchesFilterRuleSet(dated, { ...emptyFilterRuleSet(), clauses: [range('added', 5_000, null)] }, ctx()), true)
  assert.equal(matchesFilterRuleSet(track('b'), { ...emptyFilterRuleSet(), clauses: [range('added', null, 20_000)] }, ctx()), false)
})

// ── reducers ───────────────────────────────────────────────────────────

test('addFilterClause appends one typed clause, starts open/empty, and never duplicates a field', () => {
  const base = emptyFilterRuleSet()
  const withGenre = addFilterClause(base, 'genre')
  assert.equal(withGenre.clauses.length, 1)
  assert.deepEqual(withGenre.clauses[0], { id: 'clause-genre-1', kind: 'text', field: 'genre', query: '' })
  const withYear = addFilterClause(withGenre, 'year')
  assert.deepEqual(withYear.clauses[1], { id: 'clause-year-1', kind: 'range', field: 'year', min: null, max: null })
  assert.equal(addFilterClause(withYear, 'genre'), withYear, 'one clause per field')
  assert.equal(base.clauses.length, 0, 'never mutates the input')
})

test('addFilterClause caps the list', () => {
  let rules = emptyFilterRuleSet()
  for (const field of ADDABLE_FILTER_FIELDS) rules = addFilterClause(rules, field)
  assert.equal(rules.clauses.length, ADDABLE_FILTER_FIELDS.length)
  assert.equal(addFilterClause(rules, 'title'), rules, 'an already-present field is still a no-op at the cap')
})

test('remove / replace / setRangeClause address a clause by id and keep the rest', () => {
  const rules = addFilterClause(addFilterClause(emptyFilterRuleSet(), 'genre'), 'year')
  const genre = rules.clauses[0]
  const replaced = replaceFilterClause(rules, { ...genre, query: 'jazz' } as never)
  assert.equal(replaced.clauses.length, 2)
  assert.equal(replaced.clauses[0].kind === 'text' && replaced.clauses[0].query, 'jazz')
  const yearId = rules.clauses[1].id
  const bounded = setRangeClause(replaced, yearId, { min: 1990, max: 2000 })
  assert.deepEqual(bounded.clauses[1], { id: yearId, kind: 'range', field: 'year', min: 1990, max: 2000 })
  assert.equal(removeFilterClause(bounded, yearId).clauses.length, 1)
})

test('setRangeClause never stores an inverted pair (crossed handles clamp)', () => {
  const rules = addFilterClause(emptyFilterRuleSet(), 'year')
  const id = rules.clauses[0].id
  const crossed = setRangeClause(setRangeClause(rules, id, { min: 1990, max: 2000 }), id, { min: 2010 })
  const clause = crossed.clauses[0]
  assert.ok(clause.kind === 'range')
  assert.deepEqual([clause.min, clause.max], [2000, 2000], 'min pushed past max clamps at max')
  const other = setRangeClause(setRangeClause(rules, id, { min: 1990, max: 2000 }), id, { max: 1980 })
  const clamped = other.clauses[0]
  assert.ok(clamped.kind === 'range')
  assert.deepEqual([clamped.min, clamped.max], [1990, 1990])
})

test('clearFilterRuleSet resets rating/loved/clauses; active tracks any narrowing', () => {
  const rules: FilterRuleSet = { minRating: 20, maxRating: 90, lovedOnly: true, clauses: [range('year', 1990, null)] }
  assert.equal(filterRuleSetActive(rules), true)
  assert.equal(filterRuleSetActive(emptyFilterRuleSet()), false)
  assert.deepEqual(clearFilterRuleSet(), emptyFilterRuleSet())
  assert.equal(filterRuleSetActive({ ...emptyFilterRuleSet(), minRating: 1 }), true)
  assert.equal(filterRuleSetActive({ ...emptyFilterRuleSet(), maxRating: 99 }), true)
})

test('the signature ignores clause ORDER but tracks values (the apply-diff identity)', () => {
  const a: FilterRuleSet = {
    ...emptyFilterRuleSet(),
    clauses: [
      { id: '1', kind: 'text', field: 'genre', query: 'jazz' },
      { id: '2', kind: 'range', field: 'year', min: 1950, max: null },
    ],
  }
  const b: FilterRuleSet = { ...a, clauses: [a.clauses[1], a.clauses[0]] }
  assert.equal(filterRuleSetSignature(a), filterRuleSetSignature(b))
  assert.equal(filterRuleSetsEqual(a, b), true)
  assert.equal(filterRuleSetsEqual(a, { ...a, clauses: [{ ...a.clauses[0], query: 'rock' } as never, a.clauses[1]] }), false)
})

// ── decode: the trust boundary + legacy migration ──────────────────────

test('decodeFilterRuleSet reads the current shape and clamps the rating range', () => {
  const decoded = decodeFilterRuleSet({
    minRating: 400,
    maxRating: -20,
    lovedOnly: 'yes',
    clauses: [{ id: 'x', kind: 'text', field: 'genre', query: 'Jazz' }],
  })
  assert.equal(decoded.minRating, 0, 'clamped then swapped (400/-20 → 0..100)')
  assert.equal(decoded.maxRating, 100)
  assert.equal(decoded.lovedOnly, false)
  assert.deepEqual(decoded.clauses, [{ id: 'x', kind: 'text', field: 'genre', query: 'Jazz' }])
})

test('decodeFilterRuleSet migrates the legacy scalar fields into clauses', () => {
  const decoded = decodeFilterRuleSet({ minRating: 40, lovedOnly: true, genre: ' Rock ', fromYear: '1990', toYear: 2000, minLength: '', maxLength: '300' })
  assert.equal(decoded.clauses.length, 3)
  assert.deepEqual(decoded.clauses[0], { id: 'clause-genre-1', kind: 'text', field: 'genre', query: 'Rock' })
  assert.deepEqual(decoded.clauses[1], { id: 'clause-year-1', kind: 'range', field: 'year', min: 1990, max: 2000 })
  assert.deepEqual(decoded.clauses[2], { id: 'clause-length-1', kind: 'range', field: 'length', min: null, max: 300 })
})

test('an existing clauses array wins over leftover legacy scalar fields', () => {
  const decoded = decodeFilterRuleSet({
    clauses: [{ id: 'k', kind: 'text', field: 'genre', query: 'Jazz' }],
    genre: 'Rock',
    fromYear: 1990,
  })
  assert.deepEqual(decoded.clauses.map((c) => c.field), ['genre'])
  assert.equal(decoded.clauses[0].kind === 'text' && decoded.clauses[0].query, 'Jazz')
})

test('decodeFilterClauses drops unknown fields, duplicates and mistyped rows, and caps the list', () => {
  const decoded = decodeFilterClauses([
    null,
    'junk',
    { field: 'bogus', kind: 'text', query: 'x' },
    { field: 'genre', kind: 'text', query: 'Jazz' },
    { field: 'genre', kind: 'text', query: 'Rock' },
    { field: 'year', kind: 'range', min: 2010, max: 1990 },
    { field: 'title', kind: 'range' },
    ...Array.from({ length: MAX_FILTER_CLAUSES + 3 }, (_, i) => ({ field: 'artist', kind: 'text', query: `a${i}` })),
  ])
  assert.deepEqual(decoded.map((c) => c.field), ['genre', 'year', 'artist'])
  const year = decoded[1]
  assert.ok(year.kind === 'range')
  assert.deepEqual([year.min, year.max], [1990, 2010], 'an inverted stored range is swapped, never kept')
  assert.ok(decoded[2].id.startsWith('clause-artist-'), 'a missing id is derived stably')
})

test('decodeFilterClauses keeps clause IDs unique (they are Svelte keys and edit handles)', () => {
  const decoded = decodeFilterClauses([
    { id: 'shared', field: 'genre', kind: 'text', query: 'a' },
    { id: 'shared', field: 'artist', kind: 'text', query: 'b' },
    // Its derived fallback (`clause-album-3`) is free, so it keeps it.
    { field: 'album', kind: 'text', query: 'c' },
    // An explicit id that COLLIDES with a later fallback must also be safe.
    { id: 'clause-composer-5', field: 'composer', kind: 'text', query: 'd' },
    { field: 'composer', kind: 'text', query: 'ignored duplicate field' },
  ])
  assert.equal(new Set(decoded.map((c) => c.id)).size, decoded.length)
  const ids = decoded.map((c) => c.id)
  assert.equal(ids.length, 4, 'the duplicate-field row is dropped before ids matter')
})

test('decodeFilterClauses suffixes a fallback that collides with an explicit id', () => {
  const decoded = decodeFilterClauses([
    { id: 'clause-artist-2', field: 'genre', kind: 'text', query: 'a' },
    { field: 'artist', kind: 'text', query: 'b' },
  ])
  assert.equal(decoded.length, 2)
  assert.notEqual(decoded[0].id, decoded[1].id)
  assert.equal(decoded[1].id, 'clause-artist-2-2')
})

test('decodeFilterRuleSet of junk answers a valid empty rule set', () => {
  for (const raw of [undefined, null, 42, 'nope', []]) {
    assert.deepEqual(decodeFilterRuleSet(raw), emptyFilterRuleSet())
  }
})

test('a decoded legacy row round-trips into the same filter meaning', () => {
  const decoded = decodeFilterRuleSet({ genre: 'jazz', fromYear: 1990, minRating: 60 })
  assert.equal(matchesFilterRuleSet(track('a', { genre: 'Jazz Fusion', year: 1995 }), decoded, ctx({ a: 80 })), true)
  assert.equal(matchesFilterRuleSet(track('b', { genre: 'Rock', year: 1995 }), decoded, ctx({ b: 80 })), false)
  assert.equal(matchesFilterRuleSet(track('c', { genre: 'Jazz', year: 1980 }), decoded, ctx({ c: 80 })), false)
  assert.equal(matchesFilterRuleSet(track('d', { genre: 'Jazz', year: 1995 }), decoded, ctx({ d: 10 })), false)
})
