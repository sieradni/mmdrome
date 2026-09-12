// Manager-level tests for the seek ↔ crossfade interlock (2026-08-25).
// A user scrub must own the transition state on the web fg path: the engine's
// `markUserSeeked` latches the window-entry suppression and collapses any
// in-flight fade. BG-engaged seeks drive the bg element (no fg machinery) and
// native seeks are engine-side — neither may touch the fg engine hook.

import './stub-audio-worklet-node'
import { test } from 'node:test'
import { SEEK_THROTTLE_MS } from '../src/lib/playbackCore/seekThrottle'
import type { NativeTransport } from '../src/lib/playbackCore/nativeTransport'

// seek() itself doesn't persist, but the harness shares the module graph with
// queue mutations — stub the Dexie write up front (F3).
import { db } from '../src/lib/db'
Object.getPrototypeOf(db.playQueue).put = (async () => undefined) as never
import assert from 'node:assert/strict'
import {
  currentTime,
  setCurrentTrack,
  setPlaybackState,
  type Track,
} from '../src/stores/appState'
import { PlaybackManager } from '../src/lib/playbackManager'
import { audioManager } from '../src/lib/audioManager'
import { sleepTimerManager } from '../src/lib/sleepTimer'
import { get } from 'svelte/store'
import type { WebTransport } from '../src/lib/playbackCore/webTransport'
import type { WebBgTransport } from '../src/lib/playbackCore/webBgTransport'

class FakeEl {
  src = ''
  currentTime = 0
  paused = false
}

class FakeAudioManager {
  seekedTo: number[] = []
  activeElement = new FakeEl()
  markUserSeeked(positionSeconds: number): void {
    this.seekedTo.push(positionSeconds)
  }
}

class FakeSleepTimer {
  clearPendingStop(): void {}
  isEndOfTrackArmed(): boolean {
    return false
  }
}

class FakeWebTransport {}

class FakeBgTransport {
  isEngaged: boolean
  el: FakeEl

  constructor(isEngaged: boolean, el: FakeEl) {
    this.isEngaged = isEngaged
    this.el = el
  }

  get engaged(): boolean {
    return this.isEngaged
  }
  get sessionElement(): unknown {
    return this.el
  }
}

class FakeNativeTransport {
  seekedTo: number[] = []
  engagedValue = true
  seek(position: number, _opts?: { live?: boolean }): Promise<void> {
    // Records every call that REACHES it — the live-seek gate is manager-
    // side (playbackCore/seekThrottle), so the fake observes only passing
    // samples, exactly what the engine would receive.
    void _opts
    this.seekedTo.push(position)
    return Promise.resolve()
  }
}

function makeHarness(opts: { engaged: boolean; native: boolean; src: string }) {
  const am = new FakeAudioManager()
  const el = new FakeEl()
  el.src = opts.src
  const bg = new FakeBgTransport(opts.engaged, el)
  const nt = new FakeNativeTransport()
  const m = new PlaybackManager({
    audioManager: am as unknown as typeof audioManager,
    sleepTimerManager: new FakeSleepTimer() as unknown as typeof sleepTimerManager,
    webTransport: new FakeWebTransport() as unknown as WebTransport,
    bgTransport: bg as unknown as WebBgTransport,
    nativeTransport: nt as unknown as NativeTransport,
    isNative: () => opts.native,
  })
  return { am, el, m, nativeTransport: nt }
}

const track: Track = {
  trackId: 'navidrome-t1',
  title: 'T1',
  artist: 'A',
  album: 'AL',
  duration: 30,
  fileType: 'mp3',
}

function resetStores(): void {
  setCurrentTrack(track)
  setPlaybackState('playing')
  currentTime.set(0)
}

test('fg seek forwards the clamped position to the engine seek hook', async () => {
  const h = makeHarness({ engaged: false, native: false, src: 'https://srv/stream' })
  resetStores()

  h.m.seek(25)

  // duration 30 — position passes through unchanged
  assert.deepEqual(h.am.seekedTo, [25])
  assert.equal(h.el.currentTime, 25)
  assert.equal(get(currentTime), 25)
})

test('fg seek clamps to the track duration before consulting the engine', async () => {
  const h = makeHarness({ engaged: false, native: false, src: 'https://srv/stream' })
  resetStores()

  h.m.seek(500)

  assert.deepEqual(h.am.seekedTo, [30])
  assert.equal(h.el.currentTime, 30)
})

test('bg-engaged seek drives the bg element only — no fg engine hook', async () => {
  const h = makeHarness({ engaged: true, native: false, src: 'https://srv/stream' })
  resetStores()

  h.m.seek(28)

  assert.deepEqual(h.am.seekedTo, [])
  assert.equal(h.el.currentTime, 28)
})

test('native seek never touches the fg engine hook', async () => {
  const h = makeHarness({ engaged: false, native: true, src: 'https://srv/stream' })
  resetStores()

  h.m.seek(28)

  assert.deepEqual(h.am.seekedTo, [])
})

