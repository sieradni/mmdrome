// The manager half of the user-queue shuffle (2026-11-14): the press, the
// switch, and the repeat-all wrap hook applied to the REAL queue store.
// The permutation rules are pinned by userQueueShuffle.test.ts; this suite
// closes the "decision vs application" gap — anchor preservation, the inert
// press writing nothing, and the switch gating the wrap.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { queueManager } from '../src/lib/queueManager'
import { queue, userQueueShuffle } from '../src/stores/appState'
import type { QueueState } from '../src/stores/appState'

// ALL tables on a Dexie instance share ONE prototype (F3), so patch `put` once
// and dispatch on the table name (same seam as queueManagerFill.test.ts).
const playQueueWrites: unknown[] = []
Object.getPrototypeOf(db.playQueue).put = (async function (this: { name: string }, entry: unknown) {
  if (this.name === 'playQueue') playQueueWrites.push(entry)
}) as never

function setQueue(q: Partial<QueueState>): void {
  queue.set({ userQueue: [], autoQueue: [], recentTrackIds: [], activeIndex: 0, ...q })
  playQueueWrites.length = 0
}

test('shuffleUserQueue reorders the upcoming rows and keeps the audible row anchored', () => {
  setQueue({ userQueue: ['a', 'b', 'c', 'd', 'e'], activeIndex: 2 })
  queueManager.shuffleUserQueue()
  const q = get(queue)
  assert.deepEqual(q.userQueue.slice(0, 3), ['a', 'b', 'c'])
  assert.deepEqual([...q.userQueue.slice(3)].sort(), ['d', 'e'])
  // The audible occurrence never moves, so the anchor is untouched.
  assert.equal(q.activeIndex, 2)
  assert.equal(playQueueWrites.length, 1)
})

test('an inert press writes nothing', () => {
  setQueue({ userQueue: ['a'], activeIndex: 0 })
  queueManager.shuffleUserQueue()
  assert.equal(playQueueWrites.length, 0)
  assert.deepEqual(get(queue).userQueue, ['a'])
})

test('the switch turns on with one immediate shuffle', () => {
  userQueueShuffle.set(false)
  setQueue({ userQueue: ['a', 'b', 'c', 'd'], activeIndex: 0 })
  queueManager.toggleUserQueueShuffle()
  const q = get(queue)
  assert.equal(get(userQueueShuffle), true)
  assert.equal(q.userQueue[0], 'a')
  assert.notDeepEqual(q.userQueue, ['a', 'b', 'c', 'd'])
  assert.equal(q.activeIndex, 0)
  // Turning it off NEVER reorders (there is no snapshot to restore).
  const order = get(queue).userQueue
  queueManager.toggleUserQueueShuffle()
  assert.equal(get(userQueueShuffle), false)
  assert.deepEqual(get(queue).userQueue, order)
  assert.equal(playQueueWrites.length, 1)
})

test('reshuffleForWrap is gated by the switch and anchors the new pass at row 0', () => {
  userQueueShuffle.set(false)
  setQueue({ userQueue: ['a', 'b', 'c'], activeIndex: 2 })
  assert.equal(queueManager.reshuffleForWrap('c'), false)
  assert.deepEqual(get(queue).userQueue, ['a', 'b', 'c'])
  assert.equal(get(queue).activeIndex, 2)
  assert.equal(playQueueWrites.length, 0)

  userQueueShuffle.set(true)
  playQueueWrites.length = 0
  assert.equal(queueManager.reshuffleForWrap('c'), true)
  const q = get(queue)
  // The finished song does not open the new pass, and the pass starts at 0.
  assert.notEqual(q.userQueue[0], 'c')
  assert.deepEqual([...q.userQueue].sort(), ['a', 'b', 'c'])
  assert.equal(q.activeIndex, 0)
  // One write carries BOTH the order and the anchor — never a torn state.
  assert.equal(playQueueWrites.length, 1)
  userQueueShuffle.set(false)
})

test('reshuffleForWrap leaves a single-row section alone', () => {
  userQueueShuffle.set(true)
  setQueue({ userQueue: ['a'], activeIndex: 0 })
  assert.equal(queueManager.reshuffleForWrap('a'), false)
  assert.equal(playQueueWrites.length, 0)
  userQueueShuffle.set(false)
})
