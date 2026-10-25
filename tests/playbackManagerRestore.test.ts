// Pins the playback-param restore ordering and the cancellable shared
// subscriptions. The persisted stores are restored by `initStores` (see
// tests/persistedStore.test.ts), so the manager only needs to push them to the
// engine — `_applyPlaybackParams` does that in snap-before-pitch order. The
// order is pinned BEHAVIORALLY, not by call-sequence strings: the fake engine
// records the tolerance in force when `setPitchOctaves` runs, so a pitch-first
// bug reads the 0.15 default and the test fails.

import './stub-audio-worklet-node'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  playbackSpeed,
  pitchOctaves,
  tapeMode,
  snapTolerance,
  masterGain,
  settings,
  shuffleEnabled,
  loopMode,
  autoQueueFilterFields,
} from '../src/stores/appState'
import { get } from 'svelte/store'
import { PlaybackManager } from '../src/lib/playbackManager'
import { engine } from '../src/lib/engineFacade'
import { queueManager } from '../src/lib/queueManager'
import { snapPitchToSemitone } from '../src/lib/playbackCore/pitchSnap'

// --- fakes -----------------------------------------------------------------

/** Engine facade fake: models the real facade's snap-at-boundary behavior for
 *  pitch (record the tolerance in force, snap the value, keep the effective
 *  pitch readable) so the ordered apply and the snap outcome are observable. */
class FakeEngine {
  calls: string[] = []
  private _snap = 0.15
  private _pitch = 0
  /** The tolerance in force when setPitchOctaves last ran (0.15 = the bug's default). */
  snapAtPitchTime: number | null = null

  setSpeed(v: number): void { this.calls.push(`setSpeed:${v}`) }
  setSnapTolerance(v: number): void { this._snap = v; this.calls.push(`setSnapTolerance:${v}`) }
  setPitchOctaves(v: number): void {
    this.snapAtPitchTime = this._snap
    this._pitch = snapPitchToSemitone(v, this._snap)
    this.calls.push(`setPitchOctaves:${v}`)
  }
  setMasterVolume(v: number): void { this.calls.push(`setMasterVolume:${v}`) }
  setTapeMode(v: boolean): void { this.calls.push(`setTapeMode:${v}`) }
  setCrossfade(v: number): void { this.calls.push(`setCrossfade:${v}`) }
  setAudioMixing(mode: string): void { this.calls.push(`setAudioMixing:${mode}`) }

  setSeekEpochs(): void {}
  get pitchOctaves(): number { return this._pitch }
}

class FakeQueueManager {
  replenished = 0
  rebuilt = 0
  freshContexts = 0
  replenishAutoQueue(): void { this.replenished++ }
  rebuildAutoQueue(): void { this.rebuilt++ }
  rebuildForFreshContext(): void { this.freshContexts++ }
}

/** Only the two calls `_subscribeShared` can make on the web transport. */
class FakeWebTransport {
  calls: string[] = []
  cancelNext(): void { this.calls.push('cancelNext') }
}

// --- harness ---------------------------------------------------------------

type PrivatePM = {
  _applyPlaybackParams(): void
  _subscribeShared(): Array<() => void>
  _initialized: boolean
}

function makeHarness() {
  const eng = new FakeEngine()
  const qm = new FakeQueueManager()
  const web = new FakeWebTransport()
  const m = new PlaybackManager({
    engine: eng as unknown as typeof engine,
    queueManager: qm as unknown as typeof queueManager,
    webTransport: web as never,
  }) as unknown as PrivatePM
  return { eng, qm, web, m }
}

function resetParamStores(): void {
  playbackSpeed.set(1)
  pitchOctaves.set(0)
  tapeMode.set(false)
  snapTolerance.set(0.15)
  masterGain.set(1)
  settings.set({})
}

// --- tests -----------------------------------------------------------------

test('_applyPlaybackParams applies snap tolerance before pitch', () => {
  resetParamStores()
  snapTolerance.set(0.5)
  pitchOctaves.set(0.06) // 0.72 semitone → snaps under a 0.5-semitone tolerance
  const { eng, m } = makeHarness()

  m._applyPlaybackParams()

  assert.equal(eng.snapAtPitchTime, 0.5, 'pitch must snap against the restored tolerance, not the 0.15 default')
  assert.equal(eng.pitchOctaves, snapPitchToSemitone(0.06, 0.5))
})

