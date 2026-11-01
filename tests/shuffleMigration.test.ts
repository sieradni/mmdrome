import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { autoQueueRecentLimit, autoQueueSort, initStores, shuffleEnabled } from '../src/stores/appState'
import { isRandomSort } from '../src/lib/sortCore'
import { RECENT_LIMIT_MAX } from '../src/lib/recentWindow'

// 2026-11-01 migration, pinned against the REAL store layer (not a helper):
// before this change `shuffleEnabled` was its own persisted Dexie row. It is a
// DERIVED view of the auto-queue sort now, so the boot restore must convert a
// legacy `true` into sort=random ONCE — and clear the old row, or every boot
// would re-apply it after the user turned shuffle off.
//
// Same fake-Dexie harness as tests/autoQueueFiltersPersistence.test.ts and
// tests/filterPresets.test.ts; `initStores` is once-per-process, so this file
// boots exactly once and asserts everything from that one boot.

const rows = new Map<string, unknown>()
Object.getPrototypeOf(db.userSettings).get = (async function (this: { name: string }, key: string) {
  if (this.name === 'playQueue') return undefined
  const value = rows.get(key)
  return value === undefined ? undefined : { key, value }
}) as never
Object.getPrototypeOf(db.userSettings).put = (async (entry: { key: string; value: unknown }) => {
  rows.set(entry.key, entry.value)
}) as never
Object.getPrototypeOf(db.localMetadata).toArray = (async () => []) as never

test('initStores migrates the legacy shuffleEnabled row into sort=random and clears it', async () => {
  rows.set('shuffleEnabled', true)
  // A legacy sort pair from before the two-tier model: the migration must
  // remember it as the stack to return to when shuffle is turned off.
  rows.set('autoQueueSort', { sortBy: 'year', sortAsc: false })
  // An out-of-band horizon (above the storage cap) is clamped on the way in.
  rows.set('autoQueueRecentLimit', RECENT_LIMIT_MAX + 2000)

  await initStores()

  const sort = get(autoQueueSort)
  assert.equal(isRandomSort(sort), true, 'legacy shuffle:true becomes an ordering by random')
  assert.deepEqual(sort.restore, [{ key: 'year', asc: false }], 'the previous sort is remembered for the off edge')
  assert.equal(get(shuffleEnabled), true, 'the derived view agrees with the sort')

  assert.equal(rows.get('shuffleEnabled'), false, 'the legacy row is cleared — a later boot must not re-apply it')
  // The horizon decodes through `clampRecentLimit`, so the store never holds a
  // value the slider cannot represent. (`restore` deliberately does not write
  // back, so the raw row keeps its old value until the next edit.)
  assert.equal(get(autoQueueRecentLimit), RECENT_LIMIT_MAX, 'an out-of-range horizon is clamped to the cap')
})
