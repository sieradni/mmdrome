// Pins the pure auto-queue fill decision (the extracted half of the old
// QueueManager._buildPool): the filter predicate, the shared-sort rank map,
// the anchor rotation, and the tier-1/2/3 admission + ordering plan. The
// manager glue (queue write + saveQueue + wrapNotice) is a thin interpreter
// of this plan, pinned separately by queueManagerFill.test.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchesAutoQueueFilters,
  buildOrderRank,
  rotateAfterAnchor,
  planAutoQueueFill,
  filterRangesValid,
  type AutoQueuePlanState,
} from '../src/lib/autoQueuePlan'
import type { AutoQueueFilters, AutoQueueFilterFields, Track } from '../src/stores/appState'
import type { LocalMetadataStore } from '../src/lib/db'

const track = (id: string, over: Partial<Track> = {}): Track => ({
  trackId: id,
  title: `T${id}`,
  artist: 'Artist A',
  album: 'Album X',
  duration: 100,
  fileType: 'mp3',
  ...over,
})

// `Record<string, unknown>` widens the string-numeral call sites (year/length
// bounds arrive as strings, exactly as the persisted row can contain them).
const filters = (over: Record<string, unknown> = {}): AutoQueueFilters => ({
  minRating: 0,
  maxRating: 100,
  lovedOnly: false,
  fromYear: '',
  toYear: '',
  minLength: '',
  maxLength: '',
  ...over,
}) as AutoQueueFilters

const metaOf = (rows: [string, number, boolean?][]): Map<string, LocalMetadataStore> =>
  new Map(rows.map(([trackId, rating, loved = false]) => [trackId, {
    trackId, rating, loved, fileType: 'mp3', syncStatus: 'synced' as const, lastModifiedLocally: 0,
  }]))

const lib = (ts: Track[]): Track[] => ts

// ── matchesAutoQueueFilters ────────────────────────────────────────────

test('rating: within range passes; out of range fails; unrated passes the default 0..100', () => {
  const meta = metaOf([['t2', 80], ['t3', 100]])
  assert.equal(matchesAutoQueueFilters(track('t1'), filters(), meta), true, 'unrated passes default range')
  assert.equal(matchesAutoQueueFilters(track('t2'), filters(), meta), true)
  assert.equal(matchesAutoQueueFilters(track('t2'), filters({ minRating: 90 }), meta), false, 'below min fails')
  assert.equal(matchesAutoQueueFilters(track('t3'), filters({ maxRating: 99 }), meta), false, 'above max fails')
  assert.equal(matchesAutoQueueFilters(track('t1'), filters({ minRating: 1 }), meta), false, 'unrated fails minRating >= 1')
  assert.equal(matchesAutoQueueFilters(track('t2'), filters({ minRating: 0, maxRating: 0 }), meta), false, 'the only-unrated filter excludes rated')
})

test('lovedOnly requires the cached loved flag', () => {
  const meta = metaOf([['t2', 0, true]])
  assert.equal(matchesAutoQueueFilters(track('t2'), filters({ lovedOnly: true }), meta), true)
  assert.equal(matchesAutoQueueFilters(track('t1'), filters({ lovedOnly: true }), meta), false, 'unloved/unrated fails')
})

test('year bounds: out-of-range fails; a track without a year is excluded by EITHER bound', () => {
  const meta = metaOf([])
  assert.equal(matchesAutoQueueFilters(track('t1', { year: 2000 }), filters({ fromYear: '1990', toYear: '2010' }), meta), true)
  assert.equal(matchesAutoQueueFilters(track('t1', { year: 1980 }), filters({ fromYear: '1990' }), meta), false)
  assert.equal(matchesAutoQueueFilters(track('t1', { year: 2020 }), filters({ toYear: '2010' }), meta), false)
  // `year ?? 0` / `year ?? 9999`: a missing year fails BOTH a fromYear and a toYear filter.
  assert.equal(matchesAutoQueueFilters(track('t1'), filters({ fromYear: '1990' }), meta), false)
  assert.equal(matchesAutoQueueFilters(track('t1'), filters({ toYear: '2010' }), meta), false)
  assert.equal(matchesAutoQueueFilters(track('t1'), filters({ fromYear: '1990', toYear: '2010' }), meta), false)
})

test('length bounds: out-of-range fails; empty bounds pass', () => {
  const meta = metaOf([])
  assert.equal(matchesAutoQueueFilters(track('t1', { duration: 200 }), filters({ minLength: '100', maxLength: '300' }), meta), true)
  assert.equal(matchesAutoQueueFilters(track('t1', { duration: 50 }), filters({ minLength: '100' }), meta), false)
  assert.equal(matchesAutoQueueFilters(track('t1', { duration: 400 }), filters({ maxLength: '300' }), meta), false)
})

