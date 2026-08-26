// Manager-level tests for the seek ↔ crossfade interlock (2026-08-25).
// A user scrub must own the transition state on the web fg path: the engine's
// `markUserSeeked` latches the window-entry suppression and collapses any
// in-flight fade. BG-engaged seeks drive the bg element (no fg machinery) and
// native seeks are engine-side — neither may touch the fg engine hook.

import './stub-audio-worklet-node'
import { test } from 'node:test'

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

function makeHarness(opts: { engaged: boolean; native: boolean; src: string }) {
  const am = new FakeAudioManager()
  const el = new FakeEl()
  el.src = opts.src
  const bg = new FakeBgTransport(opts.engaged, el)
  const m = new PlaybackManager({
    audioManager: am as unknown as typeof audioManager,
    sleepTimerManager: new FakeSleepTimer() as unknown as typeof sleepTimerManager,
    webTransport: new FakeWebTransport() as unknown as WebTransport,
    bgTransport: bg as unknown as WebBgTransport,
    isNative: () => opts.native,
  })
  return { am, el, m }
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
