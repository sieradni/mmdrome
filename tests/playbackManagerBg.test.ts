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
import { setCachedConfig, buildStreamUrl } from '../src/lib/navidromeApi'
import { __resetForTests as resetPreloader } from '../src/lib/preloader'
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
  playLoadedErrorName: string | null = null
  playLoadedScript: Array<{ started: boolean; errorName: string | null }> = []
  cancelNext(): void {
    this.calls.push('cancelNext')
  }
  prepareNext(targetId: string | null): void {
    this.calls.push(`prepareNext:${targetId}`)
  }
  async playLoaded(): Promise<{ started: boolean; errorName: string | null }> {
    this.calls.push('playLoaded')
    const next = this.playLoadedScript.shift()
    if (next) return next
    return { started: this.playLoadedOk, errorName: this.playLoadedOk ? null : this.playLoadedErrorName }
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
  _loadAndPlay(track: Track): Promise<void>
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

// --- undecodable-track rescue (NotSupportedError advances, never strands) --
// Probe evidence (e2e smoke flake): a blob whose bytes Chromium can't decode
// rejects play() with NotSupportedError while user activation is VALID (not
// an autoplay block). playLoaded exhausts its 3 attempts and the old code
// stopped the queue forever over one bad file. The rescue routes through the
// fromError A4 chain instead — same as the A5 give-up.

test('fg load with undecodable bytes advances past the dead track', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['navidrome-t2', 'navidrome-t3'], [t2, t3], 0)
  h.qm.nextTrack = t3
  h.web.playLoadedScript = [
    { started: false, errorName: 'NotSupportedError' },
    { started: true, errorName: null },
  ]

  await h.m._loadAndPlay(t2)

  assert.ok(h.qm.calls.includes('advanceQueue'), 'the rescue advances via the A4 chain')
  assert.equal(get(currentTrack)?.trackId, 'navidrome-t3')
  assert.equal(get(playbackState), 'playing')
})

test('two consecutive undecodable tracks stop instead of looping forever', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['navidrome-t2', 'navidrome-t3'], [t2, t3], 0)
  h.qm.nextTrack = t3
  h.web.playLoadedOk = false
  h.web.playLoadedErrorName = 'NotSupportedError'

  await h.m._loadAndPlay(t2)

  assert.equal(get(currentTrack), null)
  assert.equal(get(playbackState), 'stopped')
  assert.equal(h.qm.calls.filter((c) => c === 'advanceQueue').length, 1, 'exactly one rescue advance')
})

test('undecodable track under loop-one stays (rewind + single play attempt, no loop)', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['navidrome-t2'], [t2], 0)
  loopMode.set('one')
  h.web.playLoadedOk = false
  h.web.playLoadedErrorName = 'NotSupportedError'

  await h.m._loadAndPlay(t2)

  // The A4 restart branch rewinds in place and attempts play() once — it
  // never re-enters _loadAndPlay, so no rescue loop is possible. Staying on
  // the broken track (not stopped, not advanced) matches a natural loop-one
  // restart of a file that errors mid-play.
  assert.equal(get(currentTrack)?.trackId, 'navidrome-t2', 'loop-one never leaves the track')
  assert.ok(!h.qm.calls.includes('advanceQueue'), 'loop-one never advances')
  assert.equal(h.web.calls.filter((c) => c === 'playLoaded').length, 1, 'exactly one load attempt')
})

test('a superseded load (AbortError) writes nothing — the newer load owns the outcome', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['navidrome-t2'], [t2], 0)
  h.web.playLoadedScript = [{ started: false, errorName: 'AbortError' }]

  await h.m._loadAndPlay(t2)

  // The rapid-skip race: a newer load already moved state on; this stale
  // load must neither null the track nor advance the queue.
  assert.equal(get(currentTrack)?.trackId, 'navidrome-t2')
  assert.ok(!h.qm.calls.includes('advanceQueue'), 'no rescue advance for a superseded load')
})

test('autoplay block (NotAllowedError) keeps the legacy stop — never skips the user track', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['navidrome-t2', 'navidrome-t3'], [t2, t3], 0)
  h.qm.nextTrack = t3
  h.web.playLoadedScript = [{ started: false, errorName: 'NotAllowedError' }]

  await h.m._loadAndPlay(t2)

  assert.equal(get(currentTrack), null)
  assert.equal(get(playbackState), 'stopped')
  assert.ok(!h.qm.calls.includes('advanceQueue'), 'a policy block must not skip the track')
})

// --- preloaded-track offline routing (the "preloaded song doesn't play
// when I lose connection" fix) --------------------------------------------

/** Installs an in-memory Cache API so resolveSrc can serve blob URLs. Real
 *  Blobs are required: Node's own URL.createObjectURL throws on fakes. */
function installPreloadCache(trackIds: string[]): void {
  const store = new Map<string, string>()
  for (const id of trackIds) {
    const url = buildStreamUrl({ baseUrl: 'https://srv.example', username: 'u', password: 'p' }, id.replace(/^navidrome-/, ''))
    store.set(url, id)
  }
  const cache = {
    async match(u: string) {
      if (!store.has(u)) return undefined
      return { bodyUsed: false, async blob() { return new Blob([`audio-${store.get(u)}`]) } }
    },
    async put(u: string) { store.set(u, u) },
    async delete(u: string) { return store.delete(u) },
    async keys() { return [...store.keys()].map((u2) => ({ url: u2 })) },
  }
  ;(globalThis as unknown as { caches: unknown }).caches = { open: async () => cache }
}

test('a PRELOADED next track advances offline: _bgLoad serves the blob, not the stream URL', async () => {
  const h = makeHarness()
  resetStores()
  installPreloadCache(['navidrome-t2'])
  seed(h, ['navidrome-t2', 'navidrome-t3'], [t2, t3], 0)
  await h.m._bgLoad(t2)

  const urlCall = h.bg.calls[0]
  assert.match(urlCall, /^startBgLoad:blob:/, 'the bg element gets the offline-capable blob URL')
  assert.ok(!urlCall.includes('stream.view'), 'the dead-connection-prone stream URL is bypassed entirely')
  ;(globalThis as unknown as { caches?: unknown }).caches = undefined
  resetPreloader()
})

test('a PRELOADED next track advances offline: the fg advance also serves the blob', async () => {
  const h = makeHarness()
  resetStores()
  installPreloadCache(['navidrome-t2'])
  seed(h, ['navidrome-t2', 'navidrome-t3'], [t2, t3], 0)
  h.qm.nextTrack = t2
  await h.m._handleBgLoad('fg', 'advance')

  const elSrc = String(h.am.activeElement.src)
  assert.ok(elSrc.startsWith('blob:'), `fg advance loads the blob URL, got: ${elSrc}`)
  assert.ok(!elSrc.includes('stream.view'), 'the dead-connection-prone stream URL is bypassed entirely')
  ;(globalThis as unknown as { caches?: unknown }).caches = undefined
  resetPreloader()
})