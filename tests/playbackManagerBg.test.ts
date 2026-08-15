// Manager-level glue tests for the bg-load wiring (TODO 1.0 step 3 review
// round). The PlaybackManager's injectable deps (audioManager/queueManager/
// sleepTimerManager/webTransport/bgTransport) are replaced with fakes so the
// store-ordering and decision-resolution glue can be exercised in Node — no
// DOM, no Dexie. Pins: the settle-safe _bgLoad store ordering (review finding
// 2), the machine decision resolution, and the fg/bg routing of _handleBgLoad.

import './stub-audio-worklet-node'
import { test } from 'node:test'

// The wrap path persists the queue via setActiveQueueIndex → saveQueue → Dexie.
// There's no IndexedDB in Node; the persistence isn't under test here, so the
// table write is stubbed (otherwise the rejected open lands as an
// unhandledRejection and fails the suite). Dexie gives every instance its own
// Table prototype, so the real db's table must be patched directly.
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
import type { WebBgTransport, BgFacts, LoadDecision } from '../src/lib/playbackCore/webBgTransport'

// --- fakes -----------------------------------------------------------------

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
  calls: string[] = []
  async ensureWebAudioReady(): Promise<void> {
    this.calls.push('ensureWebAudioReady')
  }
  setPreampDb(): void {
    this.calls.push('setPreampDb')
  }
  applyGraphicEQ(): void {
    this.calls.push('applyGraphicEQ')
  }
  applyFiltersConfig(): void {
    this.calls.push('applyFiltersConfig')
  }
  setEqBypass(): void {
    this.calls.push('setEqBypass')
  }
  setMasterVolume(): void {
    this.calls.push('setMasterVolume')
  }
  setReplayGainMode(): void {
    this.calls.push('setReplayGainMode')
  }
  applyReplayGain(): void {
    this.calls.push('applyReplayGain')
  }
}

class FakeWebTransport {
  calls: string[] = []
  playLoadedOk = true
  cancelNext(): void {
    this.calls.push('cancelNext')
  }
  prepareNext(targetId: string | null): void {
    this.calls.push(`prepareNext:${targetId}`)
  }
  async playLoaded(): Promise<boolean> {
    this.calls.push('playLoaded')
    return this.playLoadedOk
  }
}

class FakeBgTransport {
  calls: string[] = []
  loadStarted = true
  get engaged(): boolean {
    return true
  }
  get sessionElement(): HTMLAudioElement {
    return null as unknown as HTMLAudioElement
  }
  async startBgLoad(url: string): Promise<boolean> {
    this.calls.push(`startBgLoad:${url}`)
    return this.loadStarted
  }
  abortBgLoad(): void {
    this.calls.push('abortBgLoad')
  }
  syncSource(url: string): void {
    this.calls.push(`syncSource:${url}`)
  }
  loadRequest(): void {
    this.calls.push('loadRequest')
  }
  mediaPlay(): void {}
  mediaPause(): void {}
  setSpeed(): void {}
  init(): void {}
  teardown(): void {}
  onLoad: ((target: 'fg' | 'bg', decision: LoadDecision) => void) | null = null
  onStop: ((target: 'fg' | 'bg') => void) | null = null
  onParked: ((trackId: string) => void) | null = null
  onTick: ((position: number) => void) | null = null
}

class FakeQueueManager {
  tracks: Track[] = []
  combined: string[] = []
  nextTrack: Track | null = null
  calls: string[] = []
  getCombinedQueue(): string[] {
    return this.combined
  }
  findTrack(id: string): Track | null {
    return this.tracks.find((t) => t.trackId === id) ?? null
  }
  advanceQueue(): Track | null {
    this.calls.push('advanceQueue')
    return this.nextTrack
  }
  promoteActiveTrack(): void {
    this.calls.push('promoteActiveTrack')
  }
  replenishAutoQueue(): void {
    this.calls.push('replenishAutoQueue')
  }
}

class FakeSleepTimer {
  armed = false
  stopPending = false
  calls: string[] = []
  isEndOfTrackArmed(): boolean {
    return this.armed
  }
  consumePendingStop(): boolean {
    const v = this.stopPending
    this.stopPending = false
    return v
  }
  clearPendingStop(): void {
    this.calls.push('clearPendingStop')
  }
  parkAtEnd(id: string): void {
    this.calls.push(`parkAtEnd:${id}`)
  }
  isParkedAtEnd(): boolean {
    return false
  }
  parkedTrackId(): string | null {
    return null
  }
}

// --- harness ---------------------------------------------------------------

type PrivatePM = {
  _bgLoad(track: Track): Promise<void>
  _handleBgLoad(target: 'fg' | 'bg', decision: LoadDecision): Promise<void>
  _bgFacts(): BgFacts
  _resolveBgLoad(decision: LoadDecision): Track | null
  _loadAndPlayInBg(track: Track): Promise<void>
  _pendingBgTrack: Track | null
}

