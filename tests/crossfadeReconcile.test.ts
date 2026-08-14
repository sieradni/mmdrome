import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reconcileCrossfadeTarget,
  type CrossfadeReconcileInput,
} from '../src/lib/playbackCore/crossfadeReconcile'

function input(over: Partial<CrossfadeReconcileInput> = {}): CrossfadeReconcileInput {
  return {
    targetId: 't2',
    combined: ['t1', 't2', 't3'],
    activeIndex: 1,
    userQueue: ['t1', 't2'],
    advanced: true,
    loopMode: 'none',
    ...over,
  }
}

// ── null target (arm cancelled mid-fade / natural end) ─────────────────────

test('targetId null → none (no reconcile at all)', () => {
  assert.deepEqual(reconcileCrossfadeTarget(input({ targetId: null })), { kind: 'none' })
})

test('targetId null suppresses the loop-all wrap too (old code gated the wrap inside the target block)', () => {
  assert.deepEqual(
    reconcileCrossfadeTarget(input({ targetId: null, advanced: false, loopMode: 'all' })),
    { kind: 'none' },
  )
})

// ── target still queued ────────────────────────────────────────────────────

test('target still queued at a different index → repoint', () => {
  assert.deepEqual(reconcileCrossfadeTarget(input({ activeIndex: 0 })), { kind: 'repoint', index: 1 })
})

test('target still queued at the same index → none (no store write)', () => {
  assert.deepEqual(reconcileCrossfadeTarget(input({ activeIndex: 1 })), { kind: 'none' })
})

test('target queued in the auto section → repoint works the same', () => {
  assert.deepEqual(
    reconcileCrossfadeTarget(input({ combined: ['t1', 't2', 't3'], activeIndex: 0 })),
    { kind: 'repoint', index: 1 },
  )
})

// ── target removed mid-fade (the rescue) ───────────────────────────────────

test('target removed mid-fade → rescue: re-insert at top of the user queue', () => {
  assert.deepEqual(reconcileCrossfadeTarget(input({ combined: ['t1', 't3'], userQueue: ['t1'] })), {
    kind: 'rescue',
    userQueue: ['t2', 't1'],
  })
})

test('rescue with a combined queue emptied mid-fade → the audible track is pulled back', () => {
  assert.deepEqual(reconcileCrossfadeTarget(input({ combined: [], userQueue: [] })), {
    kind: 'rescue',
    userQueue: ['t2'],
  })
})

// ── loop-all wrap ──────────────────────────────────────────────────────────

test('advance exhausted + loop-all → wrap to the first user row (wins over repoint)', () => {
  assert.deepEqual(
    reconcileCrossfadeTarget(input({ advanced: false, loopMode: 'all', activeIndex: 0 })),
    { kind: 'wrap', index: 0 },
  )
})

test('wrap index is the first user row position, not the target position', () => {
  assert.deepEqual(
    reconcileCrossfadeTarget(input({ advanced: false, loopMode: 'all', combined: ['t1', 't2', 't3'], activeIndex: 2 })),
    { kind: 'wrap', index: 0 },
  )
})

test('rescue + advance exhausted + loop-all → wrap lands on the rescued row at index 0', () => {
  assert.deepEqual(
    reconcileCrossfadeTarget(input({ advanced: false, loopMode: 'all', combined: ['t3'] })),
    { kind: 'wrap', index: 0 },
  )
})

test('advance succeeded → no wrap, repoint only', () => {
  assert.deepEqual(
    reconcileCrossfadeTarget(input({ loopMode: 'all', activeIndex: 0 })),
    { kind: 'repoint', index: 1 },
  )
})

test('loop-all wrap with an empty user queue → none', () => {
  assert.deepEqual(
    reconcileCrossfadeTarget(input({ advanced: false, loopMode: 'all', userQueue: [], combined: ['t2'], activeIndex: 0 })),
    { kind: 'none' },
  )
})

test('wrap index falls back to 0 when the first user row is missing from the combined queue', () => {
  assert.deepEqual(
    reconcileCrossfadeTarget(input({ advanced: false, loopMode: 'all', combined: ['x1', 'x2'], userQueue: ['ghost'] })),
    { kind: 'wrap', index: 0 },
  )
})

test('loop-mode none + advance exhausted → none (no wrap, no repoint if index matches)', () => {
  assert.deepEqual(reconcileCrossfadeTarget(input({ advanced: false, activeIndex: 1 })), { kind: 'none' })
})