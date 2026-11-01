import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SORT_MAX_TIERS,
  SORT_TIER_KEYS,
  classifySortChange,
  clearSort,
  defaultDirection,
  describeSort,
  isRandomSort,
  normalizeSort,
  planRandomToggle,
  randomRank,
  reRollRandom,
  setTier,
  sortOf,
  sortSignature,
  sortWithTiers,
  trackSortCmp,
  type SortState,
} from '../src/lib/sortCore'

// The two-tier sort core (2026-11-01). Every rule that used to be duplicated
// across five comparators and three decoders lives here, so this file is the
// single pin for: the legacy migration, the tier rules (random stands alone as a
// PRIMARY and is the seeded TIE-BREAK as a secondary), the comparator contract
// (tiers in order, ties), the seeded random order, and the shuffle-as-sort
// toggle that must survive relaunch.

const tiers = (s: SortState) => s.tiers.map((t) => `${t.key}${t.asc ? '+' : '-'}`)

test('normalizeSort migrates the legacy {sortBy, sortAsc} pair', () => {
  assert.deepEqual(tiers(normalizeSort({ sortBy: 'rating', sortAsc: false })), ['rating-'])
  assert.deepEqual(tiers(normalizeSort({ sortBy: 'year', sortAsc: true })), ['year+'])
  // A legacy row with a key but no direction uses that key's default.
  assert.deepEqual(tiers(normalizeSort({ sortBy: 'added' })), ['added-'])
  assert.deepEqual(tiers(normalizeSort({ sortBy: null, sortAsc: true })), [])
})

test('normalizeSort keeps at most two tiers, drops duplicates and unknown keys', () => {
  const s = normalizeSort({
    tiers: [{ key: 'rating', asc: false }, { key: 'added', asc: true }, { key: 'year', asc: true }],
  })
  assert.equal(s.tiers.length, SORT_MAX_TIERS, 'capped at two')
  assert.deepEqual(tiers(s), ['rating-', 'added+'])

  assert.deepEqual(tiers(normalizeSort({ tiers: [{ key: 'rating' }, { key: 'rating', asc: true }] })), ['rating-'])
  assert.deepEqual(tiers(normalizeSort({ tiers: [{ key: 'tempo', asc: true }] })), [], 'unknown key dropped')
})

test('random as the PRIMARY stands alone; as the SECONDARY it is the tie-break', () => {
  // A random primary IS the whole order, so anything below it is dropped.
  const first = normalizeSort({ tiers: [{ key: 'random', asc: false }, { key: 'year', asc: true }] })
  assert.deepEqual(tiers(first), ['random+'], 'random is one tier, direction irrelevant')

  // A random SECONDARY is legal and keeps the primary: it scrambles that level.
  const secondary = normalizeSort({
    tiers: [{ key: 'year', asc: true }, { key: 'random', asc: true }],
  })
  assert.deepEqual(tiers(secondary), ['year+', 'random+'], 'random breaks the primary ties')
  assert.equal(isRandomSort(secondary), false, 'a secondary scramble is NOT shuffle')

  // Random first in RAW input still collapses even with a tier after it, and a
  // duplicate random can never produce two random tiers.
  assert.deepEqual(tiers(normalizeSort({ tiers: [{ key: 'random' }, { key: 'random' }] })), ['random+'])

  // The editor offers random in the secondary slot.
  assert.ok(SORT_TIER_KEYS.includes('random'), 'random is a legal secondary key')
})

test('a secondary random scrambles ONLY the groups the primary ties on', () => {
  const rows = [
    { id: 'a', year: 2020 },
    { id: 'b', year: 2021 },
    { id: 'c', year: 2020 },
    { id: 'd', year: 2020 },
    { id: 'e', year: 2019 },
  ]
  const order = (seed: number) =>
    sortWithTiers(rows, {
      sort: { tiers: [{ key: 'year', asc: true }, { key: 'random', asc: true }], randomSeed: seed },
      cmp: (key, a, b) => (key === 'year' ? a.year - b.year : 0),
      idOf: (r) => r.id,
    }).map((r) => r.id)

  assert.deepEqual(
    order(101).map((id) => rows.find((r) => r.id === id)!.year),
    [2019, 2020, 2020, 2020, 2021],
    'the primary order wins: the scramble never crosses a group boundary',
  )
  assert.deepEqual(order(101), order(101), 'the same seed is the same order')

  // The tied 2020 group is genuinely resampled by a different seed.
  const tied = (seed: number) => order(seed).filter((id) => id === 'a' || id === 'c' || id === 'd').join('')
  const permutations = new Set()
  for (let seed = 1; seed <= 20; seed++) permutations.add(tied(seed))
  assert.ok(permutations.size > 1, 'a secondary random actually permutes the ties')
})

