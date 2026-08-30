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
import { queueManager } from '../src/lib/queueManager'
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
  prepareNext(targetId: string | null): void {
    this.calls.push(`prepareNext:${targetId}`)
  }
  async playLoaded(): Promise<boolean> {
    this.calls.push('playLoaded')
    return true
  }
}

class FakeBgTransport {
  engagedValue = false
  get engaged(): boolean {
    return this.engagedValue
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
  handleQueueRowRemoved(removedId: string): Promise<void>
  _setupNextTrack(): Promise<void>
  _rearmCrossfadeTarget(): void
  _initialized: boolean
}

function makeHarness(isNative: () => boolean = () => false) {
  const am = new FakeAudioManager()
  const stm = new FakeSleepTimer()
  const web = new FakeWebTransport()
  const bg = new FakeBgTransport()
  const m = new PlaybackManager({
    audioManager: am as unknown as typeof audioManager,
    sleepTimerManager: stm as unknown as typeof sleepTimerManager,
    webTransport: web as unknown as WebTransport,
    bgTransport: bg as unknown as WebBgTransport,
    isNative,
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

// `_setupNextTrack` awaits resolveSrc (a caches lookup that resolves
// immediately in Node), so the deferred prepareNext lands after one tick.
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
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

test('removing the PLAYING row skips to the next track immediately (2.7)', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1, t2])
  queue.set({ userQueue: ['navidrome-t1', 'navidrome-t2'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  setCurrentTrack(t1)
  setPlaybackState('playing')

  const removedId = queueManager.removeFromUserQueue(0)
  assert.equal(removedId, 'navidrome-t1')
  await h.m.handleQueueRowRemoved(removedId)

  // The skip happened NOW — not at the removed track's natural end.
  assert.equal(get(currentTrack)?.trackId, 'navidrome-t2')
  assert.equal(get(playbackState), 'playing')
  const q = get(queue)
  assert.equal(q.activeIndex, 0)
  assert.equal([...q.userQueue, ...q.autoQueue][q.activeIndex], 'navidrome-t2')
  // The removed track entered the recency window (removal = "not now"); the
  // next row was NOT pre-marked (it is about to play).
  assert.ok(q.recentTrackIds.includes('navidrome-t1'))
  assert.ok(!q.recentTrackIds.includes('navidrome-t2'))
})

test('removal skip ignores loop-one — the removed track never restarts', async () => {
  const h = makeHarness()
  resetStores()
  loopMode.set('one')
  library.set([t0, t1, t2])
  queue.set({ userQueue: ['navidrome-t1', 'navidrome-t2'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  setCurrentTrack(t1)
  setPlaybackState('playing')

  const removedId = queueManager.removeFromUserQueue(0)
  assert.ok(removedId)
  await h.m.handleQueueRowRemoved(removedId)

  // The removed track is unloopable — the chain must ADVANCE, not restart it.
  assert.equal(get(currentTrack)?.trackId, 'navidrome-t2')
  assert.equal(get(playbackState), 'playing')
})

test('removing a non-playing row leaves playback untouched', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1, t2])
  queue.set({ userQueue: ['navidrome-t1', 'navidrome-t2'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  setCurrentTrack(t1)
  setPlaybackState('playing')

  const removedId = queueManager.removeFromUserQueue(1) // t2, the NEXT row
  assert.equal(removedId, 'navidrome-t2')
  await h.m.handleQueueRowRemoved(removedId)

  assert.equal(get(currentTrack)?.trackId, 'navidrome-t1')
  assert.equal(get(playbackState), 'playing')
})

test('native: the removal handler is a no-op — the engine drives the skip', async () => {
  const h = makeHarness(() => true)
  resetStores()
  library.set([t0, t1, t2])
  queue.set({ userQueue: ['navidrome-t1', 'navidrome-t2'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  setCurrentTrack(t1)
  setPlaybackState('playing')

  const removedId = queueManager.removeFromUserQueue(0)
  assert.ok(removedId)
  await h.m.handleQueueRowRemoved(removedId)

  // The divergent tail sync → engine `ended` (1.4) owns the skip natively.
  assert.equal(get(currentTrack)?.trackId, 'navidrome-t1')
  assert.equal(get(playbackState), 'playing')
})

test('removing the active LAST row lets it play out (native parity, 2.7)', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1, t2])
  queue.set({ userQueue: ['navidrome-t1', 'navidrome-t2'], autoQueue: [], recentTrackIds: [], activeIndex: 1 })
  setCurrentTrack(t2)
  setPlaybackState('playing')

  const removedId = queueManager.removeFromUserQueue(1) // the PLAYING, LAST row
  assert.equal(removedId, 'navidrome-t2')
  await h.m.handleQueueRowRemoved(removedId)

  // No successor exists — the native sync guard bails on the out-of-range
  // index, so the engine plays the track out; web must not cut the audio.
  assert.equal(get(currentTrack)?.trackId, 'navidrome-t2')
  assert.equal(get(playbackState), 'playing')
})

test('loop-one stops instead of restarting a removed track at its natural end (2.7)', async () => {
  const h = makeHarness()
  resetStores()
  loopMode.set('one')
  library.set([t0, t1, t2])
  // The playing track was removed — it is not in the queue anymore.
  queue.set({ userQueue: [], autoQueue: [], recentTrackIds: [], activeIndex: -1 })
  setCurrentTrack(t1)
  setPlaybackState('playing')

  await h.m._onTrackEnded(false)

  // A removed track is unloopable: the natural-end restart must STOP, never
  // replay the row that left the queue (native's engage also can't re-target
  // its out-of-range index).
  assert.equal(get(currentTrack), null)
  assert.equal(get(playbackState), 'stopped')
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

// --- stale crossfade-arm regression (queue mutation must re-arm the target) --

test('removing the ARMED next row re-arms the crossfade target past the removal', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1, t2])
  queue.set({ userQueue: ['t0', 'navidrome-t1', 'navidrome-t2'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  setCurrentTrack(t0)
  setPlaybackState('playing')
  h.m._initialized = true

  // The playing track's arm targets the next row (t1).
  h.web.calls = []
  h.m._rearmCrossfadeTarget()
  await flush()
  assert.ok(h.web.calls.includes('prepareNext:navidrome-t1'))

  // The user removes that ARMED row — the re-arm must now target the NEW next
  // row (t2), never the removed t1 (which would autoplay at the transition
  // point and then be rescued back into the queue).
  h.web.calls = []
  const removedId = queueManager.removeFromUserQueue(1)
  assert.equal(removedId, 'navidrome-t1')
  await h.m.handleQueueRowRemoved(removedId)
  h.m._rearmCrossfadeTarget()
  await flush()

  assert.ok(h.web.calls.includes('prepareNext:navidrome-t2'))
  assert.ok(!h.web.calls.includes('prepareNext:navidrome-t1'))
})

test('removing the tail next row disarms the arm (no stale fade into a removed row)', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1])
  queue.set({ userQueue: ['t0', 'navidrome-t1'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  setCurrentTrack(t0)
  setPlaybackState('playing')
  h.m._initialized = true

  const removedId = queueManager.removeFromUserQueue(1)
  assert.equal(removedId, 'navidrome-t1')
  await h.m.handleQueueRowRemoved(removedId)
  h.web.calls = []
  h.m._rearmCrossfadeTarget()
  await flush()

  // Nothing follows — the arm must be disarmed, not left pointing at the
  // removed row.
  assert.ok(h.web.calls.includes('prepareNext:null'))
})

test('removing the active LAST row plays it out and disarms the arm', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1])
  queue.set({ userQueue: ['t0', 'navidrome-t1'], autoQueue: [], recentTrackIds: [], activeIndex: 1 })
  setCurrentTrack(t1)
  setPlaybackState('playing')
  h.m._initialized = true

  const removedId = queueManager.removeFromUserQueue(1)
  assert.equal(removedId, 'navidrome-t1')
  await h.m.handleQueueRowRemoved(removedId)

  // No successor — the track plays out (no immediate skip, 2.7 parity).
  assert.equal(get(currentTrack)?.trackId, 'navidrome-t1')
  assert.equal(get(playbackState), 'playing')
  // And the arm is disarmed: nothing follows the playing track.
  h.web.calls = []
  h.m._rearmCrossfadeTarget()
  await flush()
  assert.ok(h.web.calls.includes('prepareNext:null'))
})

test('queue re-arm still runs while bg-engaged (a hidden fill must not leave the fg target stale)', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1, t2])
  queue.set({ userQueue: ['t0', 'navidrome-t1', 'navidrome-t2'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  setCurrentTrack(t0)
  setPlaybackState('playing')
  h.m._initialized = true
  h.bg.engagedValue = true

  // The armed next row (t1) is removed while backgrounded (scan-complete
  // fill re-rank) — the fg target must move to t2 so a plain-resume exit
  // never fades into the removed row.
  const removedId = queueManager.removeFromUserQueue(1)
  assert.equal(removedId, 'navidrome-t1')
  h.web.calls = []
  h.m._rearmCrossfadeTarget()
  await flush()

  assert.ok(h.web.calls.includes('prepareNext:navidrome-t2'))
  assert.ok(!h.web.calls.includes('prepareNext:navidrome-t1'))
})

test('queue-write bursts coalesce into ONE re-arm reading the final snapshot', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1, t2])
  queue.set({ userQueue: ['t0', 'navidrome-t1', 'navidrome-t2'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  setCurrentTrack(t0)
  setPlaybackState('playing')
  h.m._initialized = true

  // A single flow fires several writes (advance → advanceTo + promote +
  // replenish): remove t1 then reorder, both in the same task. Only ONE
  // re-arm may run, reading the FINAL queue (t2 is next).
  queueManager.removeFromUserQueue(1)
  h.m._rearmCrossfadeTarget()
  queueManager.reorderAll(['t0', 'navidrome-t2'], [])
  h.m._rearmCrossfadeTarget()
  h.web.calls = []
  await flush()

  const arms = h.web.calls.filter((c) => c.startsWith('prepareNext:'))
  assert.equal(arms.length, 1)
  assert.equal(arms[0], 'prepareNext:navidrome-t2')
})

test('a stale re-arm whose target was removed mid-resolve is dropped (the removal re-arms the new next)', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1, t2])
  queue.set({ userQueue: ['t0', 'navidrome-t1', 'navidrome-t2'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  setCurrentTrack(t0)
  h.m._initialized = true

  // Start the arm against t1, then remove t1 BEFORE the URL resolve lands —
  // the late arm must be dropped (the removal's re-arm owns the new target).
  // The index stays 1 after the removal, so this pins the ID-based check.
  h.web.calls = []
  const p = h.m._setupNextTrack()
  const removedId = queueManager.removeFromUserQueue(1)
  assert.equal(removedId, 'navidrome-t1')
  await p
  h.m._rearmCrossfadeTarget()
  await flush()

  assert.ok(!h.web.calls.includes('prepareNext:navidrome-t1'))
  assert.ok(h.web.calls.includes('prepareNext:navidrome-t2'))
})

test('the re-arm is skipped under loop-one (the arm is always cancelled there)', async () => {
  const h = makeHarness()
  resetStores()
  loopMode.set('one')
  library.set([t0, t1, t2])
  queue.set({ userQueue: ['t0', 'navidrome-t1', 'navidrome-t2'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  setCurrentTrack(t0)
  h.m._initialized = true

  h.web.calls = []
  h.m._rearmCrossfadeTarget()
  await flush()

  // No arm may be established under loop-one.
  assert.ok(!h.web.calls.some((c) => c.startsWith('prepareNext:')))
})

test('_setupNextTrack after an active-row removal arms the highlighted row, not activeIndex + 1', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1, t2])
  // t1 (playing) was removed — the highlight sits on t2 at activeIndex 0.
  queue.set({ userQueue: ['navidrome-t2'], autoQueue: [], recentTrackIds: ['navidrome-t1'], activeIndex: 0 })
  setCurrentTrack(t1)
  h.m._initialized = true

  h.web.calls = []
  await h.m._setupNextTrack()

  // The target must be the row AT activeIndex (the next playable row) — never
  // activeIndex + 1 (out of range, which would disarm and lose the fade).
  assert.ok(h.web.calls.includes('prepareNext:navidrome-t2'))
})

test('reorderAll re-arms the crossfade target to the new next row', async () => {
  const h = makeHarness()
  resetStores()
  library.set([t0, t1, t2])
  queue.set({ userQueue: ['t0', 'navidrome-t1', 'navidrome-t2'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  setCurrentTrack(t0)
  setPlaybackState('playing')
  h.m._initialized = true

  // Drag t1 to the end: the armed next row must become t2, not the moved t1.
  queueManager.reorderAll(['t0', 'navidrome-t2', 'navidrome-t1'], [])
  h.web.calls = []
  h.m._rearmCrossfadeTarget()
  await flush()

  assert.ok(h.web.calls.includes('prepareNext:navidrome-t2'))
  assert.ok(!h.web.calls.includes('prepareNext:navidrome-t1'))
})
