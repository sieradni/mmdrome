// Pins eqEffective — the ONE projection of "what the engine will apply".
// Every surface that describes the sound (graph response, band rows, the
// notices, the native snapshot) reads it, so these cases are the contract
// between what the controls show and what playback gets.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NATIVE_EQ_PLATFORM,
  NATIVE_MAX_EQ_BANDS,
  WEB_EQ_PLATFORM,
  hasCurveStack,
  liveBandChanges,
  resolveAppliedEq,
} from '../src/lib/eq/eqEffective'
import { parseEqText } from '../src/lib/eq/eqParser'
import { calculateTotalResponse } from '../src/lib/eq/eqResponseCalculator'
import type { EqFilterConfig, EqPreset } from '../src/lib/eq/eqTypes'

function band(over: Partial<EqFilterConfig> = {}): EqFilterConfig {
  return { type: 'peaking', frequency: 1000, gain: 3, q: 0.7, enabled: true, ...over }
}

function preset(over: Partial<EqPreset> = {}): EqPreset {
  return { id: 'p', name: 'P', mode: 'parametric', preampDb: -3, filters: [band()], ...over }
}

test('all-parametric on web: the biquad sum, every enabled band applies', () => {
  const state = preset({ filters: [band(), band({ frequency: 2000, gain: -2 })] })
  const applied = resolveAppliedEq(state, WEB_EQ_PLATFORM, false)
  assert.equal(applied.path, 'parametric')
  assert.deepEqual(applied.filters.map((f) => f.frequency), [1000, 2000])
  assert.equal(applied.inertIndices.size, 0)
  assert.equal(applied.preampDb, -3)
  assert.equal(applied.overLimit, 0)
})

test('an imported curve stack plays verbatim on web (path curve)', () => {
  const state = preset({
    id: 'imported',
    mode: 'graphic',
    graphicEqCurves: [[{ frequency: 100, gainDb: 4 }]],
  })
  assert.equal(hasCurveStack(state), true)
  assert.equal(resolveAppliedEq(state, WEB_EQ_PLATFORM, false).path, 'curve')
})

test('a hybrid EQ (any graphic band) interpolates one curve on web', () => {
  const state = preset({ filters: [band(), band({ frequency: 3000, curve: 'graphic' })] })
  assert.equal(resolveAppliedEq(state, WEB_EQ_PLATFORM, false).path, 'graphic')
})

test('native has no convolver: an imported curve becomes parametric bands', () => {
  const state = preset({
    id: 'imported',
    mode: 'graphic',
    graphicEqCurves: [[{ frequency: 100, gainDb: 4 }]],
    filters: [band({ frequency: 100, gain: 4 })],
  })
  const applied = resolveAppliedEq(state, NATIVE_EQ_PLATFORM, false)
  assert.equal(applied.path, 'parametric', 'never the curve, never the interpolation')
  assert.equal(applied.filters.length, 1)
})

test('native caps at 24 bands: the extras are inert and counted', () => {
  const filters = Array.from({ length: 31 }, (_, i) => band({ frequency: 20 * (i + 1) }))
  const applied = resolveAppliedEq(preset({ filters }), NATIVE_EQ_PLATFORM, false)
  assert.equal(applied.filters.length, NATIVE_MAX_EQ_BANDS)
  assert.equal(applied.overLimit, 7)
  for (let i = NATIVE_MAX_EQ_BANDS; i < 31; i++) {
    assert.equal(applied.inertIndices.has(i), true, `band ${i} is not in effect`)
  }
  assert.equal(applied.inertIndices.has(NATIVE_MAX_EQ_BANDS - 1), false, 'the last applied band stays live')
})

test('web has no band limit', () => {
  const filters = Array.from({ length: 40 }, (_, i) => band({ frequency: 20 * (i + 1) }))
  const applied = resolveAppliedEq(preset({ filters }), WEB_EQ_PLATFORM, false)
  assert.equal(applied.filters.length, 40)
  assert.equal(applied.overLimit, 0)
})

test('a disabled band is inert, excluded from the response, and does not use a slot', () => {
  const state = preset({
    filters: [band({ enabled: false }), band({ frequency: 2000 }), band({ frequency: 3000 })],
  })
  const applied = resolveAppliedEq(state, NATIVE_EQ_PLATFORM, false)
  assert.deepEqual(applied.filters.map((f) => f.frequency), [2000, 3000])
  assert.equal(applied.inertIndices.has(0), true)
  assert.equal(applied.overLimit, 0, 'only enabled bands count against the limit')
  // Boundary: exactly at the limit is not over it.
  const atLimit = Array.from({ length: NATIVE_MAX_EQ_BANDS }, (_, i) => band({ frequency: 20 * (i + 1) }))
  assert.equal(resolveAppliedEq(preset({ filters: atLimit }), NATIVE_EQ_PLATFORM, false).overLimit, 0)
})

test('the applied band list keeps model order and skips disabled bands entirely', () => {
  const filters = [band({ frequency: 10, enabled: false }), band({ frequency: 20 }), band({ frequency: 30 })]
  const applied = resolveAppliedEq(preset({ filters }), { maxBands: 1, appliesCurves: true }, false)
  assert.deepEqual(applied.filters.map((f) => f.frequency), [20], 'disabled band never consumes the cap')
})

