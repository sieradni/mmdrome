// Pins the autoQueueFilters store split: the persisted row holds ONLY the
import { sortOf } from '../src/lib/sortCore'
// filter fields (legacy JSON-string/scalar migration included), session scopes
// live in their own writable and can never leak into Dexie, and the combined
// store still carries both for queueManager/playbackManager. `initStores` is
// once-per-process, so the restore-dependent assertions run in the first test
// and the store-direct assertions after it. Since 2026-11-03 the fields are the
// shared filter RULE SET (rating + loved + elemental clauses).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import {
  initStores,
  autoQueueFilterFields,
  autoQueueSort,
  autoQueueScope,
  autoQueueFilters,
  decodeAutoQueueFilters,
  decodeAutoQueueSort,
} from '../src/stores/appState'

const rows = new Map<string, unknown>()

// Mimic the Dexie row shapes getSetting/setSetting/getQueue/getAllMetadata
// use. Dexie tables share one prototype, so `get`/`put` are patched ONCE and
// dispatch on the table instance — a per-table patch would clobber the shared
// method (patching `db.playQueue.get` overwrites `db.userSettings.get`).
Object.getPrototypeOf(db.userSettings).get = (async function (this: { name: string }, key: string) {
  if (this.name === 'playQueue') return undefined
  const value = rows.get(key)
  return value === undefined ? undefined : { key, value }
}) as never
Object.getPrototypeOf(db.userSettings).put = (async (entry: { key: string; value: unknown }) => {
  rows.set(entry.key, entry.value)
}) as never
Object.getPrototypeOf(db.localMetadata).toArray = (async () => []) as never

test('a legacy JSON-string row migrates into the fields store on initStores', async () => {
  rows.set(
    'autoQueueFilters',
    JSON.stringify({
      minRating: 20,
      maxRating: 80,
      lovedOnly: true,
      genre: 'Rock',
      fromYear: '1990',
      toYear: '2000',
      minLength: '',
      maxLength: '300',
      searchQuery: 'foo',
    }),
  )
  await initStores()
  const f = get(autoQueueFilterFields)
  assert.equal(f.minRating, 20)
  assert.equal(f.maxRating, 80)
  assert.equal(f.lovedOnly, true)
  assert.equal(f.searchQuery, 'foo')
  assert.ok(!('albumScope' in f), 'scopes are absent from the fields type')
  // The five legacy scalars became three typed clauses, exactly as they
  // filtered before (an empty minLength is "no lower bound", never 0).
  assert.deepEqual(f.clauses.map((c) => c.field), ['genre', 'year', 'length'])
  const [genre, year, length] = f.clauses
  assert.deepEqual(genre, { id: 'clause-genre-1', kind: 'text', field: 'genre', query: 'Rock' })
  assert.ok(year.kind === 'range')
  assert.deepEqual([year.min, year.max], [1990, 2000])
  assert.ok(length.kind === 'range')
  assert.deepEqual([length.min, length.max], [null, 300])
})

test('a cleared legacy bound decodes to an OPEN side, not a zero value', () => {
  const decoded = decodeAutoQueueFilters({ minLength: '', maxLength: '' })
  assert.deepEqual(decoded?.clauses, [], 'both empty bounds mean no clause at all')
})

test('decodeAutoQueueFilters falls back to defaults on corrupt or wrong-typed rows', () => {
  assert.equal(decodeAutoQueueFilters('not json{'), undefined, 'corrupt string keeps initial')
  assert.equal(decodeAutoQueueFilters(42), undefined, 'wrong-typed row keeps initial')
  assert.equal(decodeAutoQueueFilters(undefined), undefined)
  // null is typeof 'object' — must not crash on `p.minRating` (regression: it
  // threw a TypeError that rejected initStores on a null row). The cast
  // expresses a corrupt row Dexie could hand us at runtime despite the type.
  assert.equal(decodeAutoQueueFilters(null as never), undefined, 'null row keeps initial')
  assert.equal(decodeAutoQueueFilters('null'), undefined, 'JSON literal null keeps initial')
  assert.equal(decodeAutoQueueFilters('"a string"'), undefined, 'parsed primitive keeps initial')
  assert.equal(decodeAutoQueueFilters('[1, 2]'), undefined, 'parsed array keeps initial')
  const merged = decodeAutoQueueFilters({ minRating: 40, genre: 'Jazz' })
  assert.equal(merged?.minRating, 40)
  assert.equal(merged?.maxRating, 100, 'missing fields merge over the defaults')
  assert.deepEqual(merged?.clauses, [{ id: 'clause-genre-1', kind: 'text', field: 'genre', query: 'Jazz' }])
  const coerced = decodeAutoQueueFilters({ fromYear: '1985' })
  const year = coerced?.clauses[0]
  assert.ok(year?.kind === 'range')
  assert.equal(year.min, 1985)
  assert.equal(year.max, null)
})

