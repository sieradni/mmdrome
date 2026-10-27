// Bulk play/enqueue characterization (Phase 2A gate item 2, 2026-10-21).
//
// `playAll` is the wholesale bulk entry point (Songs/Album/Artist "Play All",
// and the server-playlist import boundary). Unlike every mutation builder it
// replaces the user section wholesale, so its contract is stated once, here:
// order and duplicates are preserved verbatim (an occurrence log), and D12/G4
// validates the ids against the library — unknown ids are dropped AND
// reported, nothing resolving means no write at all, and an unresolved id
// while the library is still loading DEFERS the import instead of dropping
// rows that merely are not loaded yet.

import './stub-audio-worklet-node'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { queueManager } from '../src/lib/queueManager'
import {
  queue,
  library,
  currentTrack,
  navidromeLoadStatus,
  setCurrentTrack,
  setLibrary,
  type Track,
  type QueueState,
} from '../src/stores/appState'

// advanceTo/playAll persist through saveQueue → Dexie; there is no IndexedDB
// in Node, so the table write is stubbed (F3: patch the real db's table).
Object.getPrototypeOf(db.playQueue).put = (async () => undefined) as never

const track = (trackId: string): Track => ({
  trackId,
  title: trackId,
  artist: 'A',
  album: 'B',
  duration: 180,
  fileType: 'mp3',
})

function setQueue(q: Partial<QueueState>): void {
  queue.set({ userQueue: [], autoQueue: [], recentTrackIds: [], activeIndex: -1, ...q })
}

function reset(ids: string[]): void {
  library.set(ids.map(track))
  setCurrentTrack(null)
  setQueue({})
}

/** Every row in both sections, in combined order. */
function combined(): string[] {
  const q = get(queue)
  return [...q.userQueue, ...q.autoQueue]
}

/** Occurrence identity means duplicates are LEGAL: never assert uniqueness
 *  here. This helper is kept to state the opposite contract explicitly. */
function assertOccurrenceOrder(q: QueueState, expected: string[]): void {
  assert.deepEqual([...q.userQueue, ...q.autoQueue], expected)
}

test('playAll([]) writes NOTHING — an empty import never empties a live queue (G4 closed)', () => {
  reset(['a', 'b'])
  setQueue({ userQueue: ['a', 'b'], autoQueue: [], recentTrackIds: ['r'], activeIndex: 1 })

  const report = queueManager.playAll([])

  const q = get(queue)
  assert.deepEqual(report, { accepted: [], dropped: [], deferred: false })
  assert.deepEqual(q.userQueue, ['a', 'b'], 'zero resolved ids → no write at all')
  assert.equal(q.activeIndex, 1, 'the live anchor is never reset to 0 on an empty import')
  assert.deepEqual(q.recentTrackIds, ['r'], 'the window is untouched by a no-op import')
})

test('playAll preserves duplicate ids verbatim — duplicates are legal occurrences (D3/D12)', () => {
  reset(['a', 'b'])
  setQueue({ userQueue: ['x'], activeIndex: 0 })

  queueManager.playAll(['a', 'a', 'b'])

  let q = get(queue)
  assert.deepEqual(q.userQueue, ['a', 'a', 'b'], 'the import order and its duplicates are kept')
  assert.equal(q.activeIndex, 0)
  assert.equal(q.userQueue.filter((id) => id === 'a').length, 2, 'two independent rows')

  // The library sync keeps both copies too (membership filter, no dedupe).
  setLibrary(['a', 'b'].map(track))
  q = get(queue)
  assert.deepEqual(q.userQueue, ['a', 'a', 'b'], 'a library reconcile preserves occurrences')

  // + is an append, not a set insert: the queue can now represent the same
  // song three times.
  queueManager.addToUserQueue('a')
  assert.deepEqual(get(queue).userQueue, ['a', 'a', 'b', 'a'], 'addToUserQueue appends a new occurrence')
  assertOccurrenceOrder(get(queue), ['a', 'a', 'b', 'a'])
})

test('playAll validates against the library: unknown ids are dropped and REPORTED, never queued (G4/D12)', () => {
  reset(['a', 'b'])
  setCurrentTrack(track('a'))

  const report = queueManager.playAll(['a', 'gone', 'b'])

  assert.deepEqual(report.accepted, ['a', 'b'], 'only ids the library knows are queued')
  assert.deepEqual(report.dropped, ['gone'], 'the unresolved id is reported, never silently discarded')
  assert.equal(report.deferred, false)
  assert.deepEqual(combined(), ['a', 'b'], 'no anchor can rest on an unresolvable row')
  assert.equal(get(queue).activeIndex, 0)

  // The consequence the gap used to have: the first advance now resolves a
  // REAL track instead of null, so playback cannot hang on a missing row.
  assert.equal(queueManager.advanceQueue()?.trackId, 'b')
})

