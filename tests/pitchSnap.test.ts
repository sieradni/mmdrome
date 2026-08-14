import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapPitchToSemitone } from '../src/lib/playbackCore/pitchSnap'

const SEMITONE = 1 / 12

test('snapPitchToSemitone: zero tolerance never snaps', () => {
  assert.equal(snapPitchToSemitone(0.05, 0), 0.05)
  assert.equal(snapPitchToSemitone(SEMITONE, 0), SEMITONE)
})

test('snapPitchToSemitone: tolerance 0.5 always snaps to the nearest semitone', () => {
  // Max distance to a semitone is half a semitone, so 0.5 snaps every value.
  assert.equal(snapPitchToSemitone(0.001, 0.5), 0)
  assert.equal(snapPitchToSemitone(0.06, 0.5), SEMITONE)
  assert.equal(snapPitchToSemitone(1.001, 0.5), 1)
})

test('snapPitchToSemitone: snaps within tolerance, leaves outside values alone', () => {
  // 0.2 oct = 2.4 semitones → 0.4 semitone from the nearest semitone (2).
  assert.equal(snapPitchToSemitone(0.2, 0.5), 2 * SEMITONE)
  assert.equal(snapPitchToSemitone(0.2, 0.1), 0.2)
})

test('snapPitchToSemitone: exact semitones and octaves are unchanged', () => {
  assert.equal(snapPitchToSemitone(0, 0.15), 0)
  assert.equal(snapPitchToSemitone(SEMITONE, 0.15), SEMITONE)
  assert.equal(snapPitchToSemitone(1, 0.15), 1)
  assert.equal(snapPitchToSemitone(-2, 0.15), -2)
})

test('snapPitchToSemitone: tolerance is clamped to [0, 0.5]', () => {
  assert.equal(snapPitchToSemitone(0.05, -1), 0.05) // negative → no snap
  assert.equal(snapPitchToSemitone(0.06, 99), SEMITONE) // >0.5 → always snap
})

test('snapPitchToSemitone: negative pitches snap to negative semitones', () => {
  assert.equal(snapPitchToSemitone(-0.06, 0.5), -SEMITONE)
})

test('snapPitchToSemitone: half-semitone rounds away from zero (Swift parity)', () => {
  // 0.5/12 is exactly half a semitone in both engines; the tie must resolve the
  // same way (Swift `Double.rounded()` = away from zero), not toward +∞.
  assert.equal(snapPitchToSemitone(0.5 / 12, 0.5), SEMITONE)
  assert.equal(snapPitchToSemitone(-0.5 / 12, 0.5), -SEMITONE)
})