function makeHarness() {
  const am = new FakeAudioManager()
  const qm = new FakeQueueManager()
  const stm = new FakeSleepTimer()
  const web = new FakeWebTransport()
  const bg = new FakeBgTransport()
  const m = new PlaybackManager({
    audioManager: am as unknown as typeof audioManager,
    queueManager: qm as unknown as typeof queueManager,
    sleepTimerManager: stm as unknown as typeof sleepTimerManager,
    webTransport: web as unknown as WebTransport,
    bgTransport: bg as unknown as WebBgTransport,
  }) as unknown as PrivatePM
  return { am, qm, stm, web, bg, m }
}

const t1: Track = { trackId: 't1', title: 'T1', artist: 'A', album: 'AL', duration: 300, fileType: 'mp3' }
const t2: Track = { trackId: 'navidrome-t2', title: 'T2', artist: 'A', album: 'AL', duration: 300, fileType: 'mp3' }
const t3: Track = { trackId: 'navidrome-t3', title: 'T3', artist: 'A', album: 'AL', duration: 300, fileType: 'mp3' }

function seed(h: ReturnType<typeof makeHarness>, ids: string[], tracks: Track[], active: number): void {
  queue.set({ userQueue: ids, autoQueue: [], recentTrackIds: [], activeIndex: active })
  library.set(tracks)
  h.qm.tracks = tracks
  h.qm.combined = ids
  setCachedConfig({ baseUrl: 'https://srv.example', username: 'u', password: 'p' })
}

function resetStores(): void {
  queue.set({ userQueue: [], autoQueue: [], recentTrackIds: [], activeIndex: -1 })
  library.set([])
  setCurrentTrack(null)
  setPlaybackState('stopped')
  currentTime.set(0)
  loopMode.set('none')
  sleepTimer.set({ active: false, mode: 'minutes', minutes: 30, endsAt: 0, remainingSeconds: 0 })
  setCachedConfig(null)
}

// --- tests -----------------------------------------------------------------

test('_bgFacts maps stores + sleep-timer state', () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1', 't2'], [t1, t2], 0)
  setCurrentTrack(t1)
  h.stm.armed = true
  assert.deepEqual(h.m._bgFacts(), {
    currentTrackId: 't1',
    parkArmed: true,
    loopMode: 'none',
    hasNext: true,
    hasUserQueue: true,
    duration: 300,
  })
  h.stm.armed = false
  loopMode.set('all')
  const f = h.m._bgFacts()
  assert.equal(f.parkArmed, false)
  assert.equal(f.loopMode, 'all')
  assert.equal(f.hasNext, true)
})

test('_bgFacts hasNext false at the queue tail and without a queue', () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1'], [t1], 0)
  setCurrentTrack(t1)
  assert.equal(h.m._bgFacts().hasNext, false)
  seed(h, [], [], -1)
  assert.equal(h.m._bgFacts().hasNext, false)
  assert.equal(h.m._bgFacts().hasUserQueue, false)
})

test('_resolveBgLoad maps restart to the current track', () => {
  const h = makeHarness()
  resetStores()
  setCurrentTrack(t2)
  assert.equal(h.m._resolveBgLoad('restart'), t2)
})

test('_resolveBgLoad maps advance through the queue manager', () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['navidrome-t2', 'navidrome-t3'], [t2, t3], 0)
  h.qm.nextTrack = t3
  const resolved = h.m._resolveBgLoad('advance')
  assert.equal(resolved, t3)
  assert.deepEqual(h.qm.calls, ['advanceQueue'])
})

test('_resolveBgLoad wraps to the first user row and re-anchors the index', () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1', 'navidrome-t2'], [t1, t2], 1)
  const resolved = h.m._resolveBgLoad('wrap')
  assert.equal(resolved, t1)
  assert.equal(get(queue).activeIndex, 0)
})

test('_resolveBgLoad wrap on an empty user queue resolves null', () => {
  const h = makeHarness()
  resetStores()
  seed(h, [], [], -1)
  assert.equal(h.m._resolveBgLoad('wrap'), null)
})

test('_resolveBgLoad reload resolves the in-flight pending track', () => {
  const h = makeHarness()
  resetStores()
  h.m._pendingBgTrack = t3
  assert.equal(h.m._resolveBgLoad('reload'), t3)
})

test('_handleBgLoad bg with no resolved track aborts the load', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, [], [], -1)
  await h.m._handleBgLoad('bg', 'wrap')
  assert.deepEqual(h.bg.calls, ['abortBgLoad'])
  assert.equal(get(playbackState), 'stopped')
  assert.equal(get(currentTrack), null)
})