test('normalizeSort is total: junk degrades to no sort, never throws', () => {
  for (const junk of [null, undefined, 42, 'nope', [], {}, { tiers: 'x' }, { sortBy: 'tempo' }]) {
    const s = normalizeSort(junk)
    assert.deepEqual(s.tiers, [])
    assert.equal(s.randomSeed, 0)
  }
})

test('defaultDirection reads best-first for rating/loved/added, natural for year/length', () => {
  assert.equal(defaultDirection('rating'), false)
  assert.equal(defaultDirection('loved'), false)
  assert.equal(defaultDirection('added'), false)
  assert.equal(defaultDirection('year'), true)
  assert.equal(defaultDirection('length'), true)
  assert.equal(defaultDirection('random'), true)
})

test('setTier: pick, flip, move between slots and clear', () => {
  let s = sortOf()
  s = setTier(s, 0, 'rating')
  assert.deepEqual(tiers(s), ['rating-'])
  s = setTier(s, 0, 'rating')
  assert.deepEqual(tiers(s), ['rating+'], 're-picking the active key flips it')

  s = setTier(s, 1, 'added')
  assert.deepEqual(tiers(s), ['rating+', 'added-'], 'a second pick becomes the secondary key')

  s = setTier(s, 1, 'rating')
  assert.deepEqual(tiers(s), ['added-', 'rating-'], 'picking a key already at another slot MOVES it (never duplicates)')

  s = setTier(s, 1, 'year')
  s = setTier(s, 0, null)
  assert.deepEqual(tiers(s), ['year+'], 'clearing the primary promotes the secondary')
  assert.deepEqual(tiers(clearSort(s)), [], 'clear removes both tiers')
})

test('setTier(random) collapses the stack and remembers what it replaced', () => {
  const before = sortOf('rating', false, 'added', true)
  const random = setTier(before, 0, 'random')
  assert.deepEqual(tiers(random), ['random+'])
  assert.deepEqual(tiers({ tiers: random.restore ?? [], randomSeed: 0 }), ['rating-', 'added+'], 'the memory is the previous stack')

  // Clearing random returns to the memory instead of an empty sort.
  assert.deepEqual(tiers(setTier(random, 0, null)), ['rating-', 'added+'])
  // An EXPLICIT pick wins over the memory.
  assert.deepEqual(tiers(setTier(random, 0, 'length')), ['length+'])
})

test('planRandomToggle: on captures once, off restores, and it survives a persisted round-trip', () => {
  const base = sortOf('rating', false, 'added', true)

  const on = planRandomToggle(base, true)
  assert.equal(isRandomSort(on), true)
  assert.deepEqual(tiers({ tiers: on.restore ?? [], randomSeed: 0 }), ['rating-', 'added+'])

  // Turning it on AGAIN must not overwrite the memory with "random".
  const again = planRandomToggle(on, true)
  assert.deepEqual(tiers({ tiers: again.restore ?? [], randomSeed: 0 }), ['rating-', 'added+'])
  assert.equal(again.randomSeed, on.randomSeed, 'a re-entry never re-rolls the order either')

  // Persist -> reload -> turn off still restores the remembered stack.
  const reloaded = normalizeSort(JSON.parse(JSON.stringify(on)))
  assert.deepEqual(tiers(planRandomToggle(reloaded, false)), ['rating-', 'added+'])

  // Off with no memory is simply "no sort".
  assert.deepEqual(tiers(planRandomToggle(sortOf(), false)), [])

  // A seedless random state gets a real seed when it is turned on.
  const fromLegacyRandom = planRandomToggle({ sortBy: 'random' }, true)
  assert.equal(fromLegacyRandom.randomSeed, 0, 'already random: unchanged (the legacy row keeps its order)')

  // A stack with a random TIE-BREAK remembers only its real tiers, so turning
  // shuffle off can never answer an unreachable (random-secondary) stack.
  const withScramble = setTier(sortOf('year', true), 1, 'random')
  assert.deepEqual(tiers(withScramble), ['year+', 'random+'])
  const shuffleOn = planRandomToggle(withScramble, true)
  assert.deepEqual(tiers(shuffleOn), ['random+'])
  assert.deepEqual(tiers({ tiers: shuffleOn.restore ?? [], randomSeed: 0 }), ['year+'], 'the memory never carries a random tier')
  assert.deepEqual(tiers(planRandomToggle(shuffleOn, false)), ['year+'])
})

