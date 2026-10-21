// Bulk play/enqueue characterization (Phase 2A gate item 2, 2026-10-21).
//
// `playAll` is the wholesale bulk entry point (Songs/Album/Artist "Play All",
// and the future playlist boundary). Unlike every mutation builder it writes
// the caller's array VERBATIM — no section dedupe, no library check. These
// tests characterize that boundary precisely so a future change (or a playlist
// feature feeding it duplicate/stale ids) is a deliberate decision, not an
// accident. Several pin CURRENT behavior that the invariant matrix records as
// a known gap — see docs/QUEUE-INVARIANTS.md and the 2026-10-21 ledger in
// docs/plans/2026-10-18-holistic-polish-and-roadmap.md.

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

test('playAll([]) clears the queue; the next advance refills the auto tail and skips its head (known gap)', () => {
  reset(['a', 'b'])
  setQueue({ userQueue: ['a', 'b'], activeIndex: 1 })

  queueManager.playAll([])

  let q = get(queue)
  assert.deepEqual(q.userQueue, [], 'an empty import empties the user section')
  assert.deepEqual(q.autoQueue, [], 'the auto tail is always dropped by a bulk import')
  assert.equal(q.activeIndex, 0, 'KNOWN GAP: an empty import leaves activeIndex 0 on an empty queue')
  assert.equal(combined().length, 0)

  // The next advance reads `activeIndex + 1` (1) BEFORE the refill, then the
  // refill puts the library back in the auto queue — so the anchor lands on
  // the refilled SECOND row and the head is skipped with no recency mark.
  assert.equal(queueManager.advanceQueue()?.trackId, 'b')
  q = get(queue)
  assert.deepEqual(q.autoQueue, ['a', 'b'], 'the library refilled the auto tail')
  assert.equal(q.activeIndex, 1)
  assert.equal(combined()[q.activeIndex], 'b', 'KNOWN GAP: the refilled head was never made active')
  assert.ok(!q.recentTrackIds.includes('a'), 'the skipped head is not even marked as heard')
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

test('playAll keeps ids missing from the library queued; advancing onto one stalls until playback stops', () => {
  reset(['a', 'b'])
  setCurrentTrack(track('a'))
  queueManager.playAll(['a', 'gone', 'b'])

  assert.equal(queueManager.findTrack('gone'), undefined, 'a missing library id resolves to no track')
  assert.deepEqual(combined(), ['a', 'gone', 'b'], 'the import is not validated against the library')

  // Advance #1: the anchor moves to the missing row and the chain resolves
  // null — the caller stops playback, but `currentTrack` is still the old row
  // until it does.
  assert.equal(queueManager.advanceQueue(), null)
  let q = get(queue)
  assert.equal(q.activeIndex, 1)
  assert.equal(combined()[q.activeIndex], 'gone', 'KNOWN GAP: the anchor can rest on an unresolvable id')
  assert.ok(q.recentTrackIds.includes('a'), 'the leaving track still cools down (one write)')

  // While the stale currentTrack lingers, advanceTargetIndex reads the mismatch
  // as "the active row was removed" and RE-TARGETS the same missing row — the
  // stall. Only the stop (currentTrack cleared) moves past it.
  assert.equal(queueManager.advanceQueue(), null, 're-targets the unresolvable row while currentTrack is stale')
  assert.equal(get(queue).activeIndex, 1)

  setCurrentTrack(null)
  assert.equal(queueManager.advanceQueue()?.trackId, 'b', 'after the stop, the next advance resolves again')
  assert.equal(get(queue).activeIndex, 2)
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
