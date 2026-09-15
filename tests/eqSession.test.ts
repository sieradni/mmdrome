// Pins the pure eqSession model (2026-09-13 working-state overlay):
// dirty flagging against the session's own base (deep compare, no false
// positives/negatives), the persist policy (debounce while dirty, immediate
// flush on dirty→clean, nothing when clean), restore resolution (self-based
// states, unknown bases, saved overlays vs newer selections), and the edit
// reducer's immutability contract.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EQ_COMMIT_DEBOUNCE_MS,
  sessionEqualsPreset,
  startSession,
  editDraft,
  planWorkingPersist,
  resolveSession,
  reconcileOnRestore,
} from '../src/lib/eq/eqSession'
import { BUILTIN_PRESETS } from '../src/lib/eq/builtInPresets'
import type { EqPreset } from '../src/lib/eq/eqTypes'

function preset(over: Partial<EqPreset> = {}): EqPreset {
  return {
    id: 'base',
    name: 'Base',
    mode: 'parametric',
    preampDb: 0,
    filters: [
      { type: 'peaking', frequency: 100, gain: 0, q: 0.7, enabled: true },
      { type: 'peaking', frequency: 1000, gain: 2, q: 0.7, enabled: true },
    ],
    ...over,
  }
}

// ── sessionEqualsPreset ─────────────────────────────────────────────────

test('sessionEqualsPreset: structural equality ignores preset identity', () => {
  assert.equal(sessionEqualsPreset(preset(), preset({ id: 'other', name: 'Other' })), true)
})

test('sessionEqualsPreset: every editable field participates', () => {
  const a = preset()
  const cases: Partial<EqPreset>[] = [
    { preampDb: 1 },
    { mode: 'graphic' },
    { filters: [preset().filters[0]] },
    { filters: [...preset().filters].reverse() },
    { filters: preset().filters.map((f) => ({ ...f, gain: 0 })) },
    { filters: preset().filters.map((f) => ({ ...f, q: 1.2 })) },
    { filters: preset().filters.map((f) => ({ ...f, enabled: false })) },
    { filters: preset().filters.map((f) => ({ ...f, frequency: 120 })) },
    { filters: preset().filters.map((f) => ({ ...f, type: 'lowshelf' as const })) },
    { filters: preset().filters.map((f) => ({ ...f, curve: 'graphic' as const })) },
    { graphicEqCurves: [[{ frequency: 100, gainDb: 3 }]] },
  ]
  for (const over of cases) {
    assert.equal(sessionEqualsPreset(a, preset(over)), false, `differs by ${JSON.stringify(over)}`)
  }
})

test('sessionEqualsPreset: curve absent vs parametric compares equal; absent vs graphic does not', () => {
  const base = preset()
  const paramExplicit = preset({ filters: base.filters.map((f) => ({ ...f, curve: 'parametric' as const })) })
  assert.equal(sessionEqualsPreset(base, paramExplicit), true, 'undefined === parametric')
  const graphic = preset({ filters: base.filters.map((f) => ({ ...f, curve: 'graphic' as const })) })
  assert.equal(sessionEqualsPreset(base, graphic), false)
})

// ── startSession / editDraft ────────────────────────────────────────────

test('startSession: clean clone detached from the source preset', () => {
  const src = preset({ preampDb: -2 })
  const s = startSession(src)
  assert.equal(s.dirty, false)
  assert.equal(s.base.id, 'base')
  s.state.filters[0].gain = 9
  s.state.preampDb = 5
  assert.equal(src.filters[0].gain, 0, 'source untouched')
  assert.equal(src.preampDb, -2)
})

test('editDraft: an edit returning to base values clears dirty (no false sticky flag)', () => {
  const base = preset({ preampDb: -2 })
  let s = startSession(base)
  s = editDraft(s, (st) => {
    st.preampDb = 3
    return st
  })
  assert.equal(s.dirty, true)
  s = editDraft(s, (st) => {
    st.preampDb = -2
    return st
  })
  assert.equal(s.dirty, false, 'back to base → clean')
})

