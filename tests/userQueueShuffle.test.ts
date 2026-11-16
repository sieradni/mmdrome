// The pure user-queue shuffle model (2026-11-14): which rows may move on a
// press, what a repeat-all WRAP produces, and the wrap detection the native
// engine's own wrap needs. Deterministic RNGs stand in for Math.random.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isQueueWrap,
  planUserQueueShuffle,
  planWrapShuffle,
  shuffleChanged,
  shuffleFromIndex,
  shuffleIds,
  type ShuffleRng,
} from '../src/lib/userQueueShuffle'

/** Repeats one value — `0` always swaps with index 0, `0.999` never swaps. */
const fixed = (value: number): ShuffleRng => () => value

test('shuffleIds keeps every row exactly once', () => {
  const ids = ['a', 'b', 'c', 'a', 'd']
  const out = shuffleIds(ids, fixed(0))
  assert.equal(out.length, ids.length)
  assert.deepEqual([...out].sort(), [...ids].sort())
  // The input is never mutated.
  assert.deepEqual(ids, ['a', 'b', 'c', 'a', 'd'])
})

test('shuffleChanged always answers a different order when one exists', () => {
  const ids = ['a', 'b', 'c', 'd']
  // An RNG that would answer the input order unchanged (j === i on every step).
  assert.notDeepEqual(shuffleChanged(ids, fixed(0.9999999999)), ids)
  assert.notDeepEqual(shuffleChanged(['a', 'b'], fixed(0.9999999999)), ['a', 'b'])
  // Nothing can differ: one row, or every row the same song.
  assert.deepEqual(shuffleChanged(['a'], fixed(0.5)), ['a'])
  assert.deepEqual(shuffleChanged(['a', 'a'], fixed(0.5)), ['a', 'a'])
  // A boundary/NaN RNG still produces a valid permutation of the same rows.
  const weird = shuffleChanged(ids, () => Number.NaN)
  assert.deepEqual([...weird].sort(), [...ids].sort())
})

test('shuffleFromIndex: history through the audible row never moves', () => {
  assert.equal(shuffleFromIndex(['a', 'b', 'c'], 0), 1)
  assert.equal(shuffleFromIndex(['a', 'b', 'c'], 1), 2)
  // The audible row is the LAST user row: nothing is "up next".
  assert.equal(shuffleFromIndex(['a', 'b', 'c'], 2), 3)
  // The anchor is a suggestion (or absent): no user row has played this pass.
  assert.equal(shuffleFromIndex(['a', 'b', 'c'], 3), 0)
  assert.equal(shuffleFromIndex(['a', 'b', 'c'], -1), 0)
  assert.equal(shuffleFromIndex([], 0), 0)
})

test('planUserQueueShuffle reorders only what is still to come', () => {
  const userQueue = ['p1', 'p2', 'now', 'n1', 'n2', 'n3']
  const out = planUserQueueShuffle(userQueue, 2, fixed(0))
  assert.ok(out)
  // The played rows AND the audible row keep their exact positions.
  assert.deepEqual(out.slice(0, 3), userQueue.slice(0, 3))
  // ...and the upcoming rows are the same songs in a new order.
  assert.notDeepEqual(out.slice(3), userQueue.slice(3))
  assert.deepEqual([...out.slice(3)].sort(), [...userQueue.slice(3)].sort())
})

test('planUserQueueShuffle shuffles the whole section when the anchor is not a user row', () => {
  const userQueue = ['a', 'b', 'c', 'd']
  for (const activeIndex of [-1, 4, 9]) {
    const out = planUserQueueShuffle(userQueue, activeIndex, fixed(0))
    assert.ok(out)
    assert.notDeepEqual(out, userQueue)
    assert.deepEqual([...out].sort(), [...userQueue].sort())
  }
})

test('planUserQueueShuffle is a no-op (null) with nothing to reorder', () => {
  assert.equal(planUserQueueShuffle([], -1), null)
  assert.equal(planUserQueueShuffle(['a'], 0), null)
  // Only one row is up next: a "shuffle" of one row is not an order change.
  assert.equal(planUserQueueShuffle(['a', 'b'], 0), null)
  // The audible row is the last row — everything else is history.
  assert.equal(planUserQueueShuffle(['a', 'b', 'c'], 2), null)
})

test('planUserQueueShuffle keeps duplicate occurrences', () => {
  const userQueue = ['now', 'a', 'a', 'b', 'a']
  const out = planUserQueueShuffle(userQueue, 0, fixed(0))
  assert.ok(out)
  assert.equal(out[0], 'now')
  assert.equal(out.filter((id) => id === 'a').length, 3)
  assert.deepEqual([...out.slice(1)].sort(), ['a', 'a', 'a', 'b'])
})

test('planWrapShuffle reorders the whole section and never opens with the finished song', () => {
  const userQueue = ['a', 'b', 'c', 'd']
  // Every deterministic order this RNG can produce must still dodge `d`.
  for (const value of [0, 0.2, 0.5, 0.9, 0.9999999999]) {
    const out = planWrapShuffle(userQueue, 'd', fixed(value))
    assert.ok(out)
    assert.notEqual(out[0], 'd')
    assert.deepEqual([...out].sort(), [...userQueue].sort())
    assert.notDeepEqual(out, userQueue)
  }
})

test('planWrapShuffle tolerates a section that cannot avoid the finished song', () => {
  assert.equal(planWrapShuffle([], 'a'), null)
  assert.equal(planWrapShuffle(['a'], 'a'), null)
  // Every row is the same song: there is no other row to start the pass on,
  // and reordering cannot change anything either.
  assert.equal(planWrapShuffle(['a', 'a'], 'a'), null)
  // No finished-song information (a degraded path) still shuffles.
  const out = planWrapShuffle(['a', 'b'], undefined, fixed(0))
  assert.deepEqual(out, ['b', 'a'])
})

test('isQueueWrap: only a last-row → first-row handoff is a wrap', () => {
  assert.equal(isQueueWrap(4, 0, 5), true)
  assert.equal(isQueueWrap(1, 0, 5), false)
  assert.equal(isQueueWrap(4, 2, 5), false)
  // A one-row queue cannot wrap.
  assert.equal(isQueueWrap(0, 0, 1), false)
  assert.equal(isQueueWrap(-1, 0, 3), false)
})
