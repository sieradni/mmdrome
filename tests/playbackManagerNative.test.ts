// Manager-level glue tests for the native transport wiring (TODO 1.0 step 4d).
// The PlaybackManager's injectable deps (queueManager/sleepTimerManager/
// nativeTransport/isNative) are replaced with fakes so the engage routing, the
// A4 decideAdvance chain, and the retry validity guard can be exercised in Node
// — no DOM, no Dexie, no Capacitor. `isNative: () => true` forces the native
// branch through `_loadAndPlay` (the real dispatcher is Capacitor-gated).

import './stub-audio-worklet-node'
import { test } from 'node:test'

// The wrap/re-anchor paths persist the queue via setActiveQueueIndex/advanceTo
// → saveQueue → Dexie. There's no IndexedDB in Node; the persistence isn't
// under test here, so the table write is stubbed (otherwise the rejected open
// lands as an unhandledRejection and fails the suite).
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
import { queueManager } from '../src/lib/queueManager'
import { sleepTimerManager } from '../src/lib/sleepTimer'
import { get } from 'svelte/store'
import { setCachedConfig } from '../src/lib/navidromeApi'
import type { NativeTransport } from '../src/lib/playbackCore/nativeTransport'
import type { TransportEndedEvent } from '../src/lib/playbackCore/types'

// --- fakes -----------------------------------------------------------------

class FakeNativeTransport {
  engagedValue = false
  engageOk = true
  /** When true, engage() returns a deferred promise resolved via engageResolvers. */
  manualEngage = false
  engageResolvers: Array<(ok: boolean) => void> = []
  calls: string[] = []
  lastEngage: { snapshot: unknown[]; activeIndex: number; loopMode: string } | null = null
  getStateResult: { trackId: string; position: number; playing: boolean } | null = null
  getStateError = false
  adopted: string[] = []

  get engaged(): boolean {
    return this.engagedValue
  }

  async engage(snapshot: unknown[], activeIndex: number, loopMode: string): Promise<boolean> {
    this.calls.push(`engage:${activeIndex}:${loopMode}`)
    this.lastEngage = { snapshot, activeIndex, loopMode }
    if (this.manualEngage) {
      return new Promise<boolean>((resolve) => {
        this.engageResolvers.push(resolve)
      })
    }
    return this.engageOk
  }

  scheduleSync(): void {
    this.calls.push('scheduleSync')
  }

  play(): Promise<void> {
    this.calls.push('play')
    return Promise.resolve()
  }

  pause(): Promise<void> {
    this.calls.push('pause')
    return Promise.resolve()
  }

  seek(position: number): Promise<void> {
    this.calls.push(`seek:${position}`)
    return Promise.resolve()
  }

  setLoopMode(mode: string): Promise<void> {
    this.calls.push(`setLoopMode:${mode}`)
    return Promise.resolve()
  }

  disengage(): void {
    this.calls.push('disengage')
  }

  async destroy(): Promise<void> {
    this.calls.push('destroy')
  }

  async init(): Promise<void> {
    this.calls.push('init')
  }

  async getState(): Promise<{ trackId: string; position: number; playing: boolean } | null> {
    if (this.getStateError) throw new Error('getState rejected')
    return this.getStateResult
  }

  adopt(trackId: string): void {
    this.adopted.push(trackId)
    this.engagedValue = true
  }

  onTrackChanged: ((trackId: string) => void) | null = null
  onTrackEnded: ((event: TransportEndedEvent) => void) | null = null
  onRetry: ((trackId: string) => void) | null = null
  onPlaybackState: ((state: 'playing' | 'paused') => void) | null = null
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

  advanceTo(index: number): void {
    this.calls.push(`advanceTo:${index}`)
    queue.update((q) => ({ ...q, activeIndex: index }))
  }

