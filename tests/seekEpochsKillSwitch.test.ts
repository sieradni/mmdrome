// Pins the seekEpochs kill switch (2026-10-07, Phase 2 of
// docs/plans/2026-10-07-seek-intent-and-stream-epochs.md §8):
//  1. the default is 'auto' — an absent key must mean the epoch feature is ON
//     (a conservative default would silently disable Phases 2-3 for everyone
//     who never touches the setting);
//  2. the manager pushes the mode to the engine facade on a settings change
//     (the field rollback path: `off` must reach the engine without a
//     relaunch), and the boot push shares that one facade call;
//  3. the HUD control's exact write path (`updateSetting`, which also PERSISTS
//     the row so the rollback survives a relaunch) reaches the engine live.
//
// The Swift half (mode → no epoch opens, a live epoch discarded) is verified by
// the ios.yml CI build + the engine's own `stream` events — no local Swift
// toolchain on Windows (E5).

import './stub-audio-worklet-node'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { settings, applyDefaultSettings, updateSetting } from '../src/stores/appState'
import { PlaybackManager } from '../src/lib/playbackManager'
import { engine } from '../src/lib/engineFacade'
import { queueManager } from '../src/lib/queueManager'
import { db } from '../src/lib/db'

// Node has no IndexedDB; patch the shared Dexie table prototype (the
// tests/autoQueueFiltersPersistence.test.ts pattern — tables share one
// prototype, so `put` is patched once) so the persistence leg of the HUD
// control's `updateSetting` can be asserted without a real database.
const savedRows = new Map<string, unknown>()
Object.getPrototypeOf(db.userSettings).put = (async (entry: { key: string; value: unknown }) => {
  savedRows.set(entry.key, entry.value)
}) as never

class FakeEngine {
  calls: string[] = []
  setSpeed(v: number): void { this.calls.push(`setSpeed:${v}`) }
  setSnapTolerance(v: number): void { this.calls.push(`setSnapTolerance:${v}`) }
  setPitchOctaves(v: number): void { this.calls.push(`setPitchOctaves:${v}`) }
  setMasterVolume(v: number): void { this.calls.push(`setMasterVolume:${v}`) }
  setTapeMode(v: boolean): void { this.calls.push(`setTapeMode:${v}`) }
  setCrossfade(v: number): void { this.calls.push(`setCrossfade:${v}`) }
  setAudioMixing(mode: string): void { this.calls.push(`setAudioMixing:${mode}`) }
  setSeekEpochs(mode: string): void { this.calls.push(`setSeekEpochs:${mode}`) }
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

test('seekEpochs defaults to auto (the feature is ON unless disabled)', () => {
  settings.set({})
  applyDefaultSettings()
  assert.equal(get(settings).seekEpochs, 'auto')

  // An explicit `off` survives the defaults pass — the rollback must not be
  // rewritten back to auto.
  settings.set({ seekEpochs: 'off' })
  applyDefaultSettings()
  assert.equal(get(settings).seekEpochs, 'off')
})

test('a settings change pushes the kill switch to the engine', () => {
  settings.set({})
  const h = makeManager()
  try {
    h.e.calls.length = 0
    settings.set({ seekEpochs: 'off' })
    assert.ok(h.e.calls.includes('setSeekEpochs:off'), 'off must reach the engine live')

    h.e.calls.length = 0
    settings.set({ seekEpochs: 'auto' })
    assert.ok(h.e.calls.includes('setSeekEpochs:auto'), 're-enabling must reach the engine too')

    // An unrelated settings emission must NOT re-push (the idempotent-push
    // rule: dense identical bursts drown the real signal in a field dump).
    h.e.calls.length = 0
    settings.update((s) => ({ ...s, crossfadeDuration: 7 }))
    assert.ok(!h.e.calls.some((c) => c.startsWith('setSeekEpochs:')), 'no re-push without a value change')
  } finally {
    h.cleanup()
  }
})

test('the HUD control path (updateSetting) persists AND pushes the kill switch', () => {
  // `updateSetting` is exactly what the DebugHud chips call (2026-10-08, plan
  // A1): the store updates, the row persists so the rollback survives a
  // relaunch, and the manager subscription pushes the value live.
  settings.set({})
  const h = makeManager()
  try {
    savedRows.clear()
    h.e.calls.length = 0
    updateSetting('seekEpochs', 'off')
    assert.equal(get(settings).seekEpochs, 'off')
    assert.equal(savedRows.get('seekEpochs'), 'off', 'the rollback must survive a relaunch')
    assert.ok(h.e.calls.includes('setSeekEpochs:off'), 'off must reach the engine live')

    h.e.calls.length = 0
    updateSetting('seekEpochs', 'auto')
    assert.equal(get(settings).seekEpochs, 'auto')
    assert.equal(savedRows.get('seekEpochs'), 'auto')
    assert.ok(h.e.calls.includes('setSeekEpochs:auto'), 're-enabling must reach the engine too')
  } finally {
    h.cleanup()
  }
})
