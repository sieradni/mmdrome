import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rearmDecision, type SleepTimerArmedState } from '../src/lib/sleepTimerMirror'

function armed(over: Partial<SleepTimerArmedState> = {}): SleepTimerArmedState {
  return { active: true, mode: 'minutes', endsAt: 1_000_000, minutes: 30, ...over }
}

test('inactive timer never re-arms', () => {
  const d = rearmDecision(armed({ active: false }), 0)
  assert.equal(d.shouldReArm, false)
})

test('minutes mode re-arms with the exact remaining time from endsAt', () => {
  const now = 1_000_000
  const d = rearmDecision(armed({ endsAt: now + 150_000, minutes: 30 }), now)
  assert.equal(d.shouldReArm, true)
  assert.equal(d.mode, 'minutes')
  assert.equal(d.minutes, 2.5)
})

test('minutes mode re-arms with sub-minute precision (not rounded up)', () => {
  const now = 1_000_000
  const d = rearmDecision(armed({ endsAt: now + 90_000 }), now)
  assert.equal(d.minutes, 1.5)
  const d2 = rearmDecision(armed({ endsAt: now + 30_000 }), now)
  assert.equal(d2.minutes, 0.5)
})

test('already-expired minutes timer re-arms at the ~1s floor (pause still arrives)', () => {
  const now = 1_000_000
  const d = rearmDecision(armed({ endsAt: now - 10_000 }), now)
  assert.equal(d.shouldReArm, true)
  assert.equal(d.minutes, 0.01)
})

test('endOfTrack mode re-arms as a flag, passing the nominal minutes through', () => {
  const d = rearmDecision(armed({ mode: 'endOfTrack', endsAt: 0, minutes: 5 }), 0)
  assert.equal(d.shouldReArm, true)
  assert.equal(d.mode, 'endOfTrack')
  assert.equal(d.minutes, 5)
})

test('a snapshot does not alter the decision — re-arm is idempotent', () => {
  const state = armed({ endsAt: 2_000_000 })
  const a = rearmDecision(state, 1_000_000)
  const b = rearmDecision(state, 1_000_000)
  assert.deepEqual(b, a)
})