// --- live-seek cadence (2026-09-12): native engine seeks are heavy (cancel
// + AVAudioFile re-open + re-schedule); the SeekBar emits per pointermove and
// a held drag must not command one per event. Manager contract: live samples
// gate on the ≥150 ms cadence, non-live (press/release/keyboard/programmatic)
// always emit AND re-arm the cadence.

test('native live seeks gate on the cadence; the release sample always emits', async () => {
  const h = makeHarness({ engaged: false, native: true, src: 'https://srv/stream' })
  resetStores()

  let now = 1000
  ;(h.m as unknown as { _nowFn: () => number })._nowFn = () => now
  const m = h.m as unknown as { seek(time: number, opts?: { live?: boolean }): void }

  m.seek(5, { live: true }) // press-position sample → emits (cadence armed)
  m.seek(8, { live: true }) // 0 ms later → gated
  m.seek(12, { live: true })
  m.seek(20) // release — always emits (and re-arms)
  m.seek(21, { live: true }) // fresh drag press — re-armed by the release

  assert.deepEqual(h.nativeTransport!.seekedTo, [5, 20, 21])
})

test('native live seeks pass when spaced beyond the cadence window', async () => {
  const h = makeHarness({ engaged: false, native: true, src: 'https://srv/stream' })
  resetStores()

  let now = 1000
  ;(h.m as unknown as { _nowFn: () => number })._nowFn = () => now
  const m = h.m as unknown as { seek(time: number, opts?: { live?: boolean }): void }

  m.seek(5, { live: true })
  now += SEEK_THROTTLE_MS // a slow drag step past the 150 ms window
  m.seek(9, { live: true })

  assert.deepEqual(h.nativeTransport!.seekedTo, [5, 9])
})

test('native programmatic seeks re-arm the cadence for the next drag', async () => {
  const h = makeHarness({ engaged: false, native: true, src: 'https://srv/stream' })
  resetStores()

  let now = 1000
  ;(h.m as unknown as { _nowFn: () => number })._nowFn = () => now
  const m = h.m as unknown as { seek(time: number, opts?: { live?: boolean }): void }

  m.seek(5, { live: true }) // press sample emits
  m.seek(9, { live: true }) // 0 ms later → gated
  m.seek(7) // programmatic (media-session seekto) — emits + re-arms
  m.seek(11, { live: true }) // a new drag's press after the re-arm → emits

  assert.deepEqual(h.nativeTransport!.seekedTo, [5, 7, 11])
})

// --- web cadence (A15 extension): web seeks are cheap per-call (`el.currentTime`),
// but each fg seek ALSO runs markUserSeeked — the A12 latch + in-flight-fade
// collapse are real work, and a held mid-window drag re-armed the monitor per
// pointermove. Live drag samples share the native cadence; press/release still
// always emit AND re-arm, and bg-engaged seeks stay unthrottled.

test('web live seeks gate on the cadence; the release sample always emits', async () => {
  const h = makeHarness({ engaged: false, native: false, src: 'https://srv/stream' })
  resetStores()

  let now = 1000
  ;(h.m as unknown as { _nowFn: () => number })._nowFn = () => now
  const m = h.m as unknown as { seek(time: number, opts?: { live?: boolean }): void }

  m.seek(5, { live: true }) // drag starts — emits (cadence armed)
  m.seek(8, { live: true }) // 0 ms later → gated
  m.seek(12, { live: true }) // still inside 150 ms → gated
  m.seek(20) // release — always emits (and re-arms)
  m.seek(21, { live: true }) // a new drag's press after the re-arm → emits

  assert.deepEqual(h.am.seekedTo, [5, 20, 21])
  assert.equal(h.el.currentTime, 21)
})

test('web live seek updates currentTime even when the engine command is gated', async () => {
  const h = makeHarness({ engaged: false, native: false, src: 'https://srv/stream' })
  resetStores()

  let now = 1000
  ;(h.m as unknown as { _nowFn: () => number })._nowFn = () => now
  const m = h.m as unknown as { seek(time: number, opts?: { live?: boolean }): void }

  m.seek(5, { live: true })
  m.seek(9, { live: true }) // 0 ms later → engine command gated

  // The thumb/label follow the pointer regardless; the element + markUserSeeked
  // were the gated parts (the latch runs on the EMITTED samples only).
  assert.equal(get(currentTime), 9)
  assert.equal(h.el.currentTime, 5)
})

test('bg-engaged live seeks stay unthrottled (no fg fade machinery to guard)', async () => {
  const h = makeHarness({ engaged: true, native: false, src: 'https://srv/stream' })
  resetStores()

  const m = h.m as unknown as { seek(time: number, opts?: { live?: boolean }): void }

  m.seek(5, { live: true })
  m.seek(9, { live: true })
  m.seek(12, { live: true })

  // All three reach the bg element — nothing was gated.
  assert.equal(h.el.currentTime, 12)
  assert.deepEqual(h.am.seekedTo, [])
})