test('_handleBgLoad fg with no resolved track stops playback', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, [], [], -1)
  await h.m._handleBgLoad('fg', 'wrap')
  assert.deepEqual(h.web.calls, ['cancelNext'])
  assert.equal(get(playbackState), 'stopped')
  assert.equal(get(currentTrack), null)
  assert.equal(h.am.activeElement.src, '')
})

test('_bgLoad success: stores reflect the track before the settle, then post-load work runs', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['navidrome-t2', 'navidrome-t3'], [t2, t3], 0)
  await h.m._bgLoad(t2)

  assert.equal(h.m._pendingBgTrack, t2)
  assert.equal(get(currentTrack)?.trackId, 'navidrome-t2')
  assert.equal(get(playbackState), 'playing')
  assert.equal(get(currentTime), 0)

  const urlCall = h.bg.calls[0]
  assert.match(urlCall, /^startBgLoad:https:\/\/srv\.example\/rest\/stream\.view\?/)
  assert.ok(h.qm.calls.includes('promoteActiveTrack'))
  assert.ok(h.qm.calls.includes('replenishAutoQueue'))
  assert.ok(h.web.calls.includes('prepareNext:navidrome-t3'))
  assert.ok(!h.web.calls.includes('cancelNext'))
})

test('_bgLoad success under loop-one arms then cancels the crossfade', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['navidrome-t2', 'navidrome-t3'], [t2, t3], 0)
  loopMode.set('one')
  await h.m._bgLoad(t2)
  assert.ok(h.web.calls.includes('prepareNext:navidrome-t3'))
  assert.ok(h.web.calls.includes('cancelNext'))
})

test('_bgLoad with a dropped settle still lands the stores (review finding 2 pin)', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['navidrome-t2'], [t2], 0)
  h.bg.loadStarted = false
  await h.m._bgLoad(t2)

  assert.equal(h.bg.calls[0].startsWith('startBgLoad:'), true)
  assert.equal(get(currentTrack)?.trackId, 'navidrome-t2')
  assert.equal(get(playbackState), 'playing')
  assert.equal(get(currentTime), 0)
  assert.ok(!h.qm.calls.includes('promoteActiveTrack'), 'post-load work must not run after a dropped settle')
  assert.ok(!h.qm.calls.includes('replenishAutoQueue'))
})

test('_bgLoad with a fired end-of-track stop aborts and parks', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['navidrome-t2'], [t2], 0)
  h.stm.stopPending = true
  await h.m._bgLoad(t2)

  assert.deepEqual(h.bg.calls, ['abortBgLoad'])
  assert.equal(get(playbackState), 'paused')
  assert.equal(get(currentTrack), null)
  assert.ok(h.qm.calls.includes('promoteActiveTrack'))
})

test('_bgLoad without a stream config aborts without touching stores', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['navidrome-t2'], [t2], 0)
  setCachedConfig(null)
  await h.m._bgLoad(t2)
  assert.deepEqual(h.bg.calls, ['abortBgLoad'])
  assert.equal(get(currentTrack), null)
  assert.equal(get(playbackState), 'stopped')
})

test('_loadAndPlayInBg applies RG and requests the machine load', async () => {
  const h = makeHarness()
  resetStores()
  await h.m._loadAndPlayInBg(t2)
  assert.ok(h.am.calls.includes('applyReplayGain'))
  assert.deepEqual(h.bg.calls, ['loadRequest'])
  assert.equal(h.m._pendingBgTrack, t2)
})

test('_handleBgLoad fg advance plays through the full fg load path', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['navidrome-t2', 'navidrome-t3'], [t2, t3], 0)
  h.qm.nextTrack = t2

  await h.m._handleBgLoad('fg', 'advance')

  assert.ok(h.web.calls.includes('cancelNext'))
  assert.equal(get(currentTrack)?.trackId, 'navidrome-t2')
  assert.equal(get(playbackState), 'playing')
  assert.equal(get(currentTime), 0)
  assert.equal(h.am.activeElement.src.startsWith('https://srv.example/rest/stream.view'), true)
  assert.ok(h.bg.calls.some((c) => c.startsWith('syncSource:https://srv.example/rest/stream.view')))
  assert.ok(h.am.calls.includes('setReplayGainMode'))
  assert.ok(h.qm.calls.includes('promoteActiveTrack'))
  assert.ok(h.qm.calls.includes('replenishAutoQueue'))
  assert.ok(h.web.calls.includes('prepareNext:navidrome-t3'))
  assert.ok(h.web.calls.includes('playLoaded'))
})

test('_handleBgLoad fg load failure clears the track and stops', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['navidrome-t2'], [t2], 0)
  h.qm.nextTrack = t2
  h.web.playLoadedOk = false

  await h.m._handleBgLoad('fg', 'advance')

  assert.equal(get(currentTrack), null)
  assert.equal(get(playbackState), 'stopped')
})