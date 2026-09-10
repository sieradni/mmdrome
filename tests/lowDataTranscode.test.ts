// LDM × transcoding wiring: does an ENGAGED low-data gate actually reach the
// stream URLs the engines play?
//
// Context: with `transcodeMode: 'lowData'` on native iOS over 5G cellular
// (LDM provably engaged — thumbnails step down), playback stays raw while
// `transcodeMode: 'always'` audibly transcodes. The pure policy
// (`transcodeParams`, pinned by tests/transcodePolicy.test.ts) is correct, so
// this suite pins the ADAPTER seam in two halves:
//
//  A. Steady-state URL construction (expected PASS): with the gate engaged,
//     `_resolveUrl` / `_buildSnapshot` / the `_nativeLoadPlay` engage payload
//     MUST carry `format=` + `maxBitRate=`. If these pass while the device
//     plays raw, the defect is downstream (the Swift loader cache serves a
//     stale raw file for the trackId without comparing URLs —
//     AudioEngine.swift `localURL(for:)` / `destinationURL`).
//  B. LDM-transition invalidation (expected FAIL pre-fix): engaging LDM
//     mid-session with mode 'lowData' must re-sync the native snapshot tail
//     and re-arm the web crossfade target — the transcodeKey edge
//     (mode|format|bitrate|probe) never fires for an LDM flip, and the LDM
//     edge only handles scan/probe/flush. The engine-side tail and the armed
//     target keep playing pre-engage raw URLs.
//
// Conventions: stub-audio-worklet-node first (the playback graph extends
// AudioWorkletNode at class-definition time); the Dexie put stub (queue-adjacent
// stores); the private-access + delta-spy harness from lowDataMode.test.ts;
// every subscribing test unsubscribes in finally (the stores outlive tests).

import './stub-audio-worklet-node'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'

// Queue-adjacent stores can reach Dexie via explicit saveQueue calls in some
// paths; there is no IndexedDB in Node, so the write is stubbed (the
// playbackManagerBg precedent). Patched once — ALL Dexie tables on an
// instance share one prototype (F3).
import { db } from '../src/lib/db'
Object.getPrototypeOf(db.playQueue).put = (async () => undefined) as never

import {
  settings,
  queue,
  loopMode,
  type Track,
} from '../src/stores/appState'
import { effectiveLowData, __setNetworkStatus } from '../src/lib/networkMode'
import { PlaybackManager } from '../src/lib/playbackManager'
import { engine } from '../src/lib/engineFacade'
import { queueManager } from '../src/lib/queueManager'
import { sleepTimerManager } from '../src/lib/sleepTimer'
import { setCachedConfig } from '../src/lib/navidromeApi'
import type { NativeTransport } from '../src/lib/playbackCore/nativeTransport'

// --- fakes ---------------------------------------------------------------

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

const mkTrack = (id: string): Track => ({
  trackId: `navidrome-${id}`,
  title: `Title ${id}`,
  artist: 'Artist',
  album: 'Album',
  duration: 300,
  fileType: 'mp3',
})

class FakeQueueManager {
  tracks = new Map<string, Track>()
  seed(ids: string[]): void {
    for (const id of ids) this.tracks.set(`navidrome-${id}`, mkTrack(id))
  }
  findTrack(trackId: string): Track | undefined {
    return this.tracks.get(trackId)
  }
  getCombinedQueue(): string[] {
    return [...this.tracks.keys()]
  }
  replenishAutoQueue(): void {}
  rebuildAutoQueue(): void {}
  promoteActiveTrack(): void {}
  advanceTo(): void {}
}

class FakeSleepTimer {
  clearPendingStop(): void {}
  async rearmAfterSnapshot(): Promise<void> {}
}

interface CapturedEngage {
  snapshot: Array<{ trackId: string; url: string }>
  activeIndex: number
}

