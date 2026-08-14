// Pins the playback-param persistence and RESTORE ORDER for tape mode and snap
// tolerance across web and native init. The restore helpers take already-read
// values (the async `getSetting` reads stay in `_initWeb`/`_initNative`), so the
// snap-before-pitch ordering and the store sync can be exercised in Node with
// fake engines — no DOM, no Dexie, no Capacitor.
//
// The order is pinned BEHAVIORALLY, not by call-sequence strings: each fake
// records the snap tolerance in force when `setPitchOctaves` runs. If pitch were
// applied before the tolerance, that probe reads the 0.15 default and the test
// fails — without coupling to the exact order of unrelated calls.
//
// The shared persistence path (`_subscribeShared`) writes settings via
// setSetting → db.userSettings.put, so that table write is stubbed like the
// playQueue write in the other manager suites (each Dexie instance owns its own
// Table prototype). NOTE: `_subscribeShared` returns no unsubscribe handle, so it
// must be exercised exactly once per process (here, in the final test) — a
// second call would leak its subscriptions into subsequent tests.

import './stub-audio-worklet-node'
import { test } from 'node:test'

import { db } from '../src/lib/db'
const settingsPuts: Array<{ key: string; value: string | number | boolean | object }> = []
Object.getPrototypeOf(db.userSettings).put = (async (entry: { key: string; value: string | number | boolean | object }) => {
  settingsPuts.push(entry)
}) as never

import assert from 'node:assert/strict'
import {
  playbackSpeed,
  pitchOctaves,
  tapeMode,
  snapTolerance,
} from '../src/stores/appState'
import { PlaybackManager } from '../src/lib/playbackManager'
import { audioManager } from '../src/lib/audioManager'
import { engine } from '../src/lib/engineFacade'
import { queueManager } from '../src/lib/queueManager'
import { snapPitchToSemitone } from '../src/lib/playbackCore/pitchSnap'
import { get } from 'svelte/store'

// --- fakes -----------------------------------------------------------------

/** Web backend fake: records the applied values; `preamp` truthy so the gain apply runs. */
class FakeAudioManager {
  preamp = {} as GainNode
  calls: string[] = []
  private _snap = 0.15
  /** The tolerance in force when setPitchOctaves last ran (0.15 = the bug's default). */
  snapAtPitchTime: number | null = null

  setSpeed(v: number): void { this.calls.push(`setSpeed:${v}`) }
  setSnapTolerance(v: number): void { this._snap = v; this.calls.push(`setSnapTolerance:${v}`) }
  setPitchOctaves(v: number): void { this.snapAtPitchTime = this._snap; this.calls.push(`setPitchOctaves:${v}`) }
  setMasterVolume(v: number): void { this.calls.push(`setMasterVolume:${v}`) }
  setTapeMode(v: boolean): void { this.calls.push(`setTapeMode:${v}`) }
}

/** Native facade fake: mirrors the real facade's snap-at-boundary behavior so the
 *  test can prove the tolerance in force when pitch was applied AND the store
 *  ends up with the snapped value, not the raw one. */
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
  pushNativeEqFromStore(): void { this.calls.push('pushNativeEqFromStore') }
  get pitchOctaves(): number { return this._pitch }
}

class FakeQueueManager {
  replenishAutoQueue(): void {}
  rebuildAutoQueue(): void {}
}

// --- harness ---------------------------------------------------------------

type PrivatePM = {
  _restoreWebPlaybackParams(s: { speed?: number; pitch?: number; gain?: number; tape?: boolean; snap?: number }): void
  _restoreNativePlaybackParams(s: { speed?: number; pitch?: number; gain?: number; tape?: boolean; snap?: number }): void
  _subscribeShared(): void
}

function makeHarness() {
  const am = new FakeAudioManager()
  const eng = new FakeEngine()
  const qm = new FakeQueueManager()
  const m = new PlaybackManager({
    audioManager: am as unknown as typeof audioManager,
    engine: eng as unknown as typeof engine,
    queueManager: qm as unknown as typeof queueManager,
  }) as unknown as PrivatePM
  return { am, eng, qm, m }
}

function resetParamStores(): void {
  playbackSpeed.set(1)
  pitchOctaves.set(0)
  tapeMode.set(false)
  snapTolerance.set(0.15)
}

// --- web restore -----------------------------------------------------------

test('web restore: the restored snap tolerance is in force when pitch is applied', () => {
  resetParamStores()
  const { am, m } = makeHarness()
  m._restoreWebPlaybackParams({ speed: 1.2, snap: 0.3, pitch: 0.05, gain: 0.8, tape: true })

  assert.equal(am.snapAtPitchTime, 0.3, 'pitch must be applied after the restored tolerance, not the 0.15 default')
  assert.ok(am.calls.includes('setTapeMode:true'))
  assert.ok(am.calls.includes('setSpeed:1.2'))
  assert.ok(am.calls.includes('setMasterVolume:0.8'))
})

test('web restore: engine-default speed/pitch are skipped, snap and tape still applied', () => {
  resetParamStores()
  const { am, m } = makeHarness()
  m._restoreWebPlaybackParams({ speed: 1, snap: 0, pitch: 0, tape: false })

  assert.equal(am.snapAtPitchTime, null, 'a skipped default pitch must not re-apply pitch')
  assert.ok(am.calls.includes('setSnapTolerance:0'))
  assert.ok(am.calls.includes('setTapeMode:false'))
  assert.ok(!am.calls.includes('setSpeed:1'))
})

// --- native restore --------------------------------------------------------

test('native restore: the restored tolerance is in force and the pitch store keeps the snapped value', () => {
  resetParamStores()
  const { eng, m } = makeHarness()
  // 0.06 oct = 0.72 semitone → snaps to 1/12 under a 0.5-semitone tolerance.
  m._restoreNativePlaybackParams({ speed: 1.2, snap: 0.5, pitch: 0.06, gain: 0.8, tape: true })

  assert.equal(eng.snapAtPitchTime, 0.5, 'pitch must snap against the restored tolerance, not the 0.15 default')
  assert.equal(get(pitchOctaves), snapPitchToSemitone(0.06, 0.5))
  assert.equal(get(tapeMode), true)
  assert.equal(get(snapTolerance), 0.5)
  assert.equal(get(playbackSpeed), 1.2)
})

test('native restore: unset pitch syncs the store to 0 and tape/snap defaults do not clobber', () => {
  resetParamStores()
  const { m } = makeHarness()
  m._restoreNativePlaybackParams({ snap: 0.3, tape: false })

  assert.equal(get(pitchOctaves), 0)
  assert.equal(get(tapeMode), false)
  assert.equal(get(snapTolerance), 0.3)
  assert.equal(get(playbackSpeed), 1)
})

// --- shared persistence ----------------------------------------------------

test('_subscribeShared persists tape mode and snap tolerance to settings and the engine', () => {
  resetParamStores()
  settingsPuts.length = 0
  const { eng, m } = makeHarness()
  // Single _subscribeShared call in this process — see the file-header note.
  m._subscribeShared()

  tapeMode.set(true)
  snapTolerance.set(0.3)

  assert.ok(eng.calls.includes('setTapeMode:true'))
  assert.ok(eng.calls.includes('setSnapTolerance:0.3'))
  assert.ok(
    settingsPuts.some((p) => p.key === 'tapeMode' && p.value === true),
    'tapeMode must persist via setSetting',
  )
  assert.ok(
    settingsPuts.some((p) => p.key === 'snapTolerance' && p.value === 0.3),
    'snapTolerance must persist via setSetting',
  )
})
