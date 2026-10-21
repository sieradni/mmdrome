// Restore + library reconcile characterization (queue redesign step 1,
// 2026-10-21; supersedes the Phase 2A dedupe snapshot).
//
// Restore is a RAW PASS-THROUGH (D13): the persisted rows are kept verbatim,
// duplicates included — a row is an occurrence now, so a legacy duplicate is
// legal and must not be silently deleted. With no dedupe the stored anchor is
// exact, so only bounds are checked.
//
// A library sync prunes unknown ids and re-anchors BY COUNT (subtract the rows
// removed above the old index). `indexOf(id)` would land on an earlier copy
// once duplicates exist — the wrong row.
//
// `initStores` is once-per-process, so the restore-dependent assertions live
// in the first test; later tests drive the SAME state (or an explicit
// queue.set) through the library reconcile. Stubbing follows
// tests/autoQueueFiltersPersistence.test.ts — Dexie tables share one
// prototype, so `get`/`toArray` are patched once and dispatch on `this.name`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { initStores, queue, setLibrary, library, type QueueState, type Track } from '../src/stores/appState'
import { entryIdAt } from '../src/lib/queueOccurrence'

const PERSISTED = {
  id: 'main',
  // A legacy row: duplicate user rows, a duplicate auto row, and an active
  // index that names the FIRST 'd' AFTER both user copies.
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

test('restore keeps persisted rows VERBATIM (duplicates included), the exact stored anchor, and sanitizes recents', async () => {
  await initStores()

  const q = get(queue)
  assert.deepEqual(q.userQueue, ['a', 'b', 'a', 'c'], 'legacy user duplicates survive restore')
  assert.deepEqual(q.autoQueue, ['d', 'd', 'e'], 'legacy auto duplicates survive restore')
  assert.deepEqual(combined(q), ['a', 'b', 'a', 'c', 'd', 'd', 'e'])

  // The stored index is exact because nothing was collapsed: 4 names the
  // first 'd'. Deduping "for safety" would have deleted the history this
  // queue exists to keep (D13).
  assert.equal(q.activeIndex, 4)
  assert.equal(combined(q)[q.activeIndex], 'd', 'the audible row survives restore')

  // Recents keep the NEWEST occurrence (sanitizeRecent's semantic), while the
  // queue keeps every occurrence (its own semantic).
  assert.deepEqual(q.recentTrackIds, ['r1', 'r2'])
})

test('the restored duplicate rows have distinct occurrence entry ids', async () => {
  const q = get(queue)
  assert.equal(entryIdAt(q.userQueue, q.autoQueue, 0), 'user:a')
  assert.equal(entryIdAt(q.userQueue, q.autoQueue, 2), 'user:a#1')
  assert.equal(entryIdAt(q.userQueue, q.autoQueue, 4), 'auto:d')
  assert.equal(entryIdAt(q.userQueue, q.autoQueue, 5), 'auto:d#1')
})

test('a library sync that loses the audible track clears the anchor and keeps the other copies', () => {
  // Continues from the restored queue: ['a','b','a','c'] + ['d','d','e'],
  // active 'd' (the first auto d).
  const remaining = ['a', 'b', 'c', 'e'].map(track) // every 'd' vanished from the server
  setLibrary(remaining)

  const q = get(queue)
  assert.deepEqual(q.userQueue, ['a', 'b', 'a', 'c'], 'the user duplicate is preserved')
  assert.deepEqual(q.autoQueue, ['e'], 'both stale auto occurrences are removed')
  assert.equal(q.activeIndex, -1, 'nothing is playing a track the library lost')

  assert.deepEqual(get(library).map((t) => t.trackId), ['a', 'b', 'c', 'e'])
})

test('a library sync that keeps the audible row re-anchors BY COUNT after pruning rows above it', () => {
  // The audible row is the SECOND 'a' (combined index 2). Removing the 'x'
  // above it must land the anchor on the other 'a' — `indexOf('a')` would
  // return 0, the wrong copy.
  queue.set({ userQueue: ['a', 'x', 'a', 'b'], autoQueue: [], recentTrackIds: [], activeIndex: 2 })

  setLibrary(['a', 'b'].map(track))

  const q = get(queue)
  assert.deepEqual(combined(q), ['a', 'a', 'b'])
  assert.equal(q.activeIndex, 1, 'count-based re-anchor, not indexOf(id)')
  assert.equal(combined(q)[q.activeIndex], 'a')
})

test('a library sync that keeps the active track re-anchors it by count after rows above it are pruned', () => {
  queue.set({ userQueue: ['a', 'b', 'c', 'd'], autoQueue: ['e'], recentTrackIds: [], activeIndex: 3 })

  setLibrary(['c', 'd', 'e'].map(track))

  const q = get(queue)
  assert.deepEqual(combined(q), ['c', 'd', 'e'])
  assert.equal(q.activeIndex, 1, 'the index followed the rows, not the old position')
  assert.equal(combined(q)[q.activeIndex], 'd')
})
