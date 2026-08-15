// Pins the autoQueueFilters store split: the persisted row holds ONLY the
// filter fields (legacy JSON-string migration included), session scopes live
// in their own writable and can never leak into Dexie, and the combined store
// still carries both for queueManager/playbackManager. `initStores` is
// once-per-process, so the restore-dependent assertions run in the first test
// and the store-direct assertions after it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import {
  initStores,
  autoQueueFilterFields,
  autoQueueScope,
  autoQueueFilters,
  decodeAutoQueueFilters,
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

test('legacy JSON-string row migrates into the fields store on initStores', async () => {
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
  assert.equal(f.genre, 'Rock')
  assert.equal(f.fromYear, 1990, 'year strings coerce to numbers')
  assert.equal(f.toYear, 2000)
  assert.equal(f.minLength, '')
  assert.equal(f.maxLength, 300)
  assert.equal(f.searchQuery, 'foo')
  assert.ok(!('albumScope' in f), 'scopes are absent from the fields type')
})

test('decodeAutoQueueFilters falls back to defaults on corrupt or wrong-typed rows', () => {
  assert.equal(decodeAutoQueueFilters('not json{'), undefined, 'corrupt string keeps initial')
  assert.equal(decodeAutoQueueFilters(42), undefined, 'wrong-typed row keeps initial')
  assert.equal(decodeAutoQueueFilters(undefined), undefined)
  const merged = decodeAutoQueueFilters({ minRating: 40, genre: 'Jazz' })
  assert.equal(merged?.minRating, 40)
  assert.equal(merged?.maxRating, 100, 'missing fields merge over the defaults')
  assert.equal(merged?.genre, 'Jazz')
  const coerced = decodeAutoQueueFilters({ fromYear: '1985' })
  assert.equal(coerced?.fromYear, 1985)
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

test('scope set without a filter write persists nothing (no write, no row)', () => {
  const before = rows.has('autoQueueFilters')
  autoQueueScope.set({ artistScope: 'Some Artist' })
  assert.equal(rows.has('autoQueueFilters'), before, 'a scope-only change must not create/persist the row')
})
