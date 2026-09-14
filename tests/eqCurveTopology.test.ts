// Pins the pure eqCurveTopology core (2026-09-13 flexible bands): the
// neighborhood rule for inserted bands (parametric only between two
// parametric neighbors), explicit per-band flips (no cascades), flip-all,
// points mapping for the convolver path, and the widest-gap insert
// suggestion.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveCurve,
  hasGraphicBands,
  curveTypeForNewBand,
  withExplicitCurve,
  flipAllCurveTypes,
  bandsToCurvePoints,
  suggestInsertFrequency,
  insertBandAt,
  removeBandAt,
} from '../src/lib/eq/eqCurveTopology'
import type { EqFilterConfig } from '../src/lib/eq/eqTypes'

function band(over: Partial<EqFilterConfig> = {}): EqFilterConfig {
  return { type: 'peaking', frequency: 1000, gain: 0, q: 0.707, enabled: true, ...over }
}

// ── effectiveCurve / hasGraphicBands ────────────────────────────────────

test('effectiveCurve: absent field reads parametric', () => {
  assert.equal(effectiveCurve(band()), 'parametric')
  assert.equal(effectiveCurve(band({ curve: undefined })), 'parametric')
  assert.equal(effectiveCurve(band({ curve: 'graphic' })), 'graphic')
})

test('hasGraphicBands: only ENABLED graphic bands count (a disabled one keeps the biquad path)', () => {
  assert.equal(hasGraphicBands([band(), band({ frequency: 100 })]), false)
  assert.equal(hasGraphicBands([band({ curve: 'graphic', enabled: false })]), false)
  assert.equal(hasGraphicBands([band(), band({ frequency: 100, curve: 'graphic' })]), true)
})

// ── curveTypeForNewBand (the user's rule) ───────────────────────────────

test('curveTypeForNewBand: parametric between two parametric neighbors', () => {
  const l = band({ frequency: 100 })
  const r = band({ frequency: 1000 })
  assert.equal(curveTypeForNewBand(l, r), 'parametric')
})

test('curveTypeForNewBand: touching the graphic curve on EITHER side → graphic', () => {
  const g = band({ frequency: 100, curve: 'graphic' })
  assert.equal(curveTypeForNewBand(g, band({ frequency: 1000 })), 'graphic', 'graphic left')
  assert.equal(curveTypeForNewBand(band({ frequency: 10 }), g), 'graphic', 'graphic right')
  assert.equal(curveTypeForNewBand(g, g), 'graphic')
})

test('curveTypeForNewBand: edge inserts and the empty grid → parametric', () => {
  assert.equal(curveTypeForNewBand(null, null), 'parametric', 'first band ever')
  assert.equal(curveTypeForNewBand(band({ frequency: 100 }), null), 'parametric', 'left edge')
  assert.equal(curveTypeForNewBand(null, band({ frequency: 100 })), 'parametric', 'right edge')
})

// ── explicit flips (no cascades) ────────────────────────────────────────

test('withExplicitCurve: flips exactly one band; neighbors untouched', () => {
  const filters = [band({ frequency: 100 }), band({ frequency: 1000 }), band({ frequency: 5000 })]
  const next = withExplicitCurve(filters, 1, 'graphic')
  assert.equal(effectiveCurve(next[1]), 'graphic')
  assert.equal(next[0].curve, undefined, 'neighbor 0 untouched')
  assert.equal(next[2].curve, undefined, 'neighbor 2 untouched')
  assert.equal(filters[1].curve, undefined, 'input array not mutated')
})

test('flipAllCurveTypes: every band flips; absent counts as parametric', () => {
  const filters = [band({ frequency: 100 }), band({ frequency: 1000, curve: 'graphic' })]
  const next = flipAllCurveTypes(filters)
  assert.equal(effectiveCurve(next[0]), 'graphic', 'absent → graphic')
  assert.equal(effectiveCurve(next[1]), 'parametric', 'graphic → parametric')
  assert.equal(filters[0].curve, undefined, 'input untouched')
})

// ── bandsToCurvePoints (convolver input) ────────────────────────────────

test('bandsToCurvePoints: enabled bands as sorted frequency/gain points', () => {
  const points = bandsToCurvePoints([
    band({ frequency: 4000, gain: 2 }),
    band({ frequency: 100, gain: -3, enabled: false }),
    band({ frequency: 500, gain: 6 }),
  ])
  assert.deepEqual(points, [
    { frequency: 500, gainDb: 6 },
    { frequency: 4000, gainDb: 2 },
  ])
})

// ── suggestInsertFrequency (widest log gap) ─────────────────────────────

test('suggestInsertFrequency: picks the midpoint of the widest gap', () => {
  // Gap 500→8000 (4 octaves) dwarfs the others.
  const filters = [
    band({ frequency: 100 }),
    band({ frequency: 500 }),
    band({ frequency: 8000 }),
  ]
  const freq = suggestInsertFrequency(filters)
  assert.ok(freq > 1500 && freq < 2500, `geometric midpoint of 500/8000, got ${freq}`)
})

test('suggestInsertFrequency: grows outward when the interior is dense', () => {
  // A dense sub-1k grid leaves a 4-octave hole above 1000 → insert there.
  const filters = [31, 62, 125, 250, 500, 1000].map((f) => band({ frequency: f }))
  const freq = suggestInsertFrequency(filters)
  assert.ok(freq > 1000, `dense low grid → above the top band, got ${freq}`)
})

test('suggestInsertFrequency: empty grid → 1 kHz', () => {
  assert.equal(suggestInsertFrequency([]), 1000)
})

// ── insertBandAt / removeBandAt ─────────────────────────────────────────

test('insertBandAt: inserts frequency-sorted with the neighborhood rule applied', () => {
  const filters = [
    band({ frequency: 100 }),
    band({ frequency: 1000, curve: 'graphic' }),
  ]
  // Insert at 500: left parametric, right graphic → graphic.
  const next = insertBandAt(filters, 500)
  assert.deepEqual(
    next.map((f) => [f.frequency, effectiveCurve(f)]),
    [[100, 'parametric'], [500, 'graphic'], [1000, 'graphic']]
  )
  // Insert at 50: both sides parametric (right neighbor 100) → parametric.
  const next2 = insertBandAt(filters, 50)
  assert.equal(effectiveCurve(next2[0]), 'parametric')
  assert.equal(next2[0].frequency, 50)
})

test('removeBandAt: removes exactly the targeted index', () => {
  const filters = [band({ frequency: 100 }), band({ frequency: 500 }), band({ frequency: 1000 })]
  const next = removeBandAt(filters, 1)
  assert.deepEqual(next.map((f) => f.frequency), [100, 1000])
})