test('decodeAutoQueueFilters reads the CURRENT clause shape and ignores stray legacy keys', () => {
  const decoded = decodeAutoQueueFilters({
    minRating: 30,
    clauses: [{ id: 'c1', kind: 'text', field: 'artist', query: 'beatl' }],
    genre: 'ignored when clauses exist',
  })
  assert.deepEqual(decoded?.clauses, [{ id: 'c1', kind: 'text', field: 'artist', query: 'beatl' }])
})

test('scopes never persist: setting a scope writes no scope keys into the Dexie row', () => {
  autoQueueScope.set({ albumScope: 'The Album', artistScope: undefined })
  autoQueueFilterFields.update((f) => ({ ...f, minRating: 55 }))
  const saved = rows.get('autoQueueFilters')
  assert.ok(saved !== undefined && typeof saved === 'object' && !Array.isArray(saved), 'a filter write persists the object row')
  const savedObj = saved as Record<string, unknown>
  assert.ok(!('albumScope' in savedObj), 'albumScope must never reach the persisted row')
  assert.ok(!('artistScope' in savedObj), 'artistScope must never reach the persisted row')
  assert.equal(savedObj.minRating, 55)
  // The combined store still exposes the scope to queueManager/playbackManager.
  assert.equal(get(autoQueueFilters).albumScope, 'The Album')
})

test('scope set without a filter write persists nothing (row untouched)', () => {
  const before = JSON.stringify(rows.get('autoQueueFilters'))
  autoQueueScope.set({ artistScope: 'Some Artist' })
  assert.equal(
    JSON.stringify(rows.get('autoQueueFilters')),
    before,
    'a scope-only change must not create, mutate, or persist the row',
  )
})

// ── autoQueueSort persistence (2026-09-29 decoupling) ──────────────────

test('autoQueueSort: a write persists to its own Dexie row and round-trips the shape', async () => {
  autoQueueSort.set(sortOf('year', false))
  // The persisted-store layer writes asynchronously after the set; give the
  // microtask queue a turn before reading the fake table.
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(rows.get('autoQueueSort'), sortOf('year', false))

  // The decode accepts the written shape verbatim.
  assert.deepEqual(decodeAutoQueueSort(sortOf('year', false)), sortOf('year', false))
  assert.deepEqual(decodeAutoQueueSort({ sortBy: null }), sortOf(), 'a missing key means no sort')
  assert.deepEqual(decodeAutoQueueSort(sortOf('length', false)), sortOf('length', false))
  assert.deepEqual(decodeAutoQueueSort(sortOf('added', false)), sortOf('added', false), 'added is a valid persisted key')
})

test('decodeAutoQueueSort: corrupt rows fall back to the default', () => {
  assert.deepEqual(decodeAutoQueueSort(undefined), sortOf(), 'absent row - no sort')
  assert.deepEqual(decodeAutoQueueSort(null), sortOf())
  assert.deepEqual(decodeAutoQueueSort('not an object'), sortOf())
  assert.deepEqual(decodeAutoQueueSort(42), sortOf())
  assert.deepEqual(decodeAutoQueueSort(['rating']), sortOf(), 'array row - no sort')
  assert.deepEqual(decodeAutoQueueSort({ sortBy: 'bogus' }), sortOf(), 'unknown key rejected outright')
  // A partial object converges to the default (sortBy missing = no sort key);
  // decode returning the default and returning undefined (keep initial) are
  // behaviorally identical here because the initial IS the default.
  assert.deepEqual(decodeAutoQueueSort({}), sortOf())
})

test('decodeAutoQueueSort: unknown extra keys are tolerated (forward-compat)', () => {
  const decoded = decodeAutoQueueSort({ ...sortOf('rating', true), futureField: 1 })
  assert.deepEqual(decoded, sortOf('rating', true))
})
