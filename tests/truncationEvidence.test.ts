import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessEnded, type TruncationEvidenceInput } from '../src/lib/playbackCore/truncationEvidence'

function input(over: Partial<TruncationEvidenceInput> = {}): TruncationEvidenceInput {
  return { currentTime: 0, duration: 0, marginSeconds: 1.5, ...over }
}

test('truncationEvidence: unknown duration is never evidence', () => {
  assert.equal(assessEnded(input({ duration: 0 })).kind, 'unknown-duration')
  assert.equal(assessEnded(input({ duration: NaN })).kind, 'unknown-duration')
  assert.equal(assessEnded(input({ duration: Infinity })).kind, 'unknown-duration')
  assert.equal(assessEnded(input({ duration: -3 })).kind, 'unknown-duration')
})

test('truncationEvidence: a natural end is plausible', () => {
  // ended fires within milliseconds of duration.
  assert.equal(assessEnded(input({ currentTime: 179.99, duration: 180 })).kind, 'plausible')
  assert.equal(assessEnded(input({ currentTime: 180, duration: 180 })).kind, 'plausible')
  // Slightly PAST the metadata duration (container rounding) is normal.
  assert.equal(assessEnded(input({ currentTime: 180.4, duration: 180 })).kind, 'plausible')
})

test('truncationEvidence: inside the margin is plausible (codec delay padding)', () => {
  // 1.5 s margin: a shortfall of exactly the margin is not evidence.
  assert.equal(assessEnded(input({ currentTime: 178.5, duration: 180 })).kind, 'plausible')
  assert.equal(assessEnded(input({ currentTime: 179, duration: 180 })).kind, 'plausible')
})

test('truncationEvidence: beyond the margin is ended-early with the shortfall', () => {
  const v = assessEnded(input({ currentTime: 100, duration: 180 }))
  assert.equal(v.kind, 'ended-early')
  assert.equal(v.kind === 'ended-early' ? v.shortfallSeconds : 0, 80)
  // Just past the margin boundary.
  assert.equal(assessEnded(input({ currentTime: 178.49, duration: 180 })).kind, 'ended-early')
})

test('truncationEvidence: large shortfalls report precisely (truncated stream)', () => {
  // The 2026-09-18 LDM shape: a 4 MB stream cut at ~40% — ended at 55 s of 138 s.
  const v = assessEnded(input({ currentTime: 55.2, duration: 138 }))
  assert.equal(v.kind, 'ended-early')
  assert.equal(v.kind === 'ended-early' ? v.shortfallSeconds : 0, 82.8)
})

test('truncationEvidence: margin scales with the caller (native-parity tunable)', () => {
  assert.equal(assessEnded(input({ currentTime: 178.5, duration: 180, marginSeconds: 3 })).kind, 'plausible')
  assert.equal(assessEnded(input({ currentTime: 176.9, duration: 180, marginSeconds: 3 })).kind, 'ended-early')
})

test('truncationEvidence: input is never mutated', () => {
  const i = input({ currentTime: 10, duration: 100 })
  const snapshot = { ...i }
  assessEnded(i)
  assert.deepEqual(i, snapshot)
})