test('playAll DEFERS while the library is loading — an unresolved id may only be unloaded (D12)', () => {
  reset(['a', 'b'])
  setQueue({ userQueue: ['a'], activeIndex: 0 })
  navidromeLoadStatus.set({ loading: true, loaded: 2, failed: 0 })
  try {
    const report = queueManager.playAll(['a', 'b', 'not-loaded-yet'])

    assert.equal(report.deferred, true)
    assert.deepEqual(report.accepted, [], 'a deferral applies nothing')
    assert.deepEqual(get(queue).userQueue, ['a'], 'the live queue is untouched')
  } finally {
    navidromeLoadStatus.set({ loading: false, loaded: 0, failed: 0 })
  }

  // Once the load finishes the same import resolves.
  const retry = queueManager.playAll(['a', 'b'])
  assert.equal(retry.deferred, false)
  assert.deepEqual(get(queue).userQueue, ['a', 'b'])
})

test('playAll with the actively playing track inside the import anchors on row 0 (the import is authoritative)', () => {
  reset(['a', 'b', 'y', 'c'])
  setCurrentTrack(track('y'))
  setQueue({ userQueue: ['x', 'y'], activeIndex: 1 })

  queueManager.playAll(['a', 'b', 'y', 'c'])

  const q = get(queue)
  assert.deepEqual(q.userQueue, ['a', 'b', 'y', 'c'])
  assert.equal(q.activeIndex, 0, 'the bulk import replaces the listening position; the caller starts row 0')
  assert.equal(combined().filter((id) => id === 'y').length, 1, 'the previously playing row is not duplicated or promoted')
  assert.equal(get(currentTrack)?.trackId, 'y', 'playAll only rewrites the queue — currentTrack is the caller’s concern')

  // Promotion is a user-section no-op, so nothing moves the anchor off row 0.
  queueManager.promoteActiveTrack()
  assert.equal(get(queue).activeIndex, 0)
})

test('a cross-section duplicate is two rows; promoting the auto occurrence appends a user occurrence', () => {
  reset(['a', 'b', 'c'])
  setQueue({ userQueue: ['a'], autoQueue: ['b', 'c'], activeIndex: 0 })

  queueManager.addToUserQueue('b')

  let q = get(queue)
  assert.deepEqual(q.userQueue, ['a', 'b'], 'the user row is added')
  assert.deepEqual(q.autoQueue, ['b', 'c'], 'the auto occurrence is left alone (cross-section duplicates are legal)')
  assert.equal(combined().filter((id) => id === 'b').length, 2, 'one occurrence per section')

  // Promoting the AUTO occurrence moves it into the user section as a NEW
  // occurrence: the older user copy is history and stays put.
  queueManager.promoteToUser(0)
  q = get(queue)
  assert.deepEqual(q.userQueue, ['a', 'b', 'b'], 'the auto row became a second user occurrence')
  assert.deepEqual(q.autoQueue, ['c'], 'the promoted auto occurrence left its section')
  assert.equal(combined().filter((id) => id === 'b').length, 2, 'no row was collapsed or lost')
  assert.equal(q.activeIndex, 0)
})

test('playNext on an empty queue appends the row and keeps the anchor unset until playback selects one', () => {
  reset(['a'])
  assert.equal(get(queue).activeIndex, -1)

  queueManager.playNext('a')

  const q = get(queue)
  assert.deepEqual(q.userQueue, ['a'])
  assert.equal(q.activeIndex, -1, 'the mutation surface never invents an active row')

  // The first advance from a stopped queue targets activeIndex + 1 = 0.
  assert.equal(queueManager.advanceQueue()?.trackId, 'a')
  assert.equal(get(queue).activeIndex, 0)
})

test('playAll resets the anti-repeat window and drops the auto tail in the same flow', () => {
  reset(['a', 'b'])
  setQueue({ userQueue: ['x'], autoQueue: ['y', 'z'], recentTrackIds: ['r1', 'r2'], activeIndex: 0 })

  queueManager.playAll(['a', 'b'])

  const q = get(queue)
  assert.deepEqual(q.recentTrackIds, [], 'explicit bulk replay supersedes anti-repeat memory')
  assert.deepEqual(q.autoQueue, [], 'a stale auto tail must not survive an unrelated play-all')
  assert.deepEqual(q.userQueue, ['a', 'b'])
})