class FakeNativeTransport {
  engaged = true
  captured: CapturedEngage | null = null
  async engage(
    snapshot: Array<{ trackId: string; url: string }>,
    activeIndex: number,
    _loopMode: string,
  ): Promise<boolean> {
    this.captured = { snapshot, activeIndex }
    return true
  }
  scheduleSync(): void {}
  setPositionPolling(): void {}
}

type ManagerPrivates = {
  _subscribeShared(): Array<() => void>
  _initialized: boolean
  _resolveUrl(trackId: string): string
  _buildSnapshot(combined: string[]): Array<{ trackId: string; url: string }>
}

function makeManager(opts: {
  isNative?: () => boolean
  qm?: FakeQueueManager
  nt?: FakeNativeTransport | null
} = {}): { m: PlaybackManager; priv: ManagerPrivates; cleanup(): void } {
  const m = new PlaybackManager({
    engine: new FakeEngine() as unknown as typeof engine,
    queueManager: (opts.qm ?? new FakeQueueManager()) as unknown as typeof queueManager,
    sleepTimerManager: new FakeSleepTimer() as unknown as typeof sleepTimerManager,
    nativeTransport: (opts.nt === null ? null : (opts.nt ?? new FakeNativeTransport())) as unknown as NativeTransport,
    isNative: opts.isNative,
  })
  const priv = m as unknown as ManagerPrivates
  let unsubs: Array<() => void> = []
  return {
    m,
    priv,
    cleanup() {
      for (const u of unsubs) u()
      unsubs = []
    },
  }
}

function subscribeShared(h: { priv: ManagerPrivates; cleanup(): void }): void {
  const unsubs = h.priv._subscribeShared()
  const base = h.cleanup
  h.cleanup = () => {
    for (const u of unsubs) u()
    base()
  }
}

// Store snapshots captured at load so every test restores them (the stores
// outlive tests; the queue shape is restored wholesale, not reconstructed).
const initialQueue = structuredClone(get(queue))
const initialLoopMode = get(loopMode)

function resetState(): void {
  __setNetworkStatus({ known: false, isCellular: false, osLowData: false })
  settings.set({})
  setCachedConfig(null)
  queue.set(structuredClone(initialQueue))
  loopMode.set(initialLoopMode)
}

function liveConfig(): void {
  setCachedConfig({ baseUrl: 'https://srv.example', username: 'u', password: 'p' })
}

/** The reporter's exact setup: Low-Data mp3@64 over a known-cellular link. */
function engageCellularLdm(): void {
  settings.set({
    transcodeMode: 'lowData',
    transcodeFormat: 'mp3',
    transcodeBitrate: 64,
    lowDataOnCellular: true,
  })
  __setNetworkStatus({ known: true, isCellular: true, osLowData: false, source: 'native' })
}

// --- A. steady-state URL wiring (expected PASS) ---------------------------
// These prove the JS snapshot carries the params whenever the gate is
// engaged. Passing here + raw audio on device isolates the defect downstream
// (Swift loader cache keyed by trackId, blind to the URL).

test('A1: snapshot rows carry the transcode params under cellular LDM (the 5G report scenario)', () => {
  resetState()
  try {
    const qm = new FakeQueueManager()
    qm.seed(['s1', 's2'])
    const h = makeManager({ qm, nt: null })
    liveConfig()
    engageCellularLdm()
    assert.equal(get(effectiveLowData), true, 'precondition: the gate is engaged (thumbnails prove this on device)')

    const rows = h.priv._buildSnapshot(['navidrome-s1', 'navidrome-s2'])
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.ok(row.url.includes('format=mp3'), `row ${row.trackId} must request the mp3 transcode, got: ${row.url}`)
      assert.ok(row.url.includes('maxBitRate=64'), `row ${row.trackId} must cap at 64 kbps, got: ${row.url}`)
    }
  } finally {
    resetState()
  }
})

