import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beginSelection,
  clearedSelection,
  emptySelection,
  isSelected,
  planSelectAll,
  planSelectionClick,
  rangeKeys,
  selectionActive,
  selectionLabel,
  setSelectionOrder,
  type SelectionState,
} from '../src/lib/selectionCore'

// The multi-select model (2026-11-04). These rules are what every row surface
// relies on, so they are pinned once, here:
//  - Shift chains from the LAST SELECTED key and unions the range onto the
//    existing picks (prior selections are never dropped);
//  - Ctrl/Cmd (and a plain press in selection mode) toggles one key;
//  - the surface's order is the selection DOMAIN: leaving it prunes keys;
//  - an empty selection leaves selection mode (a surface can never sit in a
//    mode with nothing selected);
//  - the two surfaces never mix (library track ids vs queue entry ids).

const ORDER = ['a', 'b', 'c', 'd', 'e']

function withOrder(surface: 'library' | 'queue' = 'library', order = ORDER): SelectionState {
  return setSelectionOrder(emptySelection(), surface, order)
}

test('rangeKeys is inclusive, direction-agnostic, and degrades to the clicked key', () => {
  assert.deepEqual(rangeKeys(ORDER, 'b', 'd'), ['b', 'c', 'd'])
  assert.deepEqual(rangeKeys(ORDER, 'd', 'b'), ['b', 'c', 'd'])
  assert.deepEqual(rangeKeys(ORDER, 'c', 'c'), ['c'])
  // A key outside the order (a stale click, a filtered-out row) never yields a
  // bogus range — just the clicked key.
  assert.deepEqual(rangeKeys(ORDER, 'b', 'zzz'), ['zzz'])
  assert.deepEqual(rangeKeys([], 'a', 'b'), ['b'])
})

test('a first click starts a selection with mode on and the key anchored', () => {
  const state = planSelectionClick(withOrder(), 'library', 'c')
  assert.equal(state.surface, 'library')
  assert.deepEqual(state.keys, ['c'])
  assert.equal(state.anchor, 'c')
  assert.equal(state.mode, true)
  assert.equal(selectionActive(state, 'library'), true)
  assert.equal(isSelected(state, 'library', 'c'), true)
})

test('the touch path toggles: a plain press inside selection mode adds and removes', () => {
  let state = planSelectionClick(withOrder(), 'library', 'a')
  state = planSelectionClick(state, 'library', 'c')
  assert.deepEqual(state.keys, ['a', 'c'])
  state = planSelectionClick(state, 'library', 'a')
  assert.deepEqual(state.keys, ['c'])
  // Removing the last key leaves selection mode entirely.
  state = planSelectionClick(state, 'library', 'c')
  assert.deepEqual(state.keys, [])
  assert.equal(state.surface, null)
  assert.equal(state.mode, false)
  assert.equal(selectionActive(state, 'library'), false)
})

test('Ctrl/Cmd toggles one key and moves the anchor', () => {
  let state = planSelectionClick(withOrder(), 'library', 'b')
  state = planSelectionClick(state, 'library', 'e', { toggle: true })
  assert.deepEqual(state.keys, ['b', 'e'])
  assert.equal(state.anchor, 'e', 'the toggle is the last picked key; a Shift range measures from it')
  state = planSelectionClick(state, 'library', 'b', { toggle: true })
  assert.deepEqual(state.keys, ['e'])
})

test('Shift chains from the last selected key and never drops prior picks', () => {
  let state = planSelectionClick(withOrder(), 'library', 'b')
  state = planSelectionClick(state, 'library', 'd', { shift: true })
  assert.deepEqual(state.keys, ['b', 'c', 'd'])
  assert.equal(state.anchor, 'd', 'the clicked key becomes the base for the next Shift pick')

  // A second Shift click continues from the LAST selected key and ADDS to the
  // set — the prior range survives. The range clicked first (b–d) must still
  // be there, and the new stretch (d–e) is unioned onto it.
  state = planSelectionClick(state, 'library', 'e', { shift: true })
  assert.deepEqual(state.keys, ['b', 'c', 'd', 'e'])

  // Backwards chaining: the anchor is the last pick, so a Shift pick BELOW it
  // fills the gap between rather than replacing what exists.
  let back = planSelectionClick(withOrder(), 'library', 'd')
  back = planSelectionClick(back, 'library', 'b', { shift: true })
  assert.deepEqual(back.keys, ['b', 'c', 'd'])
  back = planSelectionClick(back, 'library', 'a', { shift: true })
  assert.deepEqual(back.keys, ['a', 'b', 'c', 'd'], 'chaining extends the set, it never re-bases it')

  // Ctrl/Cmd + Shift behaves identically to Shift — both union the range.
  let additive = planSelectionClick(withOrder(), 'library', 'a')
  additive = planSelectionClick(additive, 'library', 'c', { shift: true, toggle: true })
  assert.deepEqual(additive.keys, ['a', 'b', 'c'])
  additive = planSelectionClick(additive, 'library', 'e', { shift: true, toggle: true })
  assert.deepEqual(additive.keys, ['a', 'b', 'c', 'd', 'e'])
})