test('_applyPlaybackParams applies speed, tape mode, and master gain', () => {
  resetParamStores()
  playbackSpeed.set(1.2)
  tapeMode.set(true)
  masterGain.set(0.8)
  const { eng, m } = makeHarness()

  m._applyPlaybackParams()

  assert.ok(eng.calls.includes('setSpeed:1.2'))
  assert.ok(eng.calls.includes('setTapeMode:true'))
  assert.ok(eng.calls.includes('setMasterVolume:0.8'))
})

test('_subscribeShared returns unsubscribers that stop the reactions', () => {
  resetParamStores()
  const { eng, m } = makeHarness()

  const unsubs = m._subscribeShared()
  settings.set({ crossfadeDuration: 5 })
  assert.ok(eng.calls.includes('setCrossfade:5'), 'the settings reaction applies crossfade')

  unsubs.forEach((unsubscribe) => unsubscribe())
  settings.set({ crossfadeDuration: 7 })
  assert.ok(!eng.calls.includes('setCrossfade:7'), 'unsubscribing must stop the settings reaction')
})

test('_subscribeShared still runs the one-shot auto-queue replenish', () => {
  resetParamStores()
  const { qm, m } = makeHarness()

  m._subscribeShared()

  assert.equal(qm.replenished, 1, 'the subscribe-time replenish is a call-site side effect, not a subscription')
})

test('_subscribeShared rebuilds the auto queue on a shuffle toggle, and unsubscribing stops it', () => {
  resetParamStores()
  shuffleEnabled.set(false)
  const { qm, m } = makeHarness()
  m._initialized = true
  const unsubs = m._subscribeShared()
  try {
    // A Svelte store subscription fires immediately; that initial fire is a
    // real rebuild too, so measure deltas from the post-subscribe count.
    const baseline = qm.rebuilt
    shuffleEnabled.set(true)
    assert.equal(qm.rebuilt, baseline + 1, 'shuffle on re-samples the auto fill')
    shuffleEnabled.set(false)
    assert.equal(qm.rebuilt, baseline + 2, 'shuffle off returns the fill to the sort order')

    unsubs.forEach((unsubscribe) => unsubscribe())
    shuffleEnabled.set(true)
    assert.equal(qm.rebuilt, baseline + 2, 'the subscription is released by destroy()')
  } finally {
    for (const u of unsubs) u()
  }
})

test('the subscribe-time filter fire never resets the anti-repeat window (D7 is destructive)', async () => {
  // Every Svelte store subscription fires once on subscribe. D7's reaction
  // clears `recentTrackIds` and rebuilds the tail, so a boot fire would wipe
  // the restored window and replace the restored tail on EVERY app start. The
  // reaction layer therefore compares live filter VALUES before scheduling.
  resetParamStores()
  const { qm, m } = makeHarness()
  m._initialized = true
  const unsubs = m._subscribeShared()
  try {
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(qm.freshContexts, 0, 'an unchanged filter set schedules nothing')

    // A REAL edit still reaches the fresh-context rebuild.
    autoQueueFilterFields.set({ ...get(autoQueueFilterFields), minRating: 50 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(qm.freshContexts, 1, 'a changed filter set is one fresh context')
  } finally {
    for (const u of unsubs) u()
  }
})

test('_subscribeShared cancels the armed web fade exactly when loop-one is selected', () => {
  resetParamStores()
  loopMode.set('none')
  const { web, m } = makeHarness()
  const unsubs = m._subscribeShared()
  try {
    loopMode.set('one')
    assert.equal(web.calls.filter((c) => c === 'cancelNext').length, 1, 'a fade must never run into a loop-one restart')

    loopMode.set('all')
    assert.equal(web.calls.filter((c) => c === 'cancelNext').length, 1, 'leaving loop-one cancels nothing')

    unsubs.forEach((unsubscribe) => unsubscribe())
    loopMode.set('one')
    assert.equal(web.calls.filter((c) => c === 'cancelNext').length, 1, 'unsubscribed')
  } finally {
    for (const u of unsubs) u()
  }
})
