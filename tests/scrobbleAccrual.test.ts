// Pins the A9 accrual half (TODO 3.10): forward seeks >= MAX_SEEK_DELTA (5s)
// are never credited (the playhead re-anchors), backward jumps >= 5s reset
// `played` to 0 (the audio is re-listened), normal playback accrues positive
// deltas, `played` never exceeds the track duration, and `canScrobble` gates
// a listen at 50% (short tracks) / 4 minutes (long tracks).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advancePlayhead, canScrobble } from '../src/lib/scrobbleManager'

test('normal playback accrues positive deltas and anchors lastPos', () => {
  assert.deepEqual(advancePlayhead(0, 0, 4, 300), { played: 4, lastPos: 4 })
  assert.deepEqual(advancePlayhead(4, 4, 8.5, 300), { played: 8.5, lastPos: 8.5 })
})

test('a zero or small negative delta neither credits nor resets', () => {
  assert.deepEqual(advancePlayhead(10, 10, 10, 300), { played: 10, lastPos: 10 }, 'delta 0 keeps played')
  assert.deepEqual(advancePlayhead(10, 10, 9.5, 300), { played: 10, lastPos: 9.5 }, 'small jitter keeps played, re-anchors')
})

test('forward seek at the delta boundary is credited; just over is not', () => {
  // Exactly 5s is normal playback (the boundary is exclusive).
  assert.deepEqual(advancePlayhead(10, 0, 5, 300), { played: 15, lastPos: 5 })
  // 5.01s is a manual seek: re-anchor without crediting the skipped span.
  assert.deepEqual(advancePlayhead(10, 0, 5.01, 300), { played: 10, lastPos: 5.01 })
})

test('forward seek over the delta never manufactures play time', () => {
  assert.deepEqual(advancePlayhead(10, 10, 120, 300), { played: 10, lastPos: 120 })
})

test('backward jump at the delta boundary is a reset; just under is not', () => {
  assert.deepEqual(advancePlayhead(100, 120, 115, 300), { played: 100, lastPos: 115 }, '-5s keeps played (boundary exclusive)')
  assert.deepEqual(advancePlayhead(100, 120, 114.99, 300), { played: 0, lastPos: 114.99 }, '-5.01s resets played')
})

test('backward seek resets played to 0 and re-anchors', () => {
  assert.deepEqual(advancePlayhead(100, 120, 30, 300), { played: 0, lastPos: 30 })
})

test('played never exceeds the track duration (poll-glitch guard)', () => {
  assert.deepEqual(advancePlayhead(298, 298, 300, 300), { played: 300, lastPos: 300 }, 'clamped at duration')
  assert.deepEqual(advancePlayhead(300, 299, 300, 300), { played: 300, lastPos: 300 }, 'already-clamped stays clamped')
  assert.deepEqual(advancePlayhead(0, 0, 999, 300), { played: 0, lastPos: 999 }, 'a forward seek over the delta is not clamped-credited either')
})

test('canScrobble: no duration or no play time never scrobbles', () => {
  assert.equal(canScrobble(0, 100), false)
  assert.equal(canScrobble(-1, 100), false)
  assert.equal(canScrobble(300, 0), false)
})

test('canScrobble: short tracks (under 4 min) need 50%', () => {
  assert.equal(canScrobble(180, 89), false)
  assert.equal(canScrobble(180, 90), true, 'exactly 50% counts')
  assert.equal(canScrobble(120, 60), true)
})

test('canScrobble: long tracks use the 4-minute floor, not 50%', () => {
  assert.equal(canScrobble(600, 239), false)
  assert.equal(canScrobble(600, 240), true, 'exactly 4 minutes counts')
  assert.equal(canScrobble(60 * 60, 240), true, 'a 60-min track scrobbles at the 4-min floor, not 50%')
  assert.equal(canScrobble(60 * 60, 1799), true, 'anything over the floor counts regardless of the 50% mark')
})
