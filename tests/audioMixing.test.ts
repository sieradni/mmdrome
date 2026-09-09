// Pins the iOS audio-mixing (Settings → Playback → Audio Mixing) JS wiring:
//  1. the `iosAudioMixing` default is 'exclusive' (today's take-over behavior,
//     unchanged for anyone who never touches the toggle) and an explicit
//     'mix' survives the defaults pass;
//  2. the manager pushes the mode to the engine on settings changes (the boot
//     push in `_initNative` and the live reaction share the one facade call,
//     so pinning the reaction pins the contract).
// The Swift half (mode → AVAudioSession options, single-owner mapping) is
// verified only by the ios.yml CI build — no local Swift toolchain on
// Windows (E5).

import './stub-audio-worklet-node'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { settings, applyDefaultSettings } from '../src/stores/appState'
import { PlaybackManager } from '../src/lib/playbackManager'
import { engine } from '../src/lib/engineFacade'
import { queueManager } from '../src/lib/queueManager'

class FakeEngine {
  calls: string[] = []
  setSpeed(v: number): void { this.calls.push(`setSpeed:${v}`) }
  setSnapTolerance(v: number): void { this.calls.push(`setSnapTolerance:${v}`) }
  setPitchOctaves(v: number): void { this.calls.push(`setPitchOctaves:${v}`) }
  setMasterVolume(v: number): void { this.calls.push(`setMasterVolume:${v}`) }
  setTapeMode(v: boolean): void { this.calls.push(`setTapeMode:${v}`) }
  setCrossfade(v: number): void { this.calls.push(`setCrossfade:${v}`) }
  setAudioMixing(mode: string): void { this.calls.push(`setAudioMixing:${mode}`) }
  pushNativeEqFromStore(): void { this.calls.push('pushNativeEqFromStore') }
}

class FakeQueueManager {
  replenishAutoQueue(): void {}
  rebuildAutoQueue(): void {}
}

function makeManager(): { e: FakeEngine; cleanup: () => void } {
  const e = new FakeEngine()
  const m = new PlaybackManager({
    engine: e as unknown as typeof engine,
    queueManager: new FakeQueueManager() as unknown as typeof queueManager,
    isNative: () => true,
  })
  const unsubs = (m as unknown as { _subscribeShared(): Array<() => void> })._subscribeShared()
  return { e, cleanup: () => { for (const u of unsubs) u() } }
}

test('iosAudioMixing defaults to exclusive and preserves an explicit mix', () => {
  settings.set({})
  applyDefaultSettings()
  assert.equal(get(settings).iosAudioMixing, 'exclusive')

  settings.set({ iosAudioMixing: 'mix' })
  applyDefaultSettings()
  assert.equal(get(settings).iosAudioMixing, 'mix')
})

test('settings change pushes the mixing mode to the engine', () => {
  settings.set({})
  const h = makeManager()
  try {
    h.e.calls.length = 0
    settings.set({ iosAudioMixing: 'mix' })
    assert.ok(h.e.calls.includes('setAudioMixing:mix'))

    h.e.calls.length = 0
    settings.set({})
    assert.ok(h.e.calls.includes('setAudioMixing:exclusive'))
  } finally {
    h.cleanup()
  }
})