test('a real 31-point GraphicEQ import on native: curve dropped, 24 bands run', () => {
  const points = Array.from({ length: 31 }, (_, i) => `${Math.round(25 * Math.pow(1.26, i))} ${i % 2 ? 2 : -2}`)
  const parsed = parseEqText(`Preamp: -6 dB\nGraphicEQ: ${points.join('; ')}`)
  const state: EqPreset = {
    id: 'imported',
    name: 'Imported',
    mode: parsed.mode,
    preampDb: parsed.preampDb,
    filters: parsed.filters,
    graphicEqCurves: parsed.graphicEqCurves,
  }
  const applied = resolveAppliedEq(state, NATIVE_EQ_PLATFORM, false)
  assert.equal(applied.path, 'parametric', 'iOS runs biquads, not the curve')
  assert.equal(applied.filters.length, NATIVE_MAX_EQ_BANDS)
  assert.equal(applied.overLimit, 7)
  // What the engine facade pushes is this exact list (applyEq sends
  // applied.filters): the first 24 enabled bands in model order, so the native
  // snapshot and the drawn curve cannot disagree.
  assert.deepEqual(
    applied.filters.map((f) => f.frequency),
    state.filters.filter((f) => f.enabled).slice(0, NATIVE_MAX_EQ_BANDS).map((f) => f.frequency)
  )
})

test('the drawn response excludes a band the engine cannot run', () => {
  // 24 harmless bands, then a 25th that would collapse the highs if it were
  // applied — the graph must draw exactly what the engine runs.
  const filters = Array.from({ length: NATIVE_MAX_EQ_BANDS }, (_, i) => band({ frequency: 1000 + i * 10, gain: 0 }))
  filters.push(band({ type: 'lowpass', frequency: 200, gain: 0 }))
  const applied = resolveAppliedEq(preset({ preampDb: 0, filters }), NATIVE_EQ_PLATFORM, false)
  const drawn = calculateTotalResponse(applied.preampDb, applied.filters, 100)
  const at1k = drawn.find((p) => p.frequency > 900 && p.frequency < 1100)
  assert.ok(at1k && at1k.gainDb > -1, `1 kHz stays open (got ${at1k?.gainDb})`)
  // With the over-limit lowpass included it would be far below 0.
  const leaky = calculateTotalResponse(0, filters, 100).find((p) => p.frequency > 900 && p.frequency < 1100)
  assert.ok(leaky && leaky.gainDb < -6, 'the leaked band would have been audible')
})

test('a disabled lowpass is drawn out of the response (off means off)', () => {
  const state = preset({
    preampDb: 0,
    filters: [band({ type: 'lowpass', frequency: 200, gain: 0, enabled: false })],
  })
  const applied = resolveAppliedEq(state, WEB_EQ_PLATFORM, false)
  assert.equal(applied.filters.length, 0)
  const drawn = calculateTotalResponse(applied.preampDb, applied.filters, 100)
  assert.ok(drawn.every((p) => p.gainDb === 0), 'a flat 0 dB line')
})

test('bypassed applies no preamp; an empty EQ projects to nothing', () => {
  const state = preset({ preampDb: 6 })
  const bypassed = resolveAppliedEq(state, WEB_EQ_PLATFORM, true)
  assert.equal(bypassed.preampDb, 0, 'bypass is the whole EQ')
  assert.equal(bypassed.filters.length, 1, 'the definition survives — only its application stops')

  const empty = resolveAppliedEq(preset({ filters: [] }), NATIVE_EQ_PLATFORM, false)
  assert.deepEqual(empty.filters, [])
  assert.equal(empty.inertIndices.size, 0)
  assert.equal(empty.path, 'parametric')
  assert.equal(empty.overLimit, 0)
})

// ── The engine-application plan (liveBandChanges) ──────────────────────────
// How a change LANDS, not just what it is: a drag must update one band in
// place (no chain rebuild), anything that changes the band SET must
// re-materialize. These cases pin the facade's decision.

test('liveBandChanges: gain/frequency/Q moves stay live, per band', () => {
  const before = [band({ gain: 3 }), band({ frequency: 2000 }), band({ frequency: 8000 })]
  const after = [band({ gain: 4 }), band({ frequency: 2100 }), band({ frequency: 8000, q: 2 })]
  assert.deepEqual(liveBandChanges(before, after), [0, 1, 2])
  assert.deepEqual(liveBandChanges(before, before.map((f) => ({ ...f }))), [])
})

test('liveBandChanges: a different band SET is structural (null)', () => {
  const before = [band(), band({ frequency: 2000 })]
  assert.equal(liveBandChanges(before, before.slice(0, 1)), null, 'band removed')
  assert.equal(liveBandChanges(before, [...before, band({ frequency: 4000 })]), null, 'band added')
  assert.equal(liveBandChanges(before, [before[0], band({ frequency: 2000, enabled: false })]), null, 'band switched off')
  assert.equal(liveBandChanges(before, [before[0], band({ frequency: 2000, type: 'notch' })]), null, 'filter type changed')
  assert.equal(liveBandChanges(before, [before[0], band({ frequency: 2000, curve: 'graphic' })]), null, 'curve kind changed')
  // Absent curve IS parametric: an explicit one must not read as a change.
  assert.deepEqual(
    liveBandChanges([band({ curve: 'parametric' })], [band()]),
    [],
    'absent and explicit parametric are the same band'
  )
})