test('A2: _resolveUrl carries the transcode params under the manual LDM toggle', () => {
  resetState()
  try {
    const qm = new FakeQueueManager()
    qm.seed(['s1'])
    const h = makeManager({ qm, nt: null })
    liveConfig()
    settings.set({ transcodeMode: 'lowData', transcodeFormat: 'mp3', transcodeBitrate: 64, lowDataMode: true })
    assert.equal(get(effectiveLowData), true)

    const url = h.priv._resolveUrl('navidrome-s1')
    assert.ok(url.includes('format=mp3'), `must request the mp3 transcode, got: ${url}`)
    assert.ok(url.includes('maxBitRate=64'), `must cap at 64 kbps, got: ${url}`)
  } finally {
    resetState()
  }
})

test('A3: no transcode params when LDM is off (the gate demonstrably gates the URL)', () => {
  resetState()
  try {
    const qm = new FakeQueueManager()
    qm.seed(['s1'])
    const h = makeManager({ qm, nt: null })
    liveConfig()
    settings.set({ transcodeMode: 'lowData', transcodeFormat: 'mp3', transcodeBitrate: 64 })
    __setNetworkStatus({ known: true, isCellular: false })
    assert.equal(get(effectiveLowData), false)

    const url = h.priv._resolveUrl('navidrome-s1')
    assert.ok(url.length > 0, 'a playable URL is still built')
    assert.ok(!url.includes('format='), `must stay byte-identical raw, got: ${url}`)
  } finally {
    resetState()
  }
})

test('A4: the native engage payload carries transcode params under cellular LDM', async () => {
  resetState()
  // _nativeLoadPlay is private; drive it through the public playTrackAt so the
  // full load path (snapshot → engage) is what the assertion observes.
  const nt = new FakeNativeTransport()
  const qm = new FakeQueueManager()
  qm.seed(['s1', 's2'])
  const h = makeManager({ isNative: () => true, qm, nt })
  try {
    liveConfig()
    engageCellularLdm()
    assert.equal(get(effectiveLowData), true)
    queue.set({ ...structuredClone(initialQueue), userQueue: ['navidrome-s1', 'navidrome-s2'], activeIndex: 0 })

    await h.m.playTrackAt(0)
    assert.ok(nt.captured !== null, 'engage must have been called')
    for (const row of nt.captured.snapshot) {
      assert.ok(row.url.includes('format=mp3'), `engaged row ${row.trackId} must request mp3, got: ${row.url}`)
      assert.ok(row.url.includes('maxBitRate=64'), `engaged row ${row.trackId} must cap at 64 kbps, got: ${row.url}`)
    }
  } finally {
    h.cleanup()
    resetState()
  }
})

// --- B. LDM-transition invalidation (pinned behavior) ----------------------
// Engaging LDM mid-session with mode 'lowData' invalidates already-built
// URLs: the native snapshot tail (engine-side auto-advance + lock-screen
// skips play it verbatim) and the web armed crossfade target (resolved at
// arm time). The transcodeKey edge (mode|format|bitrate|probe) never fires
// for an LDM flip, so the LDM edge owns this (scoped to 'lowData').

test('B1: engaging LDM re-syncs the native snapshot when transcodeMode is lowData', () => {
  resetState()
  const h = makeManager({ isNative: () => true })
  h.priv._initialized = true
  try {
    let syncs = 0
    ;(h.m as unknown as Record<string, unknown>)._scheduleNativeQueueSync = () => { syncs++ }
    // Node must not hit the real Capacitor plugin on settings fires.
    ;(h.m as unknown as Record<string, unknown>)._syncNativePreload = () => {}
    settings.set({ transcodeMode: 'lowData', transcodeFormat: 'mp3', transcodeBitrate: 64 })
    subscribeShared(h)
    const baseline = syncs

    settings.set({ transcodeMode: 'lowData', transcodeFormat: 'mp3', transcodeBitrate: 64, lowDataMode: true })

    assert.equal(syncs, baseline + 1, 'the LDM engage must re-sync the native tail once (armed raw URLs are stale)')
  } finally {
    h.cleanup()
    resetState()
  }
})