  advanceQueue(): Track | null {
    this.calls.push('advanceQueue')
    queue.update((q) => ({ ...q, activeIndex: Math.min(q.activeIndex + 1, this.combined.length - 1) }))
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
  calls: string[] = []

  async rearmAfterSnapshot(): Promise<void> {
    this.calls.push('rearmAfterSnapshot')
  }

  isEndOfTrackArmed(): boolean {
    return false
  }

  consumePendingStop(): boolean {
    return false
  }

  clearPendingStop(): void {
    this.calls.push('clearPendingStop')
  }

  parkAtEnd(): void {}
}

// --- harness ---------------------------------------------------------------

type PrivatePM = {
  _nativeLoadPlay(track: Track): Promise<void>
  _onNativeTrackEnded(fromError?: boolean): Promise<void>
  _onNativeRetry(trackId: string): Promise<void>
  _onNativeTrackChanged(trackId: string): void
  _reconcileNativeReload(): Promise<void>
}

function makeHarness(opts: { engageOk?: boolean; engaged?: boolean } = {}) {
  const qm = new FakeQueueManager()
  const stm = new FakeSleepTimer()
  const nt = new FakeNativeTransport()
  nt.engageOk = opts.engageOk ?? true
  nt.engagedValue = opts.engaged ?? false
  const m = new PlaybackManager({
    queueManager: qm as unknown as typeof queueManager,
    sleepTimerManager: stm as unknown as typeof sleepTimerManager,
    nativeTransport: nt as unknown as NativeTransport,
    isNative: () => true,
  }) as unknown as PrivatePM
  return { qm, stm, nt, m }
}

const t1: Track = { trackId: 't1', title: 'T1', artist: 'A', album: 'AL', duration: 300, fileType: 'mp3' }
const t2: Track = { trackId: 't2', title: 'T2', artist: 'A', album: 'AL', duration: 300, fileType: 'mp3' }

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

test('_nativeLoadPlay success: engages the snapshot and promotes', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1'], [t1], 0)
  await h.m._nativeLoadPlay(t1)

  assert.equal(get(currentTrack)?.trackId, 't1')
  assert.equal(get(playbackState), 'playing')
  assert.equal(get(currentTime), 0)
  assert.equal(h.nt.lastEngage?.activeIndex, 0)
  assert.equal(h.nt.lastEngage?.loopMode, 'none')
  assert.equal(h.nt.lastEngage?.snapshot.length, 1)
  assert.ok(h.qm.calls.includes('promoteActiveTrack'))
  assert.ok(h.qm.calls.includes('replenishAutoQueue'))
  assert.ok(h.stm.calls.includes('rearmAfterSnapshot'))
})

test('_nativeLoadPlay failure: reports stopped and never promotes', async () => {
  const h = makeHarness({ engageOk: false })
  resetStores()
  seed(h, ['t1'], [t1], 0)
  await h.m._nativeLoadPlay(t1)

  assert.equal(get(currentTrack), null)
  assert.equal(get(playbackState), 'stopped')
  assert.ok(!h.qm.calls.includes('promoteActiveTrack'))
  assert.ok(!h.stm.calls.includes('rearmAfterSnapshot'))
})

test('_onNativeTrackEnded advances to the next row through decideAdvance', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1', 't2'], [t1, t2], 0)
  h.qm.nextTrack = t2
  await h.m._onNativeTrackEnded(false)

  assert.ok(h.qm.calls.includes('advanceQueue'))
  assert.equal(h.nt.lastEngage?.activeIndex, 1)
  assert.equal(get(currentTrack)?.trackId, 't2')
  assert.equal(get(playbackState), 'playing')
})

test('_onNativeTrackEnded stops at the tail with no wrap (uniform A4 stop)', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1'], [t1], 0)
  h.qm.nextTrack = null
  await h.m._onNativeTrackEnded(false)

  assert.equal(get(playbackState), 'stopped')
  assert.equal(get(currentTrack), null)
  assert.ok(h.nt.calls.includes('disengage'))
})

test('_onNativeTrackEnded wraps to the first user row under loop-all', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1', 't2'], [t1, t2], 1)
  loopMode.set('all')
  await h.m._onNativeTrackEnded(false)

  assert.equal(get(queue).activeIndex, 0)
  assert.equal(get(currentTrack)?.trackId, 't1')
  assert.equal(get(playbackState), 'playing')
})

test('_onNativeTrackEnded restarts the current track under loop-one', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1'], [t1], 0)
  loopMode.set('one')
  setCurrentTrack(t1)
  await h.m._onNativeTrackEnded(false)

  assert.equal(get(currentTrack)?.trackId, 't1')
  assert.equal(get(playbackState), 'playing')
  assert.ok(h.nt.calls.some((c) => c.startsWith('engage:')))
})

test('_onNativeRetry reloads the matching current track', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1'], [t1], 0)
  setCurrentTrack(t1)
  await h.m._onNativeRetry('t1')

  assert.equal(h.nt.lastEngage?.activeIndex, 0)
  assert.equal(get(currentTrack)?.trackId, 't1')
})