test('Shift chaining preserves non-contiguous picks made before the range', () => {
  // Non-contiguous picks are preserved as-is by toggles; a Shift range unions
  // with them, chaining from the LAST pick (the toggle's key) rather than the
  // first — a non-contiguous pick made after the range never blocks it.
  let state = planSelectionClick(withOrder(), 'library', 'a')
  state = planSelectionClick(state, 'library', 'c')
  assert.deepEqual(state.keys, ['a', 'c'])
  state = planSelectionClick(state, 'library', 'e', { shift: true })
  assert.deepEqual(state.keys, ['a', 'c', 'd', 'e'], 'a stays selected; the range fills between c and e')
  // The clicked key is the new base: another Shift from there continues there.
  state = planSelectionClick(state, 'library', 'b', { shift: true })
  assert.deepEqual(state.keys, ['a', 'b', 'c', 'd', 'e'], 'the union is emitted in surface order')
})

test('the surface order is the selection domain: lost keys are pruned, and the same order is a no-op', () => {
  let state = planSelectionClick(withOrder(), 'library', 'a')
  state = planSelectionClick(state, 'library', 'c')
  // The list was filtered: 'a' is gone.
  const pruned = setSelectionOrder(state, 'library', ['b', 'c', 'd'])
  assert.deepEqual(pruned.keys, ['c'])
  assert.equal(isSelected(pruned, 'library', 'a'), false)

  // Losing every key ends the mode instead of leaving an empty selection.
  const emptied = setSelectionOrder(pruned, 'library', ['b'])
  assert.deepEqual(emptied.keys, [])
  assert.equal(emptied.surface, null)

  // An identical order is the SAME object — no store write, no re-render churn.
  const stable = setSelectionOrder(state, 'library', ORDER)
  assert.equal(stable, state)
})

test('the two surfaces keep separate orders and one selection', () => {
  let state = withOrder('library')
  state = setSelectionOrder(state, 'queue', ['u-a', 'a-x'])
  state = planSelectionClick(state, 'library', 'a')
  assert.equal(state.surface, 'library')

  // Switching surfaces starts a fresh selection: the previous keys cannot leak
  // (an entry id is not a track id).
  state = planSelectionClick(state, 'queue', 'a-x')
  assert.equal(state.surface, 'queue')
  assert.deepEqual(state.keys, ['a-x'])
  assert.equal(isSelected(state, 'library', 'a'), false)
  // Both orders survive — each surface keeps its own domain.
  assert.deepEqual(state.orders.library, ORDER)
})

test('select all fills the surface order; an empty order is a no-op', () => {
  const all = planSelectAll(withOrder(), 'library')
  assert.deepEqual(all.keys, ORDER)
  assert.equal(all.mode, true)
  assert.equal(all.anchor, 'a')

  const empty = planSelectAll(emptySelection(), 'library')
  assert.deepEqual(empty.keys, [])
  assert.equal(empty.surface, null)
})

test('clearing keeps the orders (they describe the surface, not the selection)', () => {
  const state = planSelectionClick(withOrder(), 'library', 'b')
  const cleared = clearedSelection(state)
  assert.equal(cleared.surface, null)
  assert.deepEqual(cleared.keys, [])
  assert.equal(cleared.mode, false)
  assert.deepEqual(cleared.orders.library, ORDER)
  // Idempotent and reference-stable, so the Escape handler is never a churn.
  assert.equal(clearedSelection(cleared), cleared)
})

test('beginSelection selects exactly one key, even over an existing selection', () => {
  let state = planSelectionClick(withOrder(), 'library', 'a')
  state = planSelectionClick(state, 'library', 'b')
  const begun = beginSelection(state, 'library', 'd')
  assert.deepEqual(begun.keys, ['d'])
  assert.equal(begun.anchor, 'd')
})

test('selection labels are pluralized in one place', () => {
  assert.equal(selectionLabel(1, 'song'), '1 song')
  assert.equal(selectionLabel(3, 'song'), '3 songs')
})