test('album/artist scopes match exactly; absent scope passes', () => {
  const meta = metaOf([])
  const t = track('t1', { album: 'Album X', artist: 'Artist A' })
  assert.equal(matchesAutoQueueFilters(t, filters({ albumScope: 'Album X' }), meta), true)
  assert.equal(matchesAutoQueueFilters(t, filters({ albumScope: 'Album Y' }), meta), false)
  assert.equal(matchesAutoQueueFilters(t, filters({ artistScope: 'Artist A' }), meta), true)
  assert.equal(matchesAutoQueueFilters(t, filters({ artistScope: 'Artist B' }), meta), false)
  assert.equal(matchesAutoQueueFilters(t, filters(), meta), true)
})

test('genre uses the shared token matcher', () => {
  const meta = metaOf([])
  assert.equal(matchesAutoQueueFilters(track('t1', { genre: 'Alt Rock / Indie' }), filters({ genre: 'Alt Rock' }), meta), true)
  assert.equal(matchesAutoQueueFilters(track('t1', { genre: 'Jazz' }), filters({ genre: 'Rock' }), meta), false)
})

test('searchQuery matches title/artist/album/composer substrings, case- and trim-insensitive', () => {
  const meta = metaOf([])
  assert.equal(matchesAutoQueueFilters(track('t1', { title: 'Hey Jude' }), filters({ searchQuery: 'hey' }), meta), true)
  assert.equal(matchesAutoQueueFilters(track('t2', { artist: 'The Beatles' }), filters({ searchQuery: '  beatles ' }), meta), true)
  assert.equal(matchesAutoQueueFilters(track('t3', { album: 'Abbey Road' }), filters({ searchQuery: 'abbey' }), meta), true)
  assert.equal(matchesAutoQueueFilters(track('t4', { composer: 'Lennon' }), filters({ searchQuery: 'lennon' }), meta), true)
  assert.equal(matchesAutoQueueFilters(track('t5', { title: 'Hey Jude' }), filters({ searchQuery: 'strawberry' }), meta), false)
  assert.equal(matchesAutoQueueFilters(track('t6'), filters({ searchQuery: '' }), meta), true, 'empty search passes')
  assert.equal(matchesAutoQueueFilters(track('t6'), filters({ searchQuery: undefined }), meta), true)
})

// ── filterRangesValid ──────────────────────────────────────────────────

test('filterRangesValid: inverted ranges are invalid; one-sided bounds are fine', () => {
  // `Record<string, unknown>` widens the string-numeral overrides (same
  // reason as the filters() helper above).
  const range = (over: Record<string, unknown> = {}): Pick<AutoQueueFilterFields, 'minRating' | 'maxRating' | 'fromYear' | 'toYear' | 'minLength' | 'maxLength'> => ({
    minRating: 0, maxRating: 100, fromYear: '', toYear: '', minLength: '', maxLength: '', ...over,
  }) as Pick<AutoQueueFilterFields, 'minRating' | 'maxRating' | 'fromYear' | 'toYear' | 'minLength' | 'maxLength'>
  assert.equal(filterRangesValid(range()), true, 'defaults are valid')
  assert.equal(filterRangesValid(range({ minRating: 90, maxRating: 10 })), false, 'minRating > maxRating')
  assert.equal(filterRangesValid(range({ fromYear: '2000', toYear: '1990' })), false, 'fromYear > toYear')
  assert.equal(filterRangesValid(range({ fromYear: '1990', toYear: '2000' })), true)
  assert.equal(filterRangesValid(range({ minLength: '300', maxLength: '100' })), false, 'minLength > maxLength')
  assert.equal(filterRangesValid(range({ minLength: '100', maxLength: '300' })), true)
  assert.equal(filterRangesValid(range({ fromYear: '1990' })), true, 'one-sided bound is fine')
  assert.equal(filterRangesValid(range({ maxRating: 50 })), true)
})

// ── buildOrderRank ─────────────────────────────────────────────────────

test('buildOrderRank: no sort keeps library order; ranks are SORTED POSITIONS (the B7 fix)', () => {
  const ts = [track('a'), track('b'), track('c')]
  const meta = metaOf([['a', 10], ['b', 90], ['c', 10]])
  const none = buildOrderRank(ts, { sortBy: null, sortAsc: true }, meta)
  assert.deepEqual([...none.entries()], [['a', 0], ['b', 1], ['c', 2]], 'no sort = library order')
  const asc = buildOrderRank(ts, { sortBy: 'rating', sortAsc: true }, meta)
  assert.deepEqual([...asc.entries()], [['a', 0], ['c', 1], ['b', 2]], 'rating asc ranks by sorted position (a,c tie broken by index)')
  const desc = buildOrderRank(ts, { sortBy: 'rating', sortAsc: false }, meta)
  assert.deepEqual([...desc.entries()], [['b', 0], ['a', 1], ['c', 2]], 'rating desc ranks by sorted position')
  const year = buildOrderRank(ts, { sortBy: 'year', sortAsc: true }, meta)
  assert.deepEqual([...year.entries()], [['a', 0], ['b', 1], ['c', 2]], 'missing years tie → library order')
})