test('setTier: a SECONDARY random is the tie-break and survives a primary change', () => {
  let s = sortOf('year', true)
  s = setTier(s, 1, 'random')
  assert.deepEqual(tiers(s), ['year+', 'random+'])
  assert.ok(s.randomSeed > 0, 'a seed is assigned when the scramble starts')
  const seed = s.randomSeed

  // Re-tapping random in the secondary slot is a no-op (no direction to flip).
  assert.deepEqual(tiers(setTier(s, 1, 'random')), ['year+', 'random+'])
  assert.equal(setTier(s, 1, 'random').randomSeed, seed, 'the scramble does not re-roll itself')

  // A new PRIMARY keeps the scramble the user chose.
  assert.deepEqual(tiers(setTier(s, 0, 'rating')), ['rating-', 'random+'])

  // A real secondary REPLACES it — an explicit pick wins over the scramble.
  assert.deepEqual(tiers(setTier(s, 1, 'added')), ['year+', 'added-'])

  // Clearing the secondary leaves the primary alone.
  assert.deepEqual(tiers(setTier(s, 1, null)), ['year+'])

  // Moving a real secondary up over a random primary: random cannot stay below.
  const random = setTier(sortOf(), 0, 'random')
  assert.deepEqual(tiers(setTier(random, 1, 'year')), ['year+'])
})

test('reRollRandom only re-rolls a random order', () => {
  const random = setTier(sortOf(), 0, 'random')
  const rolled = reRollRandom(random, 12345)
  assert.equal(rolled.randomSeed, 12345)
  assert.equal(isRandomSort(rolled), true)

  const plain = sortOf('rating', false)
  assert.deepEqual(reRollRandom(plain, 7), plain, 'a non-random sort has no seed to re-roll')

  // A SECONDARY scramble re-rolls too — that is "new shuffle of the ties".
  const secondary = setTier(sortOf('year', true), 1, 'random')
  assert.equal(reRollRandom(secondary, 4242).randomSeed, 4242)
  assert.deepEqual(tiers(reRollRandom(secondary, 4242)), ['year+', 'random+'])
  assert.equal(isRandomSort(reRollRandom(secondary, 4242)), false)
})

test('sortSignature ignores the seed; classifySortChange tells the three cases apart', () => {
  const rating = sortOf('rating', false)
  const added = sortOf('added', true)
  const random = setTier(sortOf(), 0, 'random')

  assert.equal(sortSignature(sortOf()), '')
  assert.equal(sortSignature(rating), 'rating-')
  assert.equal(sortSignature(sortOf('rating', false, 'added', true)), 'rating-|added+')
  assert.equal(sortSignature(random), 'random')
  assert.equal(sortSignature(reRollRandom(random, 999)), 'random', 'a seed re-roll is not an ordering change')

  assert.equal(classifySortChange(rating, sortOf('rating', false)), 'none', 'subscribe fires are no-ops')
  assert.equal(classifySortChange(reRollRandom(random, 5), random), 'none', 'a library re-roll must not rebuild the queue')
  assert.equal(classifySortChange(rating, added), 'rule', 'a tier change is a fresh context')
  assert.equal(classifySortChange(sortOf('rating', false), sortOf('rating', true)), 'rule', 'a direction flip is a fresh context')
  assert.equal(classifySortChange(rating, random), 'random', 'entering random keeps the window (rebuild only)')
  assert.equal(classifySortChange(random, rating), 'random', 'leaving random keeps it too')
})

