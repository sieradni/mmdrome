// The other half of the persisted-queue restore (Phase 2A gate item 4):
// `initStores` is once-per-process, so the out-of-range-anchor and legacy
// `historyQueue` shapes get their own file.
//
// The restore falls back to `-1` when the persisted activeIndex cannot name a
// row at all; it must never keep an index that points outside the queue the
// app then renders.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { initStores, queue } from '../src/stores/appState'

const PERSISTED = {
  id: 'main',
  userQueue: ['a', 'b'],
  autoQueue: [],
  // No recentTrackIds: an app version before the rename persisted the
  // anti-repeat window as `historyQueue` (`??` fallback in restoreLocalState).
  historyQueue: ['h-old', 'h-older', 'h-new'],
  activeIndex: 99,
}

Object.getPrototypeOf(db.userSettings).get = (async function (this: { name: string }) {
  if (this.name === 'playQueue') return PERSISTED
  return undefined
}) as never
Object.getPrototypeOf(db.userSettings).put = (async () => undefined) as never
Object.getPrototypeOf(db.localMetadata).toArray = (async () => []) as never

test('restore clears an out-of-range anchor and reads the legacy historyQueue field', async () => {
  await initStores()

  const q = get(queue)
  assert.deepEqual(q.userQueue, ['a', 'b'])
  assert.equal(q.activeIndex, -1, 'an anchor past the queue end is never kept')
  assert.deepEqual(q.recentTrackIds, ['h-old', 'h-older', 'h-new'], 'legacy field accepted and order preserved')
})