// ── rotateAfterAnchor ──────────────────────────────────────────────────

test('rotateAfterAnchor truth table', () => {
  const pos = new Map([['a', 0], ['b', 1], ['c', 2]])
  // splitAt > 0: rotate so the first track after the anchor leads.
  assert.deepEqual(rotateAfterAnchor([{ trackId: 'a' }, { trackId: 'b' }, { trackId: 'c' }], pos, 'a').pool.map((t) => t.trackId), ['b', 'c', 'a'])
  assert.equal(rotateAfterAnchor([{ trackId: 'a' }, { trackId: 'b' }], pos, 'a').wrapNotice, false)
  // splitAt === 0: first candidate already follows the anchor — unchanged.
  assert.deepEqual(rotateAfterAnchor([{ trackId: 'b' }, { trackId: 'c' }], pos, 'a').pool.map((t) => t.trackId), ['b', 'c'])
  // splitAt < 0: nothing ranks after the anchor — wrap notice.
  assert.deepEqual(rotateAfterAnchor([{ trackId: 'a' }, { trackId: 'b' }], pos, 'c').pool.map((t) => t.trackId), ['a', 'b'])
  assert.equal(rotateAfterAnchor([{ trackId: 'a' }, { trackId: 'b' }], pos, 'c').wrapNotice, true)
  // No anchor / unknown anchor / empty pool: unchanged, no notice.
  assert.equal(rotateAfterAnchor([{ trackId: 'a' }], pos, undefined).wrapNotice, false)
  assert.equal(rotateAfterAnchor([{ trackId: 'a' }], pos, 'zzz').wrapNotice, false)
  assert.deepEqual(rotateAfterAnchor([], pos, 'a'), { pool: [], wrapNotice: false })
})

// ── planAutoQueueFill ──────────────────────────────────────────────────

function state(over: Partial<AutoQueuePlanState> = {}): AutoQueuePlanState {
  return {
    library: [],
    userQueue: [],
    autoQueue: [],
    recentTrackIds: [],
    activeId: undefined,
    shuffle: false,
    sort: { sortBy: null, sortAsc: true },
    filters: filters(),
    meta: new Map(),
    ...over,
  }
}