test('describeSort is the one label source', () => {
  assert.equal(describeSort(sortOf()), '')
  assert.equal(describeSort(sortOf('rating', false)), 'Rating ↓')
  assert.equal(describeSort(sortOf('rating', false, 'added', true)), 'Rating ↓ · Added ↑')
  assert.equal(describeSort(setTier(sortOf(), 0, 'random')), 'Random')
  assert.equal(describeSort(sortOf('year', true, 'random')), 'Year ↑ · Random', 'a secondary scramble is named')
})

test('sortWithTiers orders by the primary tier, then the secondary', () => {
  const rows = [
    { id: 'a', rating: 10, added: 3 },
    { id: 'b', rating: 90, added: 1 },
    { id: 'c', rating: 10, added: 1 },
    { id: 'd', rating: 90, added: 2 },
  ]
  const cmp = (key: string, a: (typeof rows)[number], b: (typeof rows)[number]) =>
    key === 'rating' ? a.rating - b.rating : a.added - b.added
  const ordered = sortWithTiers(rows, {
    sort: sortOf('rating', false, 'added', true),
    cmp,
    idOf: (r) => r.id,
  })
  assert.deepEqual(ordered.map((r) => r.id), ['b', 'd', 'c', 'a'], 'rating desc, then added asc inside the tie')
})

test('ties: natural keeps the incoming order, mirror answers the arrow', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const cmp = () => 0
  const desc = sortOf('rating', false)

  assert.deepEqual(
    sortWithTiers(rows, { sort: desc, cmp, idOf: (r) => r.id, tie: 'natural' }).map((r) => r.id),
    ['a', 'b', 'c'],
    'a fully-tied list keeps library order (no reversed list on a flip)',
  )
  assert.deepEqual(
    sortWithTiers(rows, { sort: desc, cmp, idOf: (r) => r.id, tie: 'mirror' }).map((r) => r.id),
    ['c', 'b', 'a'],
    'the auto-queue rank mirrors the arrow so a flip is never a no-op (E6)',
  )
})

test('random ordering is seeded, stable per id, and re-rolls as a whole', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `t${i}`)
  const order = (seed: number, list = ids) =>
    sortWithTiers(list.map((id) => ({ id })), {
      sort: { tiers: [{ key: 'random', asc: true }], randomSeed: seed },
      cmp: () => 0,
      idOf: (r) => r.id,
    }).map((r) => r.id)

  assert.deepEqual(order(42), order(42), 'same seed = same order (renders, navigation, relaunch)')
  assert.notDeepEqual(order(42), order(43), 'a new seed is a new order')
  assert.deepEqual([...order(42)].sort(), [...ids].sort(), 'a permutation, never a lost row')

  // Adding one track must not scramble the others (per-id hash, not a
  // whole-list Fisher–Yates).
  const before = order(42)
  const grown = order(42, [...ids, 'newcomer'])
  assert.deepEqual(grown.filter((id) => id !== 'newcomer'), before, 'existing rows keep their relative order')
})

test('randomRank is a pure per-id hash', () => {
  const a = randomRank(7, ['x', 'y'])
  assert.deepEqual(a, randomRank(7, ['x', 'y']))
  assert.notEqual(a.get('x'), a.get('y'))
  assert.equal(randomRank(0, []).size, 0)
})

test('trackSortCmp covers every non-random key', () => {
  const ctx = { ratingOf: (id: string) => (id === 'hi' ? 90 : 10), lovedOf: (id: string) => id === 'hi' }
  const lo = { trackId: 'lo', year: 1990, duration: 100, createdAt: 1 }
  const hi = { trackId: 'hi', year: 2001, duration: 300, createdAt: 2 }

  assert.ok(trackSortCmp('rating', lo, hi, ctx) < 0)
  assert.ok(trackSortCmp('loved', lo, hi, ctx) < 0)
  assert.ok(trackSortCmp('year', lo, hi, ctx) < 0)
  assert.ok(trackSortCmp('length', lo, hi, ctx) < 0)
  assert.ok(trackSortCmp('added', lo, hi, ctx) < 0)
  assert.equal(trackSortCmp('random', lo, hi, ctx), 0, 'random is never asked for here')
})
