// The user-queue shuffle SWITCH is a persisted preference (2026-11-14): boot
// restores the saved value and a press writes it back, through the same
// `persisted` path every other queue/playback preference takes. Pinned against
// the REAL store layer, not a helper (same fake-Dexie harness as
// tests/shuffleMigration.test.ts); `initStores` is once-per-process, so this
// file boots exactly once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { initStores, userQueueShuffle } from '../src/stores/appState'
import { queueManager } from '../src/lib/queueManager'

const rows = new Map<string, unknown>()
// ALL tables share ONE Dexie prototype (F3), so the `playQueue` reads are
// answered here too — the same shape the other boot suites use.
Object.getPrototypeOf(db.userSettings).get = (async function (this: { name: string }, key: string) {
  if (this.name === 'playQueue') return undefined
  const value = rows.get(key)
  return value === undefined ? undefined : { key, value }
}) as never
Object.getPrototypeOf(db.userSettings).put = (async (entry: { key: string; value: unknown }) => {
  rows.set(entry.key, entry.value)
}) as never
Object.getPrototypeOf(db.localMetadata).toArray = (async () => []) as never

test('the shuffle switch survives a reload, and every press is written back', async () => {
  rows.set('userQueueShuffle', true)

  await initStores()

  assert.equal(get(userQueueShuffle), true, 'the saved switch is the boot value — no default clobber')

  // OFF round-trip: the press flips the store and the store layer persists it.
  queueManager.toggleUserQueueShuffle()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(get(userQueueShuffle), false, 'the press flips the live store')
  assert.equal(rows.get('userQueueShuffle'), false, 'turning it off is persisted')

  // ...and ON again, so the persisted value is not a one-way latch.
  queueManager.toggleUserQueueShuffle()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(get(userQueueShuffle), true)
  assert.equal(rows.get('userQueueShuffle'), true, 'turning it back on is persisted')
})
