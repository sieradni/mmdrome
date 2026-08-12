import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addToUserQueue,
  applyQueueMutation,
  clearQueue,
  moveToEnd,
  moveToNext,
  playNext,
  promoteActiveTrack,
  promoteToUser,
  promoteToUserNext,
  removeFromAutoQueue,
  type QueueMutation,
} from '../src/lib/queueMutation'
import type { QueueState } from '../src/stores/appState'

function q(userQueue: string[], autoQueue: string[], activeIndex: number, recentTrackIds: string[] = []): QueueState {
  return { userQueue, autoQueue, recentTrackIds, activeIndex }
}

function combined(s: QueueState): string[] {
  return [...s.userQueue, ...s.autoQueue]
}

/** Deterministic PRNG (mulberry32) so the fuzz is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('promoteActiveTrack: active row in auto at auto[0] promotes to the user tail', () => {
  const s = q(['a', 'b'], ['c', 'd', 'e'], 2)
  const r = applyQueueMutation(s, (x) => promoteActiveTrack(x))!
  assert.deepEqual(r.userQueue, ['a', 'b', 'c'])
  assert.deepEqual(r.autoQueue, ['d', 'e'])
  assert.equal(r.activeIndex, 2)
})

test('promoteActiveTrack collapses a tier-3 cross-section duplicate (no second user copy)', () => {
  const s = q(['a', 'b', 'c'], ['c', 'd'], 2)
  const r = applyQueueMutation(s, (x) => promoteActiveTrack(x))!
  assert.deepEqual(r.userQueue, ['a', 'b', 'c'])
  assert.deepEqual(r.autoQueue, ['d'])
  assert.equal(r.activeIndex, 2)
})

test('promoteActiveTrack works in the transition window (active row deep in auto)', () => {
  const s = q(['x'], ['p', 'q', 'r'], 3)
  const r = applyQueueMutation(s, (x) => promoteActiveTrack(x))!
  assert.deepEqual(r.userQueue, ['x', 'r'])
  assert.deepEqual(r.autoQueue, [])
  assert.equal(r.activeIndex, 1)
})

test('promoteActiveTrack is a no-op when the active row is not in auto', () => {
  const s = q(['a', 'b'], ['c'], 1)
  assert.equal(applyQueueMutation(s, (x) => promoteActiveTrack(x)), null)
  assert.equal(applyQueueMutation(q([], [], -1), (x) => promoteActiveTrack(x)), null)
})

test('playNext inserts a new track right after the active row (anchor re-indexes)', () => {
  const s = q(['a', 'b', 'c'], [], 1)
  const r = applyQueueMutation(s, (x) => playNext(x, 'x'))!
  assert.deepEqual(r.userQueue, ['a', 'b', 'x', 'c'])
  assert.equal(r.activeIndex, 1)
})

test('playNext no-ops when the row already occupies the next slot', () => {
  const s = q(['a', 'b', 'c'], [], 1)
  assert.equal(applyQueueMutation(s, (x) => playNext(x, 'c')), null)
})

test('playNext dedupe-moves an existing user copy', () => {
  const s = q(['a', 'b', 'c'], [], 1)
  const r = applyQueueMutation(s, (x) => playNext(x, 'a'))!
  assert.deepEqual(r.userQueue, ['b', 'a', 'c'])
  assert.equal(r.activeIndex, 0)
})

test('addToUserQueue appends and refuses duplicates', () => {
  const r = applyQueueMutation(q(['a'], [], 0), (x) => addToUserQueue(x, 'b'))!
  assert.deepEqual(r.userQueue, ['a', 'b'])
  assert.equal(applyQueueMutation(q(['a'], [], 0), (x) => addToUserQueue(x, 'a')), null)
})

test('promoteToUser appends when absent, keeps the user copy when present', () => {
  const r = applyQueueMutation(q(['a'], ['b', 'c'], 0), (x) => promoteToUser(x, 'b'))!
  assert.deepEqual(r.userQueue, ['a', 'b'])
  assert.deepEqual(r.autoQueue, ['c'])
  assert.equal(r.activeIndex, 0)

  const r2 = applyQueueMutation(q(['a', 'b'], ['b', 'c'], 0), (x) => promoteToUser(x, 'b'))!
  assert.deepEqual(r2.userQueue, ['a', 'b'])
  assert.deepEqual(r2.autoQueue, ['c'])
  assert.equal(r2.activeIndex, 0)

  assert.equal(applyQueueMutation(q(['a'], ['b'], 0), (x) => promoteToUser(x, 'zzz')), null)
})

test('promoteToUserNext always drops the auto copy (cross-section duplicate never survives)', () => {
  const r = applyQueueMutation(q(['a', 'c', 'd'], ['c', 'e'], 1), (x) => promoteToUserNext(x, 'c'))!
  assert.deepEqual(r.userQueue, ['a', 'c', 'd'])
  assert.deepEqual(r.autoQueue, ['e'])
  assert.equal(r.activeIndex, 1)

  const r2 = applyQueueMutation(q(['a', 'd', 'b'], ['b'], 0), (x) => promoteToUserNext(x, 'b'))!
  assert.deepEqual(r2.userQueue, ['a', 'b', 'd'])
  assert.deepEqual(r2.autoQueue, [])
  assert.equal(r2.activeIndex, 0)
})

test('moveToNext reorders a user row to just after the active row', () => {
  const r = applyQueueMutation(q(['a', 'b', 'c', 'd'], [], 0), (x) => moveToNext(x, 'c'))!
  assert.deepEqual(r.userQueue, ['a', 'c', 'b', 'd'])
  assert.equal(r.activeIndex, 0)

  assert.equal(applyQueueMutation(q(['a', 'b'], [], 0), (x) => moveToNext(x, 'b')), null)
  assert.equal(applyQueueMutation(q(['a', 'b'], [], 0), (x) => moveToNext(x, 'zzz')), null)
})

test('moveToEnd moves a user row to the very end (anchor follows the moved id)', () => {
  const r = applyQueueMutation(q(['a', 'b', 'c'], [], 0), (x) => moveToEnd(x, 'a'))!
  assert.deepEqual(r.userQueue, ['b', 'c', 'a'])
  assert.equal(r.activeIndex, 2)
  assert.equal(applyQueueMutation(q(['a', 'b'], [], 0), (x) => moveToEnd(x, 'zzz')), null)
})

test('removeFromAutoQueue filters the row and cools it down in the recency window', () => {
  const s = q(['a'], ['x', 'y'], 1, ['k'])
  const r = applyQueueMutation(s, (x) => removeFromAutoQueue(x, 'y'))!
  assert.deepEqual(r.autoQueue, ['x'])
  assert.deepEqual(r.recentTrackIds, ['k', 'y'])
  assert.equal(r.activeIndex, 1)

  const r2 = applyQueueMutation(q(['a'], ['x'], 0, ['x', 'y']), (x) => removeFromAutoQueue(x, 'x'))!
  assert.deepEqual(r2.recentTrackIds, ['y', 'x'])
  assert.equal(applyQueueMutation(q(['a'], ['x'], 0), (x) => removeFromAutoQueue(x, 'zzz')), null)
})

test('clearQueue keeps the active track at user[0] and preserves the recency window', () => {
  const s = q(['a', 'b'], ['c'], 1, ['m', 'n'])
  const r = applyQueueMutation(s, (x) => clearQueue(x))!
  assert.deepEqual(r.userQueue, ['b'])
  assert.deepEqual(r.autoQueue, [])
  assert.deepEqual(r.recentTrackIds, ['m', 'n'])
  assert.equal(r.activeIndex, 0)

  const r2 = applyQueueMutation(q([], [], -1), (x) => clearQueue(x))!
  assert.deepEqual(r2.userQueue, [])
  assert.deepEqual(r2.autoQueue, [])
  assert.equal(r2.activeIndex, -1)
})

test('a null mutation produces no state change (no store write)', () => {
  const s = q(['a'], ['b'], 0)
  assert.equal(applyQueueMutation(s, () => null), null)
})

test('fuzz: anchor invariant, uniqueness, drag row-count preservation (10k x 6 seeds)', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `t${i}`)
  const ops: Array<{ name: string; drag?: boolean; run: (s: QueueState, id: string) => QueueMutation | null }> = [
    { name: 'add', run: (s, id) => addToUserQueue(s, id) },
    { name: 'playNext', run: (s, id) => playNext(s, id) },
    { name: 'promoteUser', drag: true, run: (s, id) => promoteToUser(s, id) },
    { name: 'promoteUserNext', drag: true, run: (s, id) => promoteToUserNext(s, id) },
    { name: 'moveNext', drag: true, run: (s, id) => moveToNext(s, id) },
    { name: 'moveEnd', drag: true, run: (s, id) => moveToEnd(s, id) },
    { name: 'removeAuto', run: (s, id) => removeFromAutoQueue(s, id) },
    { name: 'promoteActive', run: (s) => promoteActiveTrack(s) },
    { name: 'clear', run: (s) => clearQueue(s) },
  ]

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const rnd = mulberry32(seed)
    let s: QueueState = q([], [], -1)
    for (let i = 0; i < 10; i++) {
      s = applyQueueMutation(s, (x) => addToUserQueue(x, ids[Math.floor(rnd() * ids.length)])) ?? s
    }
    for (let iter = 0; iter < 10000; iter++) {
      const op = ops[Math.floor(rnd() * ops.length)]
      const id = ids[Math.floor(rnd() * ids.length)]
      const pre = combined(s)
      const activeId = s.activeIndex >= 0 && s.activeIndex < pre.length ? pre[s.activeIndex] : undefined
      const result = applyQueueMutation(s, (x) => op.run(x, id))
      if (result === null) continue
      s = result
      const c = combined(s)
      assert.equal(new Set(s.userQueue).size, s.userQueue.length, `user duplicate (seed ${seed} iter ${iter})`)
      assert.equal(new Set(s.autoQueue).size, s.autoQueue.length, `auto duplicate (seed ${seed} iter ${iter})`)
      if (activeId !== undefined) {
        assert.ok(
          s.userQueue.includes(activeId) || s.autoQueue.includes(activeId),
          `active id dropped (seed ${seed} iter ${iter})`,
        )
        assert.ok(s.activeIndex >= 0 && s.activeIndex < c.length, `anchor out of range (seed ${seed} iter ${iter})`)
        assert.equal(c[s.activeIndex], activeId, `anchor invariant violated (seed ${seed} iter ${iter})`)
      } else {
        assert.equal(s.activeIndex, -1, `empty queue must anchor at -1 (seed ${seed} iter ${iter})`)
      }
      if (op.drag) {
        assert.equal(c.length, pre.length, `drag must preserve row count (seed ${seed} iter ${iter})`)
      }
    }
  }
})
