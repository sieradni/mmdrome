import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyQueueMutation,
  convertAutoUpTo,
  promoteManyToUser,
  removeRows,
  replaceUserQueue,
} from '../src/lib/queueMutation'
import type { QueueState } from '../src/stores/appState'

// The multi-select / queue-conversion reducers (2026-11-04):
//   - `convertAutoUpTo` turns a suggestion PREFIX into user rows without
//     reordering the combined queue (so the anchor needs no arithmetic, only
//     the validated hint that survives the section change);
//   - `promoteManyToUser` promotes a whole selection in one write and keeps the
//     audible row anchored whichever side of the selection it sits on;
//   - `replaceUserQueue` replaces the log while never deleting the loaded row;
//   - `removeRows` removes a set in one write with position anchors and cools
//     every removed id.

function q(userQueue: string[], autoQueue: string[], activeIndex: number, recentTrackIds: string[] = []): QueueState {
  return { userQueue, autoQueue, recentTrackIds, activeIndex }
}

function combined(s: QueueState): string[] {
  return [...s.userQueue, ...s.autoQueue]
}

// ── convertAutoUpTo ─────────────────────────────────────────────────────────

test('convert up to here moves the prefix into the user queue and keeps the combined order', () => {
  const before = q(['a'], ['b', 'c', 'd'], 0)
  const after = applyQueueMutation(before, (state) => convertAutoUpTo(state, 1))
  assert.ok(after)
  assert.deepEqual(after.userQueue, ['a', 'b', 'c'])
  assert.deepEqual(after.autoQueue, ['d'])
  assert.deepEqual(combined(after), combined(before), 'a boundary splice never reorders the queue')
  assert.equal(after.activeIndex, 0, 'a user-queue anchor is untouched')
})

test('convert up to here keeps an AUTO anchor on the same occurrence (both sides of the cut)', () => {
  // The audible suggestion is INSIDE the converted prefix.
  const inside = applyQueueMutation(q(['a'], ['b', 'c', 'd'], 2), (s) => convertAutoUpTo(s, 1))
  assert.ok(inside)
  assert.deepEqual(inside.userQueue, ['a', 'b', 'c'])
  assert.equal(combined(inside)[inside.activeIndex], 'c')

  // The audible suggestion is BELOW the cut and stays a suggestion.
  const below = applyQueueMutation(q(['a'], ['b', 'c', 'd'], 3), (s) => convertAutoUpTo(s, 1))
  assert.ok(below)
  assert.deepEqual(below.autoQueue, ['d'])
  assert.equal(combined(below)[below.activeIndex], 'd')
})

test('convert up to here follows the audible COPY when the same song appears twice', () => {
  // user['x'] is history; the FIRST auto row ('x', auto index 0) is the
  // suggestion that is actually playing.
  const before = q(['x'], ['x', 'y'], 1)
  const after = applyQueueMutation(before, (s) => convertAutoUpTo(s, 0))
  assert.ok(after)
  assert.deepEqual(after.userQueue, ['x', 'x'])
  assert.deepEqual(after.autoQueue, ['y'])
  assert.equal(after.activeIndex, 1, 'the second copy (the audible one) stays anchored, not the history row')
})

test('convert up to here is a no-op for an out-of-range suggestion index', () => {
  assert.equal(convertAutoUpTo(q(['a'], ['b'], 0), -1), null)
  assert.equal(convertAutoUpTo(q(['a'], ['b'], 0), 1), null)
})

// ── promoteManyToUser ───────────────────────────────────────────────────────

test('bulk promote appends the selection in order and anchors an untouched audible row', () => {
  const before = q(['a'], ['b', 'c', 'd'], 3) // 'd' is playing
  const after = applyQueueMutation(before, (s) => promoteManyToUser(s, [0, 1]))
  assert.ok(after)
  assert.deepEqual(after.userQueue, ['a', 'b', 'c'])
  assert.deepEqual(after.autoQueue, ['d'])
  assert.equal(combined(after)[after.activeIndex], 'd')
})

