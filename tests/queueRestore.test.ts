// Restore characterization (Phase 2A gate item 4, 2026-10-21): what a legacy
// or corrupt persisted queue row becomes after `initStores` reads it, and what
// the first full library sync does to rows the library no longer contains.
//
// `initStores` is once-per-process, so the restore-dependent assertions live
// in the first test; the later tests drive the SAME restored state through the
// library reconcile (documented in each test). Stubbing follows
// tests/autoQueueFiltersPersistence.test.ts — Dexie tables share one
// prototype, so `get`/`toArray` are patched once and dispatch on `this.name`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { initStores, queue, setLibrary, library, type QueueState, type Track } from '../src/stores/appState'

const PERSISTED = {
  id: 'main',
  // A legacy row: duplicate user rows, a duplicate auto row, and an active
  // index that points PAST two duplicates that the restore will collapse.
  userQueue: ['a', 'b', 'a', 'c'],
  autoQueue: ['d', 'd', 'e'],
  recentTrackIds: ['r1', 'r1', 'r2'],
  activeIndex: 4,
}

Object.getPrototypeOf(db.userSettings).get = (async function (this: { name: string }, key: string) {
  if (this.name === 'playQueue') return PERSISTED
  void key
  return undefined
}) as never
Object.getPrototypeOf(db.userSettings).put = (async () => undefined) as never
Object.getPrototypeOf(db.localMetadata).toArray = (async () => []) as never

const track = (trackId: string): Track => ({
  trackId,
  title: trackId,
  artist: 'A',
  album: 'B',
  duration: 180,
  fileType: 'mp3',
})

function combined(q: QueueState): string[] {
  return [...q.userQueue, ...q.autoQueue]
}

test('restore dedupes each section (first occurrence wins), re-anchors the active row by id, and sanitizes recents', async () => {
  await initStores()

  const q = get(queue)
  assert.deepEqual(q.userQueue, ['a', 'b', 'c'], 'user duplicates collapse, first occurrence wins')
  assert.deepEqual(q.autoQueue, ['d', 'e'], 'auto duplicates collapse too')
  assert.deepEqual(combined(q), ['a', 'b', 'c', 'd', 'e'])

  // The persisted activeIndex (4) named the FIRST 'd' in the old combined
  // array. After two collapsed duplicates sit above it, the same row is 3 —
  // a pasted index would name 'e' instead. Re-anchoring is by ID.
  assert.equal(q.activeIndex, 3)
  assert.equal(combined(q)[q.activeIndex], 'd', 'the audible row survives the dedupe')

  // The queue keeps FIRST occurrences while recents keep the NEWEST (the two
  // sanitizers disagree by design — each section's semantic).
  assert.deepEqual(q.recentTrackIds, ['r1', 'r2'])
})

test('a library sync that no longer contains the active track drops it and clears the anchor (-1)', () => {
  // Continues from the restored queue: ['a','b','c'] + ['d','e'], active 'd'.
  const remaining = ['a', 'b', 'c', 'e'].map(track) // 'd' vanished from the server
  setLibrary(remaining)

  const q = get(queue)
  assert.deepEqual(q.userQueue, ['a', 'b', 'c'])
  assert.deepEqual(q.autoQueue, ['e'], 'the stale id is removed from the auto section')
  assert.equal(q.activeIndex, -1, 'nothing is playing a track the library lost')

  // The library itself is authoritative (one source of truth for the sync).
  assert.deepEqual(get(library).map((t) => t.trackId), ['a', 'b', 'c', 'e'])
})

test('a library sync that keeps the active track re-anchors it by id after rows above it are pruned', () => {
  // The playing row is 'd' at index 3 of ['a','b','c','d','e'].
  queue.set({ userQueue: ['a', 'b', 'c', 'd'], autoQueue: ['e'], recentTrackIds: [], activeIndex: 3 })

  // The library loses 'a' and 'b' — two rows ABOVE the playing row.
  setLibrary(['c', 'd', 'e'].map(track))

  const q = get(queue)
  assert.deepEqual(combined(q), ['c', 'd', 'e'])
  assert.equal(q.activeIndex, 1, 'the index followed the row, not the old position')
  assert.equal(combined(q)[q.activeIndex], 'd')
})
