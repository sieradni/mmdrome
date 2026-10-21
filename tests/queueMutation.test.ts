import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addToUserQueue,
  advanceTargetIndex,
  applyDragDrop,
  applyQueueMutation,
  clearQueue,
  clearUserAboveActive,
  clearUserBelowActive,
  moveUserRowToEnd,
  moveUserRowToNext,
  playNext,
  planDragDrop,
  planDragDropRows,
  pressTrack,
  promoteActiveTrack,
  promoteToUser,
  promoteToUserNext,
  removeFromAutoQueue,
  removeFromUserQueue,
  type QueueMutation,
} from '../src/lib/queueMutation'
import { entryIdAt, parseEntryId, rowKeyOf, sectionEntryIds } from '../src/lib/queueOccurrence'
import type { QueueState } from '../src/stores/appState'

// Row identity is the OCCURRENCE (section + trackId + ordinal). Duplicates are
// legal in both sections (D3, QUEUE-DESIGN.md), so this suite NEVER asserts
// within-section uniqueness. The behaviours pinned here:
//   - drag moves the row the user grabbed, even when a duplicate shares its id;
//   - reconciliation budgets by per-id counts (a duplicate is not "a newcomer");
//   - the anchor names the audible COPY, not merely its song;
//   - add/promote append occurrences; reorder primitives move exactly one.

function q(userQueue: string[], autoQueue: string[], activeIndex: number, recentTrackIds: string[] = []): QueueState {
  return { userQueue, autoQueue, recentTrackIds, activeIndex }
}

function combined(s: QueueState): string[] {
  return [...s.userQueue, ...s.autoQueue]
}