test('bulk promote anchors the audible row at its new user position when it is promoted', () => {
  const before = q(['a'], ['b', 'c'], 1) // 'b' is playing
  const after = applyQueueMutation(before, (s) => promoteManyToUser(s, [0]))
  assert.ok(after)
  assert.deepEqual(after.userQueue, ['a', 'b'])
  assert.deepEqual(after.autoQueue, ['c'])
  assert.equal(combined(after)[after.activeIndex], 'b')
})

test('bulk promote ignores stale/duplicate indices and is a no-op with nothing valid', () => {
  const before = q(['a'], ['b', 'c'], 0)
  const after = applyQueueMutation(before, (s) => promoteManyToUser(s, [2, 1, 1, -3]))
  assert.ok(after)
  assert.deepEqual(after.userQueue, ['a', 'c'])
  assert.deepEqual(after.autoQueue, ['b'])
  assert.equal(promoteManyToUser(before, []), null)
  assert.equal(promoteManyToUser(before, [9]), null)
})

// ── replaceUserQueue ────────────────────────────────────────────────────────

test('set as user queue replaces the log and preserves the loaded track', () => {
  const before = q(['a', 'b'], ['c'], 1) // 'b' is playing
  const after = replaceUserQueue(before, ['x', 'y'], 'b')
  assert.ok(after)
  assert.deepEqual(after.userQueue, ['b', 'x', 'y'], 'the playing row is kept at the top')
  assert.equal(after.activeIndex, 0)
  assert.deepEqual(after.autoQueue, ['c'], 'unrelated suggestions survive')
})

test('set as user queue anchors the loaded track inside the selection when it is selected', () => {
  const after = replaceUserQueue(q(['a'], [], 0), ['x', 'a'], 'a')
  assert.ok(after)
  assert.deepEqual(after.userQueue, ['x', 'a'])
  assert.equal(after.activeIndex, 1)
})

test('set as user queue drops suggestion copies of the newly queued songs', () => {
  const after = replaceUserQueue(q(['a'], ['c', 'd'], 0), ['c'], undefined)
  assert.ok(after)
  assert.deepEqual(after.userQueue, ['c'])
  assert.deepEqual(after.autoQueue, ['d'], 'only the queued id leaves the tail')
  assert.equal(after.activeIndex, 0)
})

test('set as user queue refuses an empty selection', () => {
  assert.equal(replaceUserQueue(q(['a'], [], 0), [], 'a'), null)
})

// ── removeRows ──────────────────────────────────────────────────────────────

test('multi-remove slides the anchor by the rows removed above it', () => {
  const before = q(['a', 'b', 'c', 'd'], ['e'], 2) // 'c'
  const after = removeRows(before, [0, 3], [])
  assert.ok(after)
  assert.deepEqual(after.userQueue, ['b', 'c'])
  assert.deepEqual(after.autoQueue, ['e'])
  assert.equal(combined(after)[after.activeIndex], 'c')
})

test('multi-remove of the audible row keeps the position so the next row is highlighted', () => {
  const after = removeRows(q(['a', 'b', 'c'], [], 1), [1], [])
  assert.ok(after)
  assert.deepEqual(after.userQueue, ['a', 'c'])
  assert.equal(after.activeIndex, 1)
  assert.equal(combined(after)[after.activeIndex], 'c')
})

test('multi-remove cools every removed id and can span both sections', () => {
  const after = removeRows(q(['a', 'b'], ['c', 'd'], 0), [0], [0, 1])
  assert.ok(after)
  assert.deepEqual(after.userQueue, ['b'])
  assert.deepEqual(after.autoQueue, [])
  for (const id of ['a', 'c', 'd']) assert.ok(after.recentTrackIds.includes(id), `${id} is cooled`)
  assert.equal(after.recentTrackIds.includes('b'), false)
})

test('multi-remove is a no-op when no index resolves, and empties the anchor with the queue', () => {
  const before = q(['a'], ['b'], 0)
  assert.equal(removeRows(before, [], []), null)
  assert.equal(removeRows(before, [5], [5]), null)

  const emptied = removeRows(before, [0], [0])
  assert.ok(emptied)
  assert.deepEqual(emptied.userQueue, [])
  assert.deepEqual(emptied.autoQueue, [])
  assert.equal(emptied.activeIndex, -1)
})