test('editDraft: base snapshot survives edits; state arrays are not shared', () => {
  const base = preset({ preampDb: -2 })
  let s = startSession(base)
  const baseFiltersSnapshot = JSON.stringify(s.base.filters)
  s = editDraft(s, (st) => {
    st.filters[0].gain = 6
    st.filters = [...st.filters, { type: 'peaking', frequency: 5000, gain: 1, q: 0.7, enabled: true }]
    return st
  })
  assert.equal(s.dirty, true)
  assert.equal(JSON.stringify(s.base.filters), baseFiltersSnapshot, 'base unchanged by edits')
  assert.equal(base.filters.length, 2, 'base preset rows untouched')
})

// ── planWorkingPersist ──────────────────────────────────────────────────

test('planWorkingPersist: dirty debounces; clean is a no-op; dirty→clean flushes immediately', () => {
  const clean = startSession(preset())
  const dirtyS = editDraft(clean, (st) => {
    st.preampDb = -1
    return st
  })
  assert.deepEqual(planWorkingPersist(dirtyS, false), {
    persist: true,
    mode: 'debounce',
    cancelPending: false,
  })
  assert.deepEqual(planWorkingPersist(clean, false), {
    persist: false,
    mode: 'immediate',
    cancelPending: false,
  })
  assert.deepEqual(planWorkingPersist(clean, true), {
    persist: true,
    mode: 'immediate',
    cancelPending: true,
  })
})

test('EQ_COMMIT_DEBOUNCE_MS is under a second (edits land well before the user leaves the view)', () => {
  assert.ok(EQ_COMMIT_DEBOUNCE_MS > 0 && EQ_COMMIT_DEBOUNCE_MS <= 1000)
})

// ── resolveSession (boot) ───────────────────────────────────────────────

test('resolveSession: state + matching base id → clean or dirty per deep compare', () => {
  const base = preset({ preampDb: -2, id: 'user-9' })
  const same = resolveSession(structuredClone(base), 'user-9', [base], BUILTIN_PRESETS[0])
  assert.equal(same.dirty, false)
  assert.equal(same.base.id, 'user-9')

  const edited = preset({ preampDb: -5, id: 'user-9' })
  const dirtyRestored = resolveSession(edited, 'user-9', [base], BUILTIN_PRESETS[0])
  assert.equal(dirtyRestored.dirty, true, 'saved overlay differing from its base restores dirty')
  assert.equal(dirtyRestored.base.id, 'user-9')
  assert.equal(dirtyRestored.state.preampDb, -5, 'the overlay (not the base) is the working state')
})

test('resolveSession: unknown base id falls back through state id, self-base, then flat', () => {
  const state = preset({ id: 'ghost', preampDb: -3 })
  // savedBaseId references a deleted preset; the state's own id is also
  // unknown → the state itself becomes the base (imported-EQ semantics).
  const s1 = resolveSession(state, 'deleted-id', [], BUILTIN_PRESETS[0])
  assert.equal(s1.base.id, 'ghost')
  assert.equal(s1.dirty, false, 'self-based → clean')
  // No state at all → the fallback preset.
  const s2 = resolveSession(undefined, 'deleted-id', [], BUILTIN_PRESETS[0])
  assert.equal(s2.base.id, BUILTIN_PRESETS[0].id)
  assert.equal(s2.state.id, BUILTIN_PRESETS[0].id)
})

test('resolveSession: user presets participate in base lookup', () => {
  const userBase = preset({ id: 'user-7', preampDb: 1 })
  const s = resolveSession(preset({ preampDb: 4, id: 'user-7' }), 'user-7', [userBase], BUILTIN_PRESETS[0])
  assert.equal(s.base.id, 'user-7')
  assert.equal(s.dirty, true)
})

// ── reconcileOnRestore ──────────────────────────────────────────────────

test('reconcileOnRestore: matching ids adopt the saved overlay; mismatched → the selection wins', () => {
  const session = startSession(preset({ id: 'p1' }))
  assert.deepEqual(reconcileOnRestore(session, 'p1'), { adoptSaved: true, activePresetId: 'p1' })
  assert.deepEqual(reconcileOnRestore(session, 'p2'), { adoptSaved: false, activePresetId: 'p2' })
})

// ── preset-switch semantics (2026-09-15, classic switch) ───────
// NOTE: the 2026-09-15 "continuous re-base" (rebaseSession) was REMOVED by
// user decision — selecting a preset APPLIES it (resetWorkingEq discards
// edits) and the view asks before discarding. rebaseSession no longer
// exists; startSession/resetWorkingEq already pin the apply semantics.




