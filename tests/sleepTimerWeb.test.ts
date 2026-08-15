// Pins the WEB sleep-timer behavior (TODO 3.12): the pure countdown step, the
// end-of-track park carry (`parkAtEnd`/`isParkedAtEnd`/`parkedTrackId`), the
// pending-stop consume semantics, and the minutes-expiry → pause wiring via
// mock timers. The native mirror (re-arm decision) is pinned separately in
// sleepTimerMirror.test.ts. Importing sleepTimer pulls audioManager →
// @soundtouchjs, so the worklet global must be stubbed first (F3).

import './stub-audio-worklet-node'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { sleepTimer, type SleepTimerState } from '../src/stores/appState'
import { sleepTimerManager, webCountdownStep } from '../src/lib/sleepTimer'

function state(over: Partial<SleepTimerState> = {}): SleepTimerState {
  return { active: true, mode: 'minutes', minutes: 1, endsAt: 100_000, remainingSeconds: 60, ...over }
}

test('webCountdownStep: inactive or end-of-track timers never expire', () => {
  assert.deepEqual(webCountdownStep(state({ active: false }), 0), { expired: false })
  assert.deepEqual(webCountdownStep(state({ mode: 'endOfTrack' }), 0), { expired: false })
})

test('webCountdownStep: active minutes timer reports remaining seconds', () => {
  assert.deepEqual(webCountdownStep(state({ endsAt: 100_000 }), 40_000), { expired: false, remainingSeconds: 60 })
  assert.deepEqual(webCountdownStep(state({ endsAt: 100_000 }), 99_999.5), { expired: false, remainingSeconds: 0.0005 })
})

test('webCountdownStep: expiry is clamped and signalled once', () => {
  assert.deepEqual(webCountdownStep(state({ endsAt: 100_000 }), 100_000), { expired: true })
  assert.deepEqual(webCountdownStep(state({ endsAt: 100_000 }), 200_000), { expired: true })
})

test('parkAtEnd clears the store and records the parked track for the bg carry', () => {
  sleepTimer.set(state({ mode: 'endOfTrack', active: true }))
  sleepTimerManager.parkAtEnd('track-9')
  assert.equal(get(sleepTimer).active, false, 'park clears the timer store')
  assert.equal(sleepTimerManager.isParkedAtEnd(), true)
  assert.equal(sleepTimerManager.parkedTrackId(), 'track-9')
  sleepTimerManager.clearPendingStop()
  assert.equal(sleepTimerManager.isParkedAtEnd(), false, 'manual control supersedes a fired park')
  assert.equal(sleepTimerManager.parkedTrackId(), null)
})

test('consumePendingStop is one-shot and clearPendingStop clears both flags', () => {
  sleepTimerManager.clearPendingStop()
  assert.equal(sleepTimerManager.consumePendingStop(), false, 'nothing pending at first')
  sleepTimer.set(state())
  assert.equal(sleepTimerManager.consumePendingStop(), false, 'a live timer is not a pending stop')
})

test('isEndOfTrackArmed reflects the store on web', () => {
  sleepTimer.set(state({ mode: 'endOfTrack', active: true }))
  assert.equal(sleepTimerManager.isEndOfTrackArmed(), true)
  sleepTimer.set(state({ mode: 'minutes', active: true }))
  assert.equal(sleepTimerManager.isEndOfTrackArmed(), false)
  sleepTimer.set(state({ active: false }))
  assert.equal(sleepTimerManager.isEndOfTrackArmed(), false)
})

test('minutes expiry pauses via the registered handler (mock timers)', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    let paused = 0
    sleepTimerManager.setExpireHandler(() => { paused++ })
    await sleepTimerManager.set('minutes', 1, true)
    assert.equal(get(sleepTimer).active, true)
    assert.ok(get(sleepTimer).endsAt > 0, 'endsAt computed from the (mocked) clock')

    mock.timers.tick(59_000)
    assert.equal(paused, 0, 'still counting down')
    assert.equal(get(sleepTimer).active, true)

    mock.timers.tick(2_000)
    assert.equal(paused, 1, 'expiry pauses exactly once')
    assert.equal(get(sleepTimer).active, false, 'expiry clears the store')

    mock.timers.tick(60_000)
    assert.equal(paused, 1, 'no further fires after expiry')
  } finally {
    sleepTimerManager.setExpireHandler(null)
    sleepTimerManager.destroy()
    mock.timers.reset()
  }
})