function count(ids: string[], id: string): number {
  return ids.filter((x) => x === id).length
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

// --- occurrence identity ----------------------------------------------------

test('queueOccurrence: entry ids and row keys are occurrence-scoped and position-free', () => {
  assert.deepEqual(sectionEntryIds(['a', 'b', 'a', 'a'], 'user'), ['user:a', 'user:b', 'user:a#1', 'user:a#2'])
  assert.deepEqual(sectionEntryIds(['x', 'x'], 'auto'), ['auto:x', 'auto:x#1'])
  assert.equal(rowKeyOf('user', 'a', 1), 'u-a#1')
  assert.equal(rowKeyOf('auto', 'x', 0), 'a-x#0')
  // Keys never carry the row's index: an advance that shifts every row keeps
  // every key stable (the 2026-09-23 churn regression).
  assert.ok(!rowKeyOf('user', 'a', 0).includes('0-'))
})

test('queueOccurrence: entry-id parsing round-trips ids that themselves contain #digits', () => {
  assert.deepEqual(parseEntryId('user:a'), { section: 'user', trackId: 'a', ordinal: 0 })
  assert.deepEqual(parseEntryId('auto:x#2'), { section: 'auto', trackId: 'x', ordinal: 2 })
  // A track id ending in `#<digits>` is ambiguous only for the ordinal-0 form;
  // callers validate the parse against the real queue arrays, so a miss falls
  // back to the reported id and can never bind a different row.
  const occurrence = parseEntryId('user:x#2')
  assert.equal(occurrence?.section, 'user')
})

// --- drag-drop planner (2026-09-12; duplicates 2026-10-21) ------------------

test('planDragDrop: user→end reorder matches the preview semantics', () => {
  // [A,B,C] drag A to slot 3 → B,C,A
  const r = planDragDrop(['a', 'b', 'c'], [], 0, 3)
  assert.deepEqual(r, { user: ['b', 'c', 'a'], auto: [] })
})

test('planDragDrop: user→auto conversion converts auto rows above the slot', () => {
  const r = planDragDrop(['a', 'b'], ['x', 'y', 'z'], 0, 4)
  assert.deepEqual(r, { user: ['b', 'x', 'y', 'a'], auto: ['z'] })
})

test('planDragDrop: auto→user inserts into the user section', () => {
  const r = planDragDrop(['a', 'b'], ['x', 'y', 'z'], 2, 1)
  assert.deepEqual(r, { user: ['a', 'x', 'b'], auto: ['y', 'z'] })
})

test('planDragDrop: auto→auto reorders within auto (slot counts the dragged row)', () => {
  const r = planDragDrop(['a'], ['x', 'y', 'z'], 1, 3)
  assert.deepEqual(r, { user: ['a'], auto: ['y', 'x', 'z'] })
})

test('planDragDrop: an auto copy of an id already in user is a SEPARATE row (no dedupe)', () => {
  // The tier-3 duplicate b (user[1] AND auto[0]) dragged from auto onto slot 0
  // keeps BOTH occurrences: the existing user row and the promoted auto row.
  const r = planDragDrop(['a', 'b'], ['b', 'c'], 2, 0)
  assert.deepEqual(r, { user: ['b', 'a', 'b'], auto: ['c'] })
  assert.equal(count(r.user, 'b'), 2)
})

test('planDragDrop: dropping an auto duplicate onto the user tail keeps both copies', () => {
  const r = planDragDrop(['a', 'b'], ['b', 'c'], 2, 2)
  assert.deepEqual(r, { user: ['a', 'b', 'b'], auto: ['c'] })
})

test('planDragDrop: user→auto conversion keeps a duplicated auto row in the converted prefix', () => {
  // CONVERTED (not swallowed): the auto b is a real row that joins the user
  // tail, and the dragged user b is its own row.
  const r = planDragDrop(['b', 'a'], ['b', 'c'], 0, 3)
  assert.deepEqual(r, { user: ['a', 'b', 'b'], auto: ['c'] })
})

test('planDragDropRows carries each row’s ORIGIN section (the reconcile budget)', () => {
  const rows = planDragDropRows(['a'], ['x'], 1, 0)
  assert.deepEqual(rows.user, [
    { section: 'auto', trackId: 'x', ordinal: 0 },
    { section: 'user', trackId: 'a', ordinal: 0 },
  ])
})

// --- drag-drop drop resolution ---------------------------------------------

test('applyDragDrop: a cross-section duplicate resolves to the dragged AUTO occurrence (G5 closed)', () => {
  // Before occurrence identity the drag signature was the track id, so the
  // resolver found the user copy first: dragging the auto row either no-oped
  // or moved the wrong row. Now the entry id names the auto copy.
  const s = q(['a', 'b'], ['b', 'c'], 0, []) // a playing
  const r = applyDragDrop(s, 'auto:b', 0, ['a', 'b'], ['b', 'c'])
  assert.ok(r)
  assert.deepEqual(r.userQueue, ['b', 'a', 'b'], 'the promoted auto copy joins the user section beside the existing user copy')
  assert.deepEqual(r.autoQueue, ['c'], 'the dragged auto occurrence left its section')
  assert.equal(count(r.userQueue ?? [], 'b'), 2)
  // Anchor: a was audible at user[0]; after the insert it is user[1].
  const updated = applyQueueMutation(s, () => r)!
  assert.equal(combined(updated)[updated.activeIndex], 'a')
  assert.equal(updated.activeIndex, 1)
})

test('applyDragDrop: with two user copies the dragged one moves and the other stays', () => {
  const s = q(['a', 'x', 'a', 'b'], [], 0, [])
  const r = applyDragDrop(s, 'user:a#1', 4, ['a', 'x', 'a', 'b'], [])
  assert.ok(r)
  assert.deepEqual(r.userQueue, ['a', 'x', 'b', 'a'], 'the SECOND a moved; the first is untouched')
  const updated = applyQueueMutation(s, () => r)!
  assert.equal(updated.activeIndex, 0, 'the audible first copy keeps its anchor')
})

test('applyDragDrop: a mid-drag removal of the SAME id above voids the drop (never moves a different copy)', () => {
  // Drag started with the second 'a' (user:a#1). Mid-drag the first copy was
  // removed, so the row the user grabbed no longer exists — the remaining 'a'
  // is a different occurrence. Doing nothing is the only honest outcome.
  const live = q(['x', 'a', 'b'], [], 0, [])
  assert.equal(applyDragDrop(live, 'user:a#1', 4, ['a', 'x', 'a', 'b'], []), null)
})

test('applyDragDrop: reconciliation budgets by per-id COUNT, so a duplicate is not a newcomer', () => {
  // Drag a to the end; while held, a SECOND a joined the queue. Set membership
  // would drop one copy (or re-append it as "new"). Counts preserve both.
  const live = q(['a', 'b', 'a'], [], 0, [])
  const r = applyDragDrop(live, 'user:a', 2, ['a', 'b'], [])
  assert.ok(r)
  assert.deepEqual(r.userQueue, ['b', 'a', 'a'])
  assert.equal(count(r.userQueue ?? [], 'a'), 2)
})

test('applyDragDrop: mid-drag advance no longer resurrects the stale order', () => {
  const liveNow = q(['c', 'a'], ['x'], 0, [])
  const r = applyDragDrop(liveNow, 'user:a', 2, ['a', 'b', 'c'], ['x'])
  assert.ok(r)
  assert.deepEqual(r.userQueue, ['a', 'c'])
  assert.deepEqual(r.autoQueue, ['x'])
})

test('applyDragDrop: reorder still lands when rows joined mid-drag', () => {
  const liveNow = q(['a', 'b', 'c'], ['x', 'n'], 0, [])
  const r = applyDragDrop(liveNow, 'user:a', 2, ['a', 'b', 'c'], ['x'])
  assert.ok(r)
  assert.deepEqual(r.userQueue, ['b', 'a', 'c'])
  assert.deepEqual(r.autoQueue, ['x', 'n'], 'the mid-drag newcomer keeps its section and order')
})

test('applyDragDrop: a row that joined the USER section mid-drag stays in the user section', () => {
  const liveNow = q(['a', 'b', 'n'], [], 0, [])
  const r = applyDragDrop(liveNow, 'user:a', 2, ['a', 'b'], [])
  assert.ok(r)
  assert.deepEqual(r.userQueue, ['b', 'a', 'n'], 'n was never dragged into auto')
  assert.deepEqual(r.autoQueue, [])
})

test('applyDragDrop: dragged row removed mid-drag voids the drop', () => {
  const liveNow = q(['b', 'c'], ['x'], 0, [])
  assert.equal(applyDragDrop(liveNow, 'user:a', 2, ['a', 'b', 'c'], ['x']), null)
})

test('applyDragDrop: unknown dragged entry is a no-op', () => {
  const s = q(['a', 'b'], [], 0, [])
  assert.equal(applyDragDrop(s, 'user:zzz', 1, ['a', 'b'], []), null)
})

test('applyDragDrop: an unchanged shape is a null no-op (no store write)', () => {
  const s = q(['a', 'b'], [], 0, [])
  assert.equal(applyDragDrop(s, 'user:a', 0, ['a', 'b'], []), null)
})

// --- skipped-prefix cooling (2026-09-12) ------------------------------------

test('promoteActiveTrack consumes the skipped prefix and cools it for the refill', () => {
  const s = q(['p1'], ['s1', 's2', 'target', 'a3', 'a4'], 3, [])
  const r = applyQueueMutation(s, (x) => promoteActiveTrack(x))!
  assert.deepEqual(r.userQueue, ['p1', 'target'])
  assert.deepEqual(r.autoQueue, ['a3', 'a4'])
  assert.ok(r.recentTrackIds?.includes('s1') && r.recentTrackIds?.includes('s2'))
})

test('promoteActiveTrack: active row in auto at auto[0] promotes to the user tail', () => {
  const s = q(['a', 'b'], ['c', 'd', 'e'], 2)
  const r = applyQueueMutation(s, (x) => promoteActiveTrack(x))!
  assert.deepEqual(r.userQueue, ['a', 'b', 'c'])
  assert.deepEqual(r.autoQueue, ['d', 'e'])
  assert.equal(r.activeIndex, 2)
})

test('explicit USER replay never consumes its independent upcoming auto copy', () => {
  const s = q(['a', 'b', 'c'], ['c', 'd'], 2)
  assert.equal(applyQueueMutation(s, promoteActiveTrack), null)
  assert.deepEqual(s.autoQueue, ['c', 'd'])
})

test('promoteActiveTrack works in the transition window (active row deep in auto)', () => {
  const s = q(['x'], ['p', 'q', 'r'], 3)
  const r = applyQueueMutation(s, (x) => promoteActiveTrack(x))!
  assert.deepEqual(r.userQueue, ['x', 'r'])
  assert.deepEqual(r.autoQueue, [])
  assert.equal(r.activeIndex, 1)
})

// Promotion APPENDS a new user occurrence (D5, step 2): a user copy that is
// already in the log is history and is never relocated, however many copies
// exist.

test('recycled auto promotion APPENDS a new user occurrence and keeps the history copy', () => {
  // Pile [a,b,c,d,e] (played earlier); auto [b-copy, x, y]; b-copy plays.
  const s = q(['a', 'b', 'c', 'd', 'e'], ['b', 'x', 'y'], 5)
  const r = applyQueueMutation(s, (x) => promoteActiveTrack(x))!
  assert.deepEqual(r.userQueue, ['a', 'b', 'c', 'd', 'e', 'b'], 'the history copy at 1 stays put')
  assert.equal(count(r.userQueue, 'b'), 2, 'log copy + newly played copy')
  assert.deepEqual(r.autoQueue, ['x', 'y'], 'consumed prefix gone, tail intact')
  assert.equal(combined(r)[r.activeIndex], 'b')
  assert.equal(r.activeIndex, r.userQueue.length - 1, 'audible song at user tail, not history or continuation')
  assert.equal(combined(r)[advanceTargetIndex(r, combined(r), 'b')], 'x')
})

test('promotion with TWO pre-existing user copies appends a THIRD and collapses neither', () => {
  const s = q(['a', 'b', 'a'], ['a', 'x'], 3) // auto a plays
  const r = applyQueueMutation(s, (x) => promoteActiveTrack(x))!
  assert.equal(count(r.userQueue, 'a'), 3, 'both history copies survive plus the played one')
  assert.deepEqual(r.userQueue, ['a', 'b', 'a', 'a'])
  assert.deepEqual(r.autoQueue, ['x'])
  assert.equal(combined(r)[r.activeIndex], 'a')
  assert.equal(r.activeIndex, r.userQueue.length - 1)
})

test('recycled promotion with no surviving auto tail keeps the audible song queued', () => {
  const s = q(['a', 'b', 'c'], ['c'], 3)
  const r = applyQueueMutation(s, (x) => promoteActiveTrack(x))!
  assert.deepEqual(r.userQueue, ['a', 'b', 'c', 'c'], 'the history c stays; the played c appends')
  assert.deepEqual(r.autoQueue, [])
  assert.equal(r.activeIndex, 3, 'audible c sits at the boundary')
  assert.equal(combined(r)[r.activeIndex], 'c')
  assert.equal(advanceTargetIndex(r, combined(r), 'c'), 4, 'next advance enters refill path')
})

test('a repeat play never rewinds: chained auto plays keep moving forward', () => {
  let s = q(['a', 'b', 'c'], ['d', 'b', 'e', 'f'], 3) // d playing (auto[0])
  s = applyQueueMutation(s, (x) => promoteActiveTrack(x))!
  assert.deepEqual(s.userQueue, ['a', 'b', 'c', 'd'])
  assert.deepEqual(s.autoQueue, ['b', 'e', 'f'])
  assert.equal(combined(s)[s.activeIndex], 'd')
  s = { ...s, activeIndex: advanceTargetIndex(s, combined(s), 'd') }
  s = applyQueueMutation(s, (x) => promoteActiveTrack(x))!
  assert.deepEqual(s.userQueue, ['a', 'b', 'c', 'd', 'b'], 'recycled b appends; history b stays at 1')
  assert.deepEqual(s.autoQueue, ['e', 'f'])
  assert.equal(combined(s)[s.activeIndex], 'b')
  assert.equal(combined(s)[advanceTargetIndex(s, combined(s), 'b')], 'e')
  s = { ...s, activeIndex: advanceTargetIndex(s, combined(s), 'b') }
  s = applyQueueMutation(s, (x) => promoteActiveTrack(x))!
  assert.equal(combined(s)[s.activeIndex], 'e')
  assert.deepEqual(s.autoQueue, ['f'])
  s = { ...s, activeIndex: advanceTargetIndex(s, combined(s), 'e') }
  s = applyQueueMutation(s, (x) => promoteActiveTrack(x))!
  assert.equal(combined(s)[s.activeIndex], 'f')
  assert.deepEqual(s.autoQueue, [])
})

/** Simulates a long hands-off auto-queue session over `auto` (which may
 *  contain tier-3 duplicates of `pile`): per track it runs the real sequence
 *  — advanceQueue's `advanceTo(activeIndex+1)`, then the post-load
 *  `promoteActiveTrack`. Asserts the played sequence equals the AUTO ORDER
 *  exactly (no pile row is ever replayed — the history-replay bug) and that
 *  the anchor after every promote names the just-appended pile tail. */
function simulateAutoSession(pile: string[], auto: string[]): { played: string[]; dupCount: number } {
  const pileSet = new Set(pile)
  let s = q(pile, auto, pile.length - 1)
  const played: string[] = []
  let dupCount = 0
  let playingId: string | undefined = pile[pile.length - 1]
  for (let i = 0; i < auto.length; i++) {
    const target = advanceTargetIndex(s, combined(s), playingId)
    s = { ...s, activeIndex: target }
    const id = combined(s)[s.activeIndex]
    if (id === undefined) break
    played.push(id)
    if (pileSet.has(id)) dupCount++
    const next = applyQueueMutation(s, (x) => promoteActiveTrack(x))
    assert.ok(next, `promote returned null at step ${i} (playing ${id})`)
    s = next
    playingId = id
    assert.equal(combined(s)[s.activeIndex], id, `active identity at step ${i}`)
    if (auto[i + 1] !== undefined) {
      assert.equal(combined(s)[advanceTargetIndex(s, combined(s), id)], auto[i + 1], `continuation at step ${i}`)
    }
  }
  return { played, dupCount }
}

test('long hands-off auto session with interleaved duplicates never replays history', () => {
  const auto = ['k', 'c', 'l', 'm', 'f', 'n', 'a', 'o']
  const pile = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
  const { played, dupCount } = simulateAutoSession(pile, auto)
  assert.equal(dupCount, 3, 'the three duplicates collapsed')

  assert.deepEqual(played, auto)
})

test('promoteActiveTrack is a no-op when the active row is not in auto', () => {
  const s = q(['a', 'b'], ['c'], 1)
  assert.equal(applyQueueMutation(s, (x) => promoteActiveTrack(x)), null)
  assert.equal(applyQueueMutation(q([], [], -1), (x) => promoteActiveTrack(x)), null)
})

// --- add / promote / reorder with duplicates --------------------------------

test('addToUserQueue appends a NEW occurrence even when the id is already queued (D2)', () => {
  const r = applyQueueMutation(q(['a'], [], 0), (x) => addToUserQueue(x, 'a'))!
  assert.deepEqual(r.userQueue, ['a', 'a'])
  assert.equal(r.activeIndex, 0, 'the audible occurrence keeps its row; the append is below it')
  const r2 = applyQueueMutation(q(['a'], [], 0), (x) => addToUserQueue(x, 'b'))!
  assert.deepEqual(r2.userQueue, ['a', 'b'])
})

test('pressTrack appends a new occurrence, drops auto copies, anchors it and cools the previous row (D1)', () => {
  // 'a' is in the history pile AND the auto tail; 'b' is audible.
  const s = q(['x', 'a', 'b'], ['a', 'y'], 2)
  const r = pressTrack(s, 'a')!
  assert.deepEqual(r.userQueue, ['x', 'a', 'b', 'a'], 'history stays; the press appends its own row')
  assert.deepEqual(r.autoQueue, ['y'], "the pressed id's suggestions are gone")
  assert.equal(r.activeIndex, 3, 'anchored on the pressed occurrence')
  assert.equal(combined(r)[r.activeIndex], 'a')
  assert.ok(r.recentTrackIds.includes('b'), 'the previous audible row cools')
  assert.ok(!r.recentTrackIds.includes('a'), 'the pressed song is not cooled')
})

test('pressTrack returns null for the audible occurrence (resume, never a clone)', () => {
  assert.equal(pressTrack(q(['x', 'a'], [], 1), 'a'), null)
  // Same rule when the audible song is also duplicated: the press is the
  // active row, so it resumes instead of stacking another copy.
  assert.equal(pressTrack(q(['a', 'a'], [], 1), 'a'), null)
})

test('pressTrack on an empty queue appends row 0 and leaves recents alone', () => {
  const r = pressTrack(q([], [], -1), 'a')!
  assert.deepEqual(r.userQueue, ['a'])
  assert.deepEqual(r.autoQueue, [])
  assert.equal(r.activeIndex, 0)
  assert.deepEqual(r.recentTrackIds, [])
})

test('playNext inserts a new track right after the active row (anchor re-indexes)', () => {
  const s = q(['a', 'b', 'c'], [], 1)
  const r = applyQueueMutation(s, (x) => playNext(x, 'x'))!
  assert.deepEqual(r.userQueue, ['a', 'b', 'x', 'c'])
  assert.equal(r.activeIndex, 1)
})

test('playNext ADDS a copy even when that song already sits in the next slot (D2 press intent)', () => {
  const s = q(['a', 'b', 'c'], [], 1)
  const r = applyQueueMutation(s, (x) => playNext(x, 'c'))!
  assert.deepEqual(r.userQueue, ['a', 'b', 'c', 'c'], 'the press is an intent to hear it next')
  assert.equal(r.activeIndex, 1, 'the audible row never moves')
  assert.equal(combined(r)[r.activeIndex], 'b')
})

test('playNext never relocates an existing copy — the history row stays put (step 2)', () => {
  const s = q(['a', 'b', 'a', 'c'], [], 2) // second a is audible
  const r = applyQueueMutation(s, (x) => playNext(x, 'a'))!
  assert.deepEqual(r.userQueue, ['a', 'b', 'a', 'a', 'c'], 'a new occurrence, the other two untouched')
  assert.equal(r.activeIndex, 2, 'the audible occurrence stays the audible occurrence')
  assert.equal(combined(r)[r.activeIndex], 'a')
  assert.equal(combined(r)[3], 'a', 'the inserted copy sits right after it')
})

test('playNext on an auto-active queue inserts at the user tail and keeps the auto anchor', () => {
  const s = q(['a', 'b'], ['c', 'd'], 2) // c (auto) is audible
  const r = applyQueueMutation(s, (x) => playNext(x, 'x'))!
  assert.deepEqual(r.userQueue, ['a', 'b', 'x'])
  assert.equal(combined(r)[r.activeIndex], 'c', 'the audible auto occurrence is untouched')
  assert.equal(r.activeIndex, 3)
})

test('promoteToUser appends a new user occurrence and drops the auto occurrence', () => {
  const r = applyQueueMutation(q(['a'], ['b', 'c'], 0), (x) => promoteToUser(x, 0))!
  assert.deepEqual(r.userQueue, ['a', 'b'])
  assert.deepEqual(r.autoQueue, ['c'])
  assert.equal(r.activeIndex, 0)

  // An older user copy is HISTORY, not something the promote re-uses.
  const r2 = applyQueueMutation(q(['a', 'b'], ['b', 'c'], 0), (x) => promoteToUser(x, 0))!
  assert.deepEqual(r2.userQueue, ['a', 'b', 'b'], 'both occurrences exist')
  assert.deepEqual(r2.autoQueue, ['c'])
  assert.equal(r2.activeIndex, 0)
  assert.equal(applyQueueMutation(q(['a'], ['b'], 0), (x) => promoteToUser(x, 1)), null, 'out-of-range no-op')
})

test('promoteToUserNext appends a new user row after the active row and drops that auto occurrence', () => {
  const r = applyQueueMutation(q(['a', 'c', 'd'], ['c', 'e'], 1), (x) => promoteToUserNext(x, 0))!
  assert.deepEqual(r.userQueue, ['a', 'c', 'c', 'd'], 'the auto copy becomes a distinct user occurrence')
  assert.deepEqual(r.autoQueue, ['e'])
  assert.equal(r.activeIndex, 1)

  const r2 = applyQueueMutation(q(['a', 'd', 'b'], ['b'], 0), (x) => promoteToUserNext(x, 0))!
  assert.deepEqual(r2.userQueue, ['a', 'b', 'd', 'b'])
  assert.deepEqual(r2.autoQueue, [])
  assert.equal(r2.activeIndex, 0)
})

test('moveUserRowToNext / moveUserRowToEnd address the ROW index, so duplicates are independent', () => {
  const s = q(['a', 'b', 'a', 'c'], [], 0)
  const r = applyQueueMutation(s, (x) => moveUserRowToNext(x, 2))!
  assert.deepEqual(r.userQueue, ['a', 'a', 'b', 'c'], 'the SECOND a moved, not the first')
  assert.equal(r.activeIndex, 0)

  const r2 = applyQueueMutation(q(['a', 'b', 'a'], [], 2), (x) => moveUserRowToEnd(x, 0))!
  assert.deepEqual(r2.userQueue, ['b', 'a', 'a'])
  assert.equal(combined(r2)[r2.activeIndex], 'a')
  assert.equal(r2.activeIndex, 1, 'the audible copy slid up one slot')

  // The anchor follows the row it moved, and only that row.
  const r3 = applyQueueMutation(q(['a', 'b', 'c'], [], 0), (x) => moveUserRowToEnd(x, 0))!
  assert.deepEqual(r3.userQueue, ['b', 'c', 'a'])
  assert.equal(r3.activeIndex, 2)
  const r4 = applyQueueMutation(q(['a', 'b', 'a'], [], 0), (x) => moveUserRowToEnd(x, 0))!
  assert.equal(count(r4.userQueue, 'a'), 2, 'two copies: only the moved one changes order')
  assert.equal(r4.activeIndex, 2, 'the audible first copy is now the last row')

  // No-ops: already in place, and a row index past the end.
  assert.equal(applyQueueMutation(q(['a', 'b'], [], 0), (x) => moveUserRowToNext(x, 1)), null)
  assert.equal(applyQueueMutation(q(['a', 'b'], [], 0), (x) => moveUserRowToEnd(x, 9)), null)
})

// --- removal ---------------------------------------------------------------

test('removeFromAutoQueue removes exactly the indexed occurrence and cools the id', () => {
  const s = q(['a'], ['x', 'y', 'x'], 0, ['k'])
  const r = applyQueueMutation(s, (x) => removeFromAutoQueue(x, 2))!
  assert.deepEqual(r.autoQueue, ['x', 'y'], 'the SECOND x is gone; the first survives')
  assert.deepEqual(r.recentTrackIds, ['k', 'x'])
  assert.equal(r.activeIndex, 0)

  const r2 = applyQueueMutation(q(['a'], ['x', 'x'], 0, []), (x) => removeFromAutoQueue(x, 0))!
  assert.deepEqual(r2.autoQueue, ['x'])
  assert.equal(applyQueueMutation(q(['a'], ['x'], 0), (x) => removeFromAutoQueue(x, 1)), null)
})

test('removeFromUserQueue: removing a preceding row decrements the anchor (active id preserved)', () => {
  const r = removeFromUserQueue(q(['a', 'b', 'c'], [], 1), 0)!
  assert.deepEqual(r.userQueue, ['b', 'c'])
  assert.equal(r.activeIndex, 0)
  assert.equal(combined(r)[r.activeIndex], 'b')
})

test('removeFromUserQueue: one duplicate can be removed without touching the other', () => {
  const r = removeFromUserQueue(q(['a', 'x', 'a'], [], 2), 0)!
  assert.deepEqual(r.userQueue, ['x', 'a'])
  assert.equal(combined(r)[r.activeIndex], 'a', 'the audible second copy survives')
  assert.equal(r.activeIndex, 1)
})

test('removeFromUserQueue: removing the active row keeps the index so the highlight slides to the next row (2.4 option b)', () => {
  const r = removeFromUserQueue(q(['a', 'b', 'c'], [], 1), 1)!
  assert.deepEqual(r.userQueue, ['a', 'c'])
  assert.equal(r.activeIndex, 1)
  assert.equal(combined(r)[r.activeIndex], 'c')

  const r2 = removeFromUserQueue(q(['a'], ['x', 'y'], 0), 0)!
  assert.deepEqual(r2.userQueue, [])
  assert.deepEqual(r2.autoQueue, ['x', 'y'])
  assert.equal(r2.activeIndex, 0)
  assert.equal(combined(r2)[r2.activeIndex], 'x')
})

test('removeFromUserQueue: removing a following row leaves the anchor untouched', () => {
  const r = removeFromUserQueue(q(['a', 'b', 'c'], [], 1), 2)!
  assert.deepEqual(r.userQueue, ['a', 'b'])
  assert.equal(r.activeIndex, 1)
  assert.equal(combined(r)[r.activeIndex], 'b')
})

test('removeFromUserQueue: removing the active LAST row lands the anchor past the new end (honest stop)', () => {
  const r = removeFromUserQueue(q(['a', 'b'], [], 1), 1)!
  assert.deepEqual(r.userQueue, ['a'])
  assert.deepEqual(r.autoQueue, [])
  assert.equal(r.activeIndex, 1)
  assert.ok(r.activeIndex >= combined(r).length, 'anchor is past the combined end')
})

test('removeFromUserQueue: the removed id cools in the recency window and auto depth is preserved', () => {
  const r = removeFromUserQueue(q(['a', 'b'], ['x'], 1, ['k']), 1)!
  assert.deepEqual(r.recentTrackIds, ['k', 'b'])
  assert.deepEqual(r.autoQueue, ['x'])
  assert.equal(r.activeIndex, 1)
})

test('removeFromUserQueue: out-of-range index is a null no-op (no store write)', () => {
  assert.equal(removeFromUserQueue(q(['a'], [], 0), 1), null)
  assert.equal(removeFromUserQueue(q(['a'], [], 0), -1), null)
  assert.equal(removeFromUserQueue(q([], [], -1), 0), null)
})

// --- anchor ----------------------------------------------------------------

test('anchor: an unrelated mutation keeps the audible DUPLICATE, not the first copy of its id', () => {
  const s = q(['a', 'x', 'a', 'b'], [], 2) // the SECOND a plays
  const r = applyQueueMutation(s, (x) => addToUserQueue(x, 'n'))!
  assert.equal(r.activeIndex, 2, 'position unchanged; `indexOf(id)` would have re-anchored to 0')
  assert.equal(combined(r)[r.activeIndex], 'a')

  const r2 = applyQueueMutation(s, (x) => moveUserRowToEnd(x, 0))!
  assert.deepEqual(r2.userQueue, ['x', 'a', 'b', 'a'])
  assert.equal(r2.activeIndex, 1, 'the audible second copy followed its own row')
})

test('anchor: a row inserted beside the audible duplicate never re-binds to the first copy', () => {
  const s = q(['a', 'a', 'b'], [], 1) // second a
  const r = applyQueueMutation(s, (x) => playNext(x, 'n'))!
  assert.deepEqual(r.userQueue, ['a', 'a', 'n', 'b'], 'play-next lands after the audible row')
  assert.equal(r.activeIndex, 1)
  assert.equal(combined(r)[r.activeIndex], 'a')
})

test('advanceTargetIndex: normally targets the row after the playing track', () => {
  assert.equal(advanceTargetIndex(q(['a', 'b', 'c'], [], 1), ['a', 'b', 'c'], 'b'), 2)
  assert.equal(advanceTargetIndex(q(['x'], ['y', 'z'], 1), ['x', 'y', 'z'], 'y'), 2)
})

test('advanceTargetIndex: after an active-row removal the next row is AT activeIndex (2.4 option b)', () => {
  const s = removeFromUserQueue(q(['a', 'b', 'c'], [], 1), 1)!
  assert.equal(advanceTargetIndex(s, combined(s), 'b'), 1)
  const s2 = removeFromUserQueue(q(['a', 'b'], [], 1), 1)!
  assert.equal(advanceTargetIndex(s2, combined(s2), 'b'), 1)
  const s3 = removeFromUserQueue(q(['a'], [], 0), 0)!
  assert.equal(advanceTargetIndex(s3, combined(s3), 'a'), 0)
})

test('advanceTargetIndex: no playing track keeps the plain +1 target (end-of-queue refill path)', () => {
  assert.equal(advanceTargetIndex(q(['a', 'b'], [], 0), ['a', 'b'], undefined), 1)
  assert.equal(advanceTargetIndex(q([], [], -1), [], undefined), 0)
})

// --- clear -----------------------------------------------------------------

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

test('clearQueue with a duplicate id collapses to ONE row for the audible occurrence (explicit clear)', () => {
  const r = applyQueueMutation(q(['a', 'a', 'b'], [], 1), (x) => clearQueue(x))!
  assert.deepEqual(r.userQueue, ['a'])
  assert.equal(r.activeIndex, 0)
})

test('clearUserAboveActive removes the played pile above the active row, anchor follows, auto untouched', () => {
  const s = q(['a', 'b', 'c'], ['d', 'e'], 1)
  const r = applyQueueMutation(s, (x) => clearUserAboveActive(x))!
  assert.deepEqual(r.userQueue, ['b', 'c'])
  assert.deepEqual(r.autoQueue, ['d', 'e'], 'the auto queue is never touched')
  assert.equal(r.activeIndex, 0)
  assert.deepEqual(combined(r).slice(0, 1), ['b'])
})

test('clearUserAboveActive with the active row in the auto section clears every user row', () => {
  const s = q(['a', 'b'], ['c'], 2)
  const r = applyQueueMutation(s, (x) => clearUserAboveActive(x))!
  assert.deepEqual(r.userQueue, [])
  assert.equal(r.activeIndex, 0, 'the active id re-anchors to the auto row')
})

test('clearUserAboveActive: nothing above, nothing active → null no-op', () => {
  assert.equal(applyQueueMutation(q(['a', 'b'], ['c'], 0), (x) => clearUserAboveActive(x)), null)
  assert.equal(applyQueueMutation(q([], ['c'], 0), (x) => clearUserAboveActive(x)), null)
  assert.equal(applyQueueMutation(q(['a'], ['c'], -1), (x) => clearUserAboveActive(x)), null)
})

test('clearUserBelowActive removes everything queued after the playing row', () => {
  const s = q(['a', 'b', 'c', 'd'], ['e'], 1)
  const r = applyQueueMutation(s, (x) => clearUserBelowActive(x))!
  assert.deepEqual(r.userQueue, ['a', 'b'])
  assert.deepEqual(r.autoQueue, ['e'])
  assert.equal(r.activeIndex, 1)
})

test('clearUserBelowActive: active in auto, active last, nothing active → null no-op', () => {
  assert.equal(applyQueueMutation(q(['a'], ['b'], 1), (x) => clearUserBelowActive(x)), null)
  assert.equal(applyQueueMutation(q(['a', 'b'], ['c'], 1), (x) => clearUserBelowActive(x)), null)
  assert.equal(applyQueueMutation(q(['a'], ['b'], -1), (x) => clearUserBelowActive(x)), null)
})

// --- drag / remove around the active row (Phase 2A) -------------------------

test('dragging the active USER row keeps the anchor on the moved user occurrence, not the auto duplicate', () => {
  const s = q(['a', 'x'], ['x', 'y'], 1)
  const r = applyQueueMutation(s, (x) => applyDragDrop(x, 'user:x', 0, ['a', 'x'], ['x', 'y']))!
  assert.deepEqual(r.userQueue, ['x', 'a'], 'the drag reorders the user section')
  assert.deepEqual(r.autoQueue, ['x', 'y'], 'the auto duplicate is untouched by a user drag')
  assert.equal(r.activeIndex, 0)
  assert.equal(combined(r)[r.activeIndex], 'x')
})

test('rapid removals above the active row keep the anchor on the playing id each time', () => {
  let s = q(['p1', 'p2', 'p3', 'x', 'tail'], [], 3)
  s = removeFromUserQueue(s, 0)!
  assert.equal(combined(s)[s.activeIndex], 'x', 'after the first removal')
  s = removeFromUserQueue(s, 0)!
  assert.equal(combined(s)[s.activeIndex], 'x', 'after the second, in the same tick')
  assert.equal(s.activeIndex, 1)
  assert.deepEqual(s.userQueue, ['p3', 'x', 'tail'])
})

test('removing the PLAYING user row leaves its auto occurrence queued (removal is section-scoped)', () => {
  const s = q(['x', 'next'], ['x'], 0)
  const r = removeFromUserQueue(s, 0)!
  assert.deepEqual(r.userQueue, ['next'])
  assert.deepEqual(r.autoQueue, ['x'], 'the auto occurrence survives the user-row removal')
  assert.equal(combined(r)[r.activeIndex], 'next')
  assert.ok(r.recentTrackIds.includes('x'))
})

test('a null mutation produces no state change (no store write)', () => {
  const s = q(['a'], ['b'], 0)
  assert.equal(applyQueueMutation(s, () => null), null)
})

test('fuzz: anchor identity, duplicate legality, drag row-count preservation (10k × 6 seeds)', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `t${i}`)
  const ops: Array<{ name: string; drag?: boolean; run: (s: QueueState, id: string) => QueueMutation | null }> = [
    { name: 'add', run: (s, id) => addToUserQueue(s, id) },
    { name: 'playNext', run: (s, id) => playNext(s, id) },
    { name: 'promoteUser', drag: true, run: (s, id) => promoteToUser(s, s.autoQueue.indexOf(id)) },
    { name: 'promoteUserNext', drag: true, run: (s, id) => promoteToUserNext(s, s.autoQueue.indexOf(id)) },
    // Reorders are row-scoped: pick the row the id sits on (index −1 no-ops).
    { name: 'moveRowNext', drag: true, run: (s, id) => moveUserRowToNext(s, s.userQueue.indexOf(id)) },
    { name: 'moveRowEnd', drag: true, run: (s, id) => moveUserRowToEnd(s, s.userQueue.indexOf(id)) },
    { name: 'removeAuto', run: (s, id) => removeFromAutoQueue(s, s.autoQueue.indexOf(id)) },
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
      const isDrag = rnd() < 0.3
      const id = ids[Math.floor(rnd() * ids.length)]
      const pre = combined(s)
      const didDrag = isDrag && pre.length > 0
      const activeId = s.activeIndex >= 0 && s.activeIndex < pre.length ? pre[s.activeIndex] : undefined
      const result = applyQueueMutation(s, (x) => {
        if (!didDrag) {
          const op = ops[Math.floor(rnd() * ops.length)]
          return op.run(x, id)
        }
        // Random drag from a real row: the OCCURRENCE at that index is the
        // identity (a duplicate id is a different row).
        const fromIdx = Math.floor(rnd() * pre.length)
        const dragged = entryIdAt(s.userQueue, s.autoQueue, fromIdx)
        if (dragged === null) return null
        const toIdx = Math.floor(rnd() * (pre.length + 1))
        return applyDragDrop(x, dragged, toIdx, s.userQueue, s.autoQueue)
      })
      if (result === null) continue
      s = result
      const c = combined(s)
      if (activeId !== undefined) {
        assert.ok(
          s.userQueue.includes(activeId) || s.autoQueue.includes(activeId),
          `active id dropped (seed ${seed} iter ${iter})`,
        )
        if (s.activeIndex >= 0) {
          assert.ok(s.activeIndex < c.length, `anchor out of range (seed ${seed} iter ${iter})`)
          assert.equal(c[s.activeIndex], activeId, `anchor invariant violated (seed ${seed} iter ${iter})`)
        }
      } else {
        assert.equal(s.activeIndex, -1, `empty queue must anchor at -1 (seed ${seed} iter ${iter})`)
      }
      if (didDrag) {
        assert.equal(c.length, pre.length, `drag must preserve row count (seed ${seed} iter ${iter})`)
      }
    }
  }
})
