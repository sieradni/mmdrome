// Manager-level integration tests for the 2.4 option-b interplay with the
// advance chain. After removing the ACTIVE row the playing track is no longer
// in the queue, so `_hasNextQueued`/`advanceQueue`/`next` must target the row
// AT activeIndex (the highlighted next row) instead of `activeIndex + 1` —
// otherwise end-of-track STOPS (or wraps to the predecessor) and `next()`
// no-ops even though the next track is queued. This file pins that regression
// end-to-end with the REAL queueManager (stores + advanceQueue), unlike the bg
// glue suite's fake queue manager.
//
// TODO 2.4 option b: https://github.com/user/mmdrome — queue semantics.
// `decideAdvance` consumes the playing-track-aware `hasNext` (see
// `advanceTargetIndex` in queueMutation.ts).

import './stub-audio-worklet-node'
import { test } from 'node:test'

// advanceQueue → advanceTo → saveQueue → Dexie; there's no IndexedDB in Node,
// so the table write is stubbed (see F3: patch the real db's table directly).
import { db } from '../src/lib/db'
Object.getPrototypeOf(db.playQueue).put = (async () => undefined) as never
import assert from 'node:assert/strict'
import {
  currentTrack,
  playbackState,
  queue,
  library,
  currentTime,
  loopMode,
  sleepTimer,
  setCurrentTrack,
  setPlaybackState,
  type Track,
} from '../src/stores/appState'
import { PlaybackManager } from '../src/lib/playbackManager'
import { audioManager } from '../src/lib/audioManager'
import { sleepTimerManager } from '../src/lib/sleepTimer'
import { get } from 'svelte/store'
import { setCachedConfig } from '../src/lib/navidromeApi'
import type { WebTransport } from '../src/lib/playbackCore/webTransport'
import type { WebBgTransport } from '../src/lib/playbackCore/webBgTransport'

// --- fakes ---------------------------------------------------------------

class FakeEl {
  src = ''
  currentTime = 0
  duration = 300
  paused = false
  async play(): Promise<void> {
    this.paused = false
  }
  pause(): void {
    this.paused = true
  }
}

class FakeAudioManager {
  activeElement = new FakeEl() as unknown as HTMLAudioElement
  a = new FakeEl() as unknown as HTMLAudioElement
  b = new FakeEl() as unknown as HTMLAudioElement
  preamp: GainNode | null = null
  async ensureWebAudioReady(): Promise<void> {}
  setPreampDb(): void {}
  applyGraphicEQ(): void {}
  applyFiltersConfig(): void {}
  setEqBypass(): void {}
  setMasterVolume(): void {}
  setReplayGainMode(): void {}
  applyReplayGain(): void {}
}

class FakeWebTransport {
  calls: string[] = []
  cancelNext(): void {
    this.calls.push('cancelNext')
  }
  prepareNext(): void {
    this.calls.push('prepareNext')
  }
  async playLoaded(): Promise<boolean> {
    this.calls.push('playLoaded')
    return true
  }
}

class FakeBgTransport {
  get engaged(): boolean {
    return false
  }
  get sessionElement(): HTMLAudioElement {
    return null as unknown as HTMLAudioElement
  }
  syncSource(): void {}
  init(): void {}
  teardown(): void {}
}

class FakeSleepTimer {
  armed = false
  stopPending = false
  isEndOfTrackArmed(): boolean {
    return this.armed
  }
  consumePendingStop(): boolean {
    const v = this.stopPending
    this.stopPending = false
    return v
  }
  clearPendingStop(): void {}
  parkAtEnd(): void {}
  isParkedAtEnd(): boolean {
    return false
  }
  parkedTrackId(): string | null {
    return null
  }
}

// --- harness -------------------------------------------------------------

type PrivatePM = {
  _onTrackEnded(fromError?: boolean): Promise<void>
  next(): Promise<void>
}

function makeHarness() {
  const am = new FakeAudioManager()
  const stm = new FakeSleepTimer()
  const web = new FakeWebTransport()
  const bg = new FakeBgTransport()
  const m = new PlaybackManager({
    audioManager: am as unknown as typeof audioManager,
    sleepTimerManager: stm as unknown as typeof sleepTimerManager,
    webTransport: web as unknown as WebTransport,
    bgTransport: bg as unknown as WebBgTransport,
    isNative: () => false,
  }) as unknown as PrivatePM
  return { am, stm, web, bg, m }
}

const t0: Track = { trackId: 't0', title: 'T0', artist: 'A', album: 'AL', duration: 300, fileType: 'mp3' }
const t1: Track = { trackId: 'navidrome-t1', title: 'T1', artist: 'A', album: 'AL', duration: 300, fileType: 'mp3' }
const t2: Track = { trackId: 'navidrome-t2', title: 'T2', artist: 'A', album: 'AL', duration: 300, fileType: 'mp3' }

function resetStores(): void {
  queue.set({ userQueue: [], autoQueue: [], recentTrackIds: [], activeIndex: -1 })
  library.set([])
  setCurrentTrack(null)
  setPlaybackState('stopped')
  currentTime.set(0)
  loopMode.set('none')
  sleepTimer.set({ active: false, mode: 'minutes', minutes: 30, endsAt: 0, remainingSeconds: 0 })
  setCachedConfig({ baseUrl: 'https://srv.example', username: 'u', password: 'p' })
}

// --- tests ---------------------------------------------------------------

test('end-of-track after removing the ACTIVE row advances to the next row (not stop/wrap)', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1, t2])
  // t1 (playing) was removed from the queue — the highlight sits on t2.
  queue.set({ userQueue: ['t0', 'navidrome-t2'], autoQueue: [], recentTrackIds: ['navidrome-t1'], activeIndex: 1 })
  setCurrentTrack(t1)
  setPlaybackState('playing')

  await h.m._onTrackEnded()

  // The chain must ADVANCE to t2 — never stop, never wrap back to t0.
  assert.equal(get(currentTrack)?.trackId, 'navidrome-t2')
  assert.equal(get(playbackState), 'playing')
  const q = get(queue)
  assert.equal(q.activeIndex, 1)
  assert.equal([...q.userQueue, ...q.autoQueue][q.activeIndex], 'navidrome-t2')
  // The next row was NOT pre-marked in the recency window (it is about to play).
  assert.ok(!q.recentTrackIds.includes('navidrome-t2'))
})

test('next() after removing the ACTIVE row plays the highlighted row (not a no-op)', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1, t2])
  queue.set({ userQueue: ['t0', 'navidrome-t2'], autoQueue: [], recentTrackIds: ['navidrome-t1'], activeIndex: 1 })
  setCurrentTrack(t1)
  setPlaybackState('playing')

  await h.m.next()

  assert.equal(get(currentTrack)?.trackId, 'navidrome-t2')
  assert.equal(get(playbackState), 'playing')
})

test('control: end-of-track advance is unchanged when the active row is queued', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1, t2])
  queue.set({ userQueue: ['t0', 'navidrome-t1', 'navidrome-t2'], autoQueue: [], recentTrackIds: [], activeIndex: 1 })
  setCurrentTrack(t1)
  setPlaybackState('playing')

  await h.m._onTrackEnded()

  assert.equal(get(currentTrack)?.trackId, 'navidrome-t2')
  assert.equal(get(playbackState), 'playing')
  const q = get(queue)
  assert.equal(q.activeIndex, 2)
  // The ended track leaves the active slot and enters the recency window.
  assert.ok(q.recentTrackIds.includes('navidrome-t1'))
})
