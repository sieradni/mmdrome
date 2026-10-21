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
// ── occurrence identity (queue step 2, 2026-10-21d) ──────────────────────

test('duplicate target: the armed occurrence wins over the first forward copy', () => {
  // The fade played the USER copy at index 0; an AUTO copy of the same song
  // sits after the advanced anchor. Resolving by id alone would repoint to 3.
  const r = reconcileCrossfadeTarget(
    input({
      targetId: 't1',
      combined: ['t1', 't0', 't2', 't1'],
      userQueue: ['t1', 't0', 't2'],
      userLength: 3,
      activeIndex: 2,
      targetEntryId: 'user:t1',
    }),
  )
  assert.deepEqual(r, { kind: 'repoint', index: 0 })
})

test('duplicate target: identical id-only input repoints to the wrong (auto) copy', () => {
  // Control for the test above — the behavior it replaces, so the pin proves
  // the entry id is what makes the difference, not the fixture.
  const r = reconcileCrossfadeTarget(
    input({ targetId: 't1', combined: ['t1', 't0', 't2', 't1'], userQueue: ['t1', 't0', 't2'], activeIndex: 2 }),
  )
  assert.deepEqual(r, { kind: 'repoint', index: 3 })
})

test('an entry id whose occurrence is gone falls back to the id/position chain', () => {
  // Armed auto copy was removed mid-fade; the user copy is the only one left.
  const r = reconcileCrossfadeTarget(
    input({
      targetId: 't1',
      combined: ['t0', 't1'],
      userQueue: ['t0', 't1'],
      userLength: 2,
      activeIndex: 1,
      targetEntryId: 'auto:t1',
    }),
  )
  assert.deepEqual(r, { kind: 'none' })
})

test('entry id resolves to the same index → none (no store write)', () => {
  const r = reconcileCrossfadeTarget(
    input({
      targetId: 't1',
      combined: ['t0', 't1', 't2'],
      userQueue: ['t0', 't1'],
      userLength: 2,
      activeIndex: 1,
      targetEntryId: 'user:t1',
    }),
  )
  assert.deepEqual(r, { kind: 'none' })
})

// ── KNOWN LIMITATION G6: ordinal identity breaks on a same-id insert above ──
test('LIMITATION (G6): a same-id copy inserted ABOVE the armed row mid-fade repoints to the inserted copy', () => {
  // Entry ids are (section, id, ordinal). Inserting a copy of the SAME song
  // above the armed row renames the armed row (its ordinal becomes 1) and
  // hands its old entry id (`auto:b`) to the newcomer — so the resolver
  // answers with a row the user never armed, with no rescue and no mismatch
  // signal. Reachable mid-fade: a fresh-context rebuild (D7) or a tier-3
  // duplicate can land a same-id copy above the armed row.
  //
  // Pinned as the CURRENT behavior (a limitation of the identity model), not
  // as an endorsement. The audio is the same song, so the transition is
  // inaudible; the ANCHOR and the promotion's cooled prefix belong to a
  // different ROW.
  const armedAt = 3
  const shifted = ['u', 'a', 'b', 'b', 'x'] // user ['u','a']; auto ['b'(new), 'b'(armed), 'x']
  const r = reconcileCrossfadeTarget(
    input({
      targetId: 'b',
      combined: shifted,
      userQueue: ['u', 'a'],
      userLength: 2,
      activeIndex: armedAt,
      targetEntryId: 'auto:b',
    }),
  )
  assert.deepEqual(r, { kind: 'repoint', index: 2 }, 'G6: the reconcile points at the INSERTED copy')
  assert.equal(shifted[armedAt], 'b', 'the armed row sits one past the row it repointed to')

  // The guarantee only holds while the armed row KEEPS its ordinal: with no
  // same-id insert, the same entry id names it exactly and the reconcile is a
  // no-op at its index.
  const stable = ['u', 'a', 'b', 'x']
  assert.deepEqual(
    reconcileCrossfadeTarget(
      input({
        targetId: 'b',
        combined: stable,
        userQueue: ['u', 'a'],
        userLength: 2,
        activeIndex: 2,
        targetEntryId: 'auto:b',
      }),
    ),
    { kind: 'none' },
    'control: an unchanged ordinal resolves to the armed row itself',
  )
})

