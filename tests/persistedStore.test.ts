// Pins the `persisted` store factory: restore-before-persist, idempotent
// restore, and the "initial value must not clobber a saved value" guarantee.
// The Dexie `userSettings` table is stubbed like the other suites stub
// `playQueue.put` — Node has no IndexedDB.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { persisted } from '../src/lib/persistedStore'

const rows = new Map<string, string | number | boolean | object>()

// Mimic getSetting/setSetting's `{ key, value }` row shape.
Object.getPrototypeOf(db.userSettings).get = (async (key: string) => {
  const value = rows.get(key)
  return value === undefined ? undefined : { key, value }
}) as never
Object.getPrototypeOf(db.userSettings).put = (async (entry: { key: string; value: string | number | boolean | object }) => {
  rows.set(entry.key, entry.value)
}) as never

test('restore loads a saved value into the store', async () => {
  rows.set('k-saved', 42)
  const p = persisted<number>('k-saved', 0)
  assert.equal(get(p.store), 0, 'initial value before restore')
  await p.restore()
  assert.equal(get(p.store), 42)
})

test('restore keeps the initial when nothing is saved', async () => {
  const p = persisted<number>('k-missing', 7)
  await p.restore()
  assert.equal(get(p.store), 7)
})

test('writes before restore are not persisted; writes after restore are', async () => {
  const p = persisted<number>('k-order', 0)
  p.store.set(1)
  assert.equal(rows.has('k-order'), false, 'a pre-restore write must not hit Dexie')
  await p.restore()
  p.store.set(2)
  assert.equal(rows.get('k-order'), 2, 'a post-restore write persists')
})

test('a restored value is persisted on the next write, not re-written during restore', async () => {
  rows.set('k-existing', 9)
  const p = persisted<number>('k-existing', 0)
  await p.restore()
  // restore() sets the store before flipping `restored`, so the saved value
  // must not be re-persisted by the restore's own store.set.
  assert.equal(rows.get('k-existing'), 9)
  p.store.set(10)
  assert.equal(rows.get('k-existing'), 10)
})

test('restore is idempotent', async () => {
  rows.set('k-idem', 5)
  const p = persisted<number>('k-idem', 0)
  await p.restore()
  p.store.set(6)
  await p.restore()
  assert.equal(get(p.store), 6, 'a second restore must not clobber a live change')
})