test('B2: engaging LDM re-arms the WEB crossfade target when transcodeMode is lowData', () => {
  resetState()
  const h = makeManager()
  h.priv._initialized = true
  try {
    let rearms = 0
    ;(h.m as unknown as Record<string, unknown>)._rearmCrossfadeTarget = () => { rearms++ }
    settings.set({ transcodeMode: 'lowData', transcodeFormat: 'mp3', transcodeBitrate: 64 })
    subscribeShared(h)
    const baseline = rearms

    settings.set({ transcodeMode: 'lowData', transcodeFormat: 'mp3', transcodeBitrate: 64, lowDataMode: true })

    assert.equal(rearms, baseline + 1, 'the LDM engage must re-arm once (the armed URL was resolved raw)')
  } finally {
    h.cleanup()
    resetState()
  }
})

test('B3: engaging LDM via the CELLULAR edge re-syncs the native snapshot (the drive-into-5G path)', () => {
  resetState()
  const h = makeManager({ isNative: () => true })
  h.priv._initialized = true
  try {
    let syncs = 0
    ;(h.m as unknown as Record<string, unknown>)._scheduleNativeQueueSync = () => { syncs++ }
    ;(h.m as unknown as Record<string, unknown>)._syncNativePreload = () => {}
    settings.set({ transcodeMode: 'lowData', transcodeFormat: 'mp3', transcodeBitrate: 64, lowDataOnCellular: true })
    __setNetworkStatus({ known: true, isCellular: false })
    subscribeShared(h)
    const baseline = syncs

    __setNetworkStatus({ known: true, isCellular: true })

    assert.equal(get(effectiveLowData), true, 'precondition: the cellular edge engaged the gate')
    assert.equal(syncs, baseline + 1, 'the cellular engage must re-sync the native tail once')
  } finally {
    h.cleanup()
    resetState()
  }
})

// --- B controls (expected PASS before AND after the fix) ------------------
// The invalidation must be scoped to mode 'lowData': 'off' has no params to
// refresh and 'always' URLs are identical either side of the flip —
// re-syncing there would be pointless bridge churn.

test('B4 control: LDM engage does NOT re-sync when transcodeMode is off', () => {
  resetState()
  const h = makeManager({ isNative: () => true })
  h.priv._initialized = true
  try {
    let syncs = 0
    ;(h.m as unknown as Record<string, unknown>)._scheduleNativeQueueSync = () => { syncs++ }
    ;(h.m as unknown as Record<string, unknown>)._syncNativePreload = () => {}
    settings.set({ transcodeMode: 'off' })
    subscribeShared(h)
    const baseline = syncs

    settings.set({ transcodeMode: 'off', lowDataMode: true })

    assert.equal(syncs, baseline, 'nothing transcoded changes — no re-sync')
  } finally {
    h.cleanup()
    resetState()
  }
})

test('B5 control: LDM engage does NOT re-sync when transcodeMode is always (URLs invariant)', () => {
  resetState()
  const h = makeManager({ isNative: () => true })
  h.priv._initialized = true
  try {
    let syncs = 0
    ;(h.m as unknown as Record<string, unknown>)._scheduleNativeQueueSync = () => { syncs++ }
    ;(h.m as unknown as Record<string, unknown>)._syncNativePreload = () => {}
    settings.set({ transcodeMode: 'always', transcodeFormat: 'mp3', transcodeBitrate: 64 })
    subscribeShared(h)
    const baseline = syncs

    settings.set({ transcodeMode: 'always', transcodeFormat: 'mp3', transcodeBitrate: 64, lowDataMode: true })

    assert.equal(syncs, baseline, 'always-URLs ignore the gate — no re-sync')
  } finally {
    h.cleanup()
    resetState()
  }
})