test('tier 1: fresh tracks fill first; the user-queued track is excluded', () => {
  // shuffle: true pins the RAW tier order — non-shuffle mode re-sorts the pool
  // by rank (even with no sort: library order), which is asserted separately.
  const ts = lib(['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => track(id)))
  const plan = planAutoQueueFill(state({ library: ts, userQueue: ['t1'], activeId: 't1', shuffle: true }), 50, { keepAuto: true })
  assert.deepEqual(plan.kept, [])
  assert.deepEqual(plan.pool.map((t) => t.trackId), ['t2', 't3', 't4', 't5', 't6'], 'user-queued t1 excluded (activeId + tier 1)')
  assert.equal(plan.shuffle, true)
  assert.equal(plan.wrapNotice, false)
})

test('tier 2 admits cooling-down tracks when the fresh pool is short', () => {
  const ts = lib(['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => track(id)))
  const plan = planAutoQueueFill(state({ library: ts, recentTrackIds: ['t4', 't5'], shuffle: true }), 50, { keepAuto: true })
  // tier1 = t1,t2,t3,t6 (t4,t5 cooling); tier2 appends t4,t5 in library order.
  assert.deepEqual(plan.pool.map((t) => t.trackId), ['t1', 't2', 't3', 't6', 't4', 't5'])
})

test('tier 3 recycles user-queued + recent tracks and excludes the active id (B4)', () => {
  const ts = lib(['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => track(id)))
  const plan = planAutoQueueFill(state({
    library: ts,
    userQueue: ['t1'],
    autoQueue: ['t2'],
    recentTrackIds: ['t3', 't4'],
    activeId: 't2',
    shuffle: true,
  }), 50, { keepAuto: true })
  // kept = [t2]; inAuto excludes t2 from every tier.
  // tier1 = t5,t6 (t1 inUser, t2 inAuto, t3/t4 recent)
  // tier2 = t3,t4; tier3 = t1 (user-queued recycling); t2 (activeId) never re-enters.
  assert.deepEqual(plan.kept, ['t2'])
  assert.deepEqual(plan.pool.map((t) => t.trackId), ['t5', 't6', 't3', 't4', 't1'])
})

test('kept is pruned when filters tighten, and the queue-full early return skips the pool', () => {
  const ts = lib(['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => track(id)))
  const meta = metaOf([['t2', 80]])
  // First pass at default filters: everything auto-queued except t1 (which is
  // the playing track — activeId excludes it from the rotation tier).
  const loose = planAutoQueueFill(state({ library: ts, userQueue: ['t1'], meta, activeId: 't1' }), 50, { keepAuto: true })
  assert.deepEqual(loose.pool.map((t) => t.trackId), ['t2', 't3', 't4', 't5', 't6'])
  // Tighten to minRating 50: only t2 (rating 80) matches — kept = [t2], pool empty.
  const tight = planAutoQueueFill(state({ library: ts, userQueue: ['t1'], autoQueue: ['t2', 't3', 't4', 't5', 't6'], meta, activeId: 't1', filters: filters({ minRating: 50 }) }), 50, { keepAuto: true })
  assert.deepEqual(tight.kept, ['t2'])
  assert.deepEqual(tight.pool, [])
  assert.equal(tight.wrapNotice, false, 'empty pool never carries a wrap hint')
  // Queue already full of MATCHING tracks (50 kept of a 60-track library):
  // the kept.length >= needed early return — no pool scan, no wrap hint.
  // (The queued ids must exist in the library and match, or kept would be
  // empty and this would silently test the empty-pool path instead.)
  const many = lib(Array.from({ length: 60 }, (_, i) => track(`t${i + 1}`)))
  const full = planAutoQueueFill(state({ library: many, autoQueue: Array.from({ length: 50 }, (_, i) => `t${i + 1}`) }), 50, { keepAuto: true })
  assert.equal(full.kept.length, 50, 'all 50 queued tracks still match — kept intact')
  assert.deepEqual(full.pool, [], 'a full queue short-circuits before any pool scan')
  assert.equal(full.wrapNotice, false)
})

test('searchQuery is a persisted filter: it constrains the pool like any other field', () => {
  const ts = lib([
    track('b1', { artist: 'The Beatles' }),
    track('s1', { artist: 'The Stones' }),
  ])
  const plan = planAutoQueueFill(state({ library: ts, filters: filters({ searchQuery: 'beat' }) }), 50, { keepAuto: true })
  assert.deepEqual(plan.pool.map((t) => t.trackId), ['b1'])
})

test('non-shuffle ordering follows the shared sort and rotates after the last user entry', () => {
  // Library order is deliberately SCRAMBLED vs. the rating-sorted order so the
  // B7 fix (rank by sorted position) is observable — with the old library-
  // index ranks this pool came out in scrambled order with no wrap hint.
  const ts = lib(['c', 'e', 'a', 'f', 'b', 'd'].map((id) => track(id)))
  const meta = metaOf([['a', 10], ['b', 20], ['c', 30], ['d', 40], ['e', 50], ['f', 100]])
  const plan = planAutoQueueFill(state({
    library: ts, userQueue: ['f'], meta,
    sort: { sortBy: 'rating', sortAsc: true },
  }), 50, { keepAuto: true })
  // Fresh tier = c,e,a,b,d (f is user-queued); the rotation tier recycles f
  // (B4) because the pool is short. Sorted by rating asc → a..f; nothing ranks
  // after the anchor f, so the rotation wraps from the top (wrapNotice).
  assert.deepEqual(plan.pool.map((t) => t.trackId), ['a', 'b', 'c', 'd', 'e', 'f'])
  assert.equal(plan.wrapNotice, true)
})

test('shuffle is reported as data, not applied', () => {
  const ts = lib(['t1', 't2', 't3'].map((id) => track(id)))
  const plan = planAutoQueueFill(state({ library: ts, shuffle: true }), 50, { keepAuto: true })
  assert.equal(plan.shuffle, true)
  assert.equal(plan.wrapNotice, false, 'shuffle clears the wrap hint')
  assert.deepEqual([...plan.pool].map((t) => t.trackId).sort(), ['t1', 't2', 't3'], 'pool intact; permutation is the caller\'s job')
})

test('rebuild (keepAuto false) admits the old auto tracks as ordinary pool members', () => {
  const ts = lib(['t1', 't2', 't3', 't4'].map((id) => track(id)))
  const plan = planAutoQueueFill(state({ library: ts, autoQueue: ['t1', 't2'] }), 50, { keepAuto: false })
  assert.deepEqual(plan.kept, [])
  assert.deepEqual(plan.pool.map((t) => t.trackId), ['t1', 't2', 't3', 't4'], 'old auto tracks re-enter on a rebuild')
})
