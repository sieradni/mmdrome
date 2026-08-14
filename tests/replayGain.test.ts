import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeReplayGainFields } from '../src/lib/playbackCore/replayGain'

const linear = (db: number) => Math.pow(10, db / 20)

test('track mode with a track gain → linear gain from the track gain, raw fields carried', () => {
  const f = computeReplayGainFields('track', { replayGain: -6, albumReplayGain: -3 })
  assert.ok(Math.abs(f.linearGain! - linear(-6)) < 1e-9)
  assert.equal(f.trackGainDb, -6)
  assert.equal(f.albumGainDb, -3)
})

test('album mode with an album gain → linear gain from the album gain', () => {
  const f = computeReplayGainFields('album', { replayGain: -6, albumReplayGain: -3 })
  assert.ok(Math.abs(f.linearGain! - linear(-3)) < 1e-9)
  assert.equal(f.trackGainDb, -6)
  assert.equal(f.albumGainDb, -3)
})

test('mode off → no linear gain (engine falls back to 1), raw fields still carried', () => {
  const f = computeReplayGainFields('off', { replayGain: -6, albumReplayGain: -3 })
  assert.equal(f.linearGain, null)
  assert.equal(f.trackGainDb, -6)
  assert.equal(f.albumGainDb, -3)
})

test('active mode gain missing → linear gain null, no crash', () => {
  assert.equal(computeReplayGainFields('track', { albumReplayGain: -3 }).linearGain, null)
  assert.equal(computeReplayGainFields('album', { replayGain: -6 }).linearGain, null)
})

test('track with no gain fields at all → all null', () => {
  assert.deepEqual(computeReplayGainFields('track', {}), {
    linearGain: null,
    trackGainDb: null,
    albumGainDb: null,
  })
  assert.deepEqual(computeReplayGainFields('album', undefined), {
    linearGain: null,
    trackGainDb: null,
    albumGainDb: null,
  })
})

test('non-finite gain is never promoted to a linear gain', () => {
  const f = computeReplayGainFields('track', { replayGain: Infinity, albumReplayGain: -3 })
  assert.equal(f.linearGain, null)
  assert.equal(f.trackGainDb, Infinity)
})

test('replayGain 0 dB → linear gain 1', () => {
  const f = computeReplayGainFields('track', { replayGain: 0 })
  assert.ok(Math.abs(f.linearGain! - 1) < 1e-9)
})