test('_onNativeRetry ignores a stale track id (track-keyed validity)', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1'], [t1], 0)
  setCurrentTrack(t1)
  await h.m._onNativeRetry('t2')

  assert.equal(h.nt.lastEngage, null)
})

test('_onNativeTrackChanged re-anchors the active index and promotes', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1', 't2'], [t1, t2], 0)
  await h.m._onNativeTrackChanged('t2')

  assert.equal(get(queue).activeIndex, 1)
  assert.equal(get(currentTrack)?.trackId, 't2')
  assert.ok(h.qm.calls.includes('promoteActiveTrack'))
})

test('_onNativeTrackChanged ignores an unknown track', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1'], [t1], 0)
  await h.m._onNativeTrackChanged('missing')

  assert.equal(get(currentTrack), null)
  assert.ok(!h.qm.calls.includes('promoteActiveTrack'))
})

test('_onNativeTrackChanged re-adopts a track that left the combined queue', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1'], [t1], 0)
  // t2 is findable in the library but not in the combined queue.
  h.qm.tracks = [t1, t2]
  await h.m._onNativeTrackChanged('t2')

  assert.equal(get(currentTrack)?.trackId, 't2')
  assert.equal(get(queue).userQueue.length, 2)
  assert.equal(get(queue).userQueue[1], 't2')
})

test('_nativeLoadPlay skips post-work when a newer load superseded it', async () => {
  const h = makeHarness()
  h.nt.manualEngage = true
  resetStores()
  seed(h, ['t1'], [t1], 0)

  const p = h.m._nativeLoadPlay(t1)
  // A newer load moved the current track while t1's engage was in flight.
  setCurrentTrack(t2)
  h.nt.engageResolvers[0](true)
  await p

  // The stale success must not promote/rearm/play — it no longer owns the slot.
  assert.ok(!h.qm.calls.includes('promoteActiveTrack'))
  assert.ok(!h.stm.calls.includes('rearmAfterSnapshot'))
  assert.equal(get(playbackState), 'stopped')
  assert.equal(get(currentTrack)?.trackId, 't2')
})

test('_reconcileNativeReload resyncs a known playing track', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1', 't2'], [t1, t2], 0)
  h.nt.getStateResult = { trackId: 't2', position: 77, playing: true }
  await h.m._reconcileNativeReload()

  assert.equal(get(currentTrack)?.trackId, 't2')
  assert.equal(get(playbackState), 'playing')
  assert.equal(get(currentTime), 77)
  assert.equal(get(queue).activeIndex, 1)
  assert.deepEqual(h.nt.adopted, ['t2'])
})

test('_reconcileNativeReload re-adopts a track that left the combined queue', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1'], [t1, t2], 0)
  h.nt.getStateResult = { trackId: 't2', position: 5, playing: true }
  await h.m._reconcileNativeReload()

  assert.equal(get(currentTrack)?.trackId, 't2')
  assert.equal(get(queue).userQueue.length, 2)
  assert.equal(get(queue).userQueue[1], 't2')
  assert.deepEqual(h.nt.adopted, ['t2'])
})

test('_reconcileNativeReload is a no-op when the engine is idle', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1'], [t1], 0)
  h.nt.getStateResult = { trackId: '', position: 0, playing: false }
  await h.m._reconcileNativeReload()

  assert.equal(get(currentTrack), null)
  assert.equal(get(playbackState), 'stopped')
  assert.deepEqual(h.nt.adopted, [])
})

test('_reconcileNativeReload stops on an unknown trackId', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1'], [t1], 0)
  h.nt.getStateResult = { trackId: 'foreign', position: 0, playing: true }
  await h.m._reconcileNativeReload()

  assert.equal(get(currentTrack), null)
  assert.equal(get(playbackState), 'stopped')
  // The engine is audibly playing the unknown track: it must be paused, not
  // merely disengaged (disengage stops the poll but not the audio).
  assert.ok(h.nt.calls.includes('pause'))
  assert.ok(h.nt.calls.includes('disengage'))
  assert.ok(h.nt.calls.indexOf('pause') < h.nt.calls.indexOf('disengage'))
})

test('_reconcileNativeReload skips when getState rejects', async () => {
  const h = makeHarness()
  resetStores()
  seed(h, ['t1'], [t1], 0)
  h.nt.getStateError = true
  await h.m._reconcileNativeReload()

  assert.equal(get(currentTrack), null)
  assert.equal(get(playbackState), 'stopped')
  assert.deepEqual(h.nt.adopted, [])
})
