// Rapid Next/Previous + loop-mode characterization (Phase 2A gate item 5,
// 2026-10-21). The transport-level skips and the natural-end matrix interact
// through the SAME active anchor, so this drives the real PlaybackManager
// (web path) with the real queueManager and a fake audio/transport layer.
//
// Rows covered by docs/QUEUE-INVARIANTS.md:
//   - two Next presses in one tick advance two rows (no lost update);
//   - Next at the tail never wraps — wrapping is a NATURAL-END decision;
//   - Previous at the first row restarts the track, and wraps only under
//     loop-all;
//   - Next then Previous in the same tick returns to the starting row;
//   - a natural end under loop-all wraps to user[0], under loop-none stops.

import './stub-audio-worklet-node'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { PlaybackManager } from '../src/lib/playbackManager'
import { queueManager } from '../src/lib/queueManager'
import { audioManager } from '../src/lib/audioManager'
import { sleepTimerManager } from '../src/lib/sleepTimer'
import { setCachedConfig } from '../src/lib/navidromeApi'
import type { WebTransport } from '../src/lib/playbackCore/webTransport'
import type { WebBgTransport } from '../src/lib/playbackCore/webBgTransport'
import {
  queue,
  library,
  currentTrack,
  currentTime,
  playbackState,
  loopMode,
  setCurrentTrack,
  setPlaybackState,
  sleepTimer,
  pendingAdvanceTrackId,
  type Track,
} from '../src/stores/appState'

// advance/promote/replenish persist through saveQueue → Dexie (F3 stub).
Object.getPrototypeOf(db.playQueue).put = (async () => undefined) as never

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
  markUserSeeked(): void {}
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
  async playLoaded(): Promise<{ started: boolean; errorName: string | null }> {
    this.calls.push('playLoaded')
    return { started: true, errorName: null }
  }
}

class FakeBgTransport {
  private readonly el: FakeEl
  constructor(el: FakeEl) {
    this.el = el
  }
  get engaged(): boolean {
    return false
  }
  get sessionElement(): HTMLAudioElement {
    return this.el as unknown as HTMLAudioElement
  }
  syncSource(): void {}
  init(): void {}
  teardown(): void {}
}

class FakeSleepTimer {
  isEndOfTrackArmed(): boolean {
    return false
  }
  consumePendingStop(): boolean {
    return false
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

class FakeEngine {
  setSpeed(): void {}
  setSnapTolerance(): void {}
  setPitchOctaves(): void {}
  setMasterVolume(): void {}
  setTapeMode(): void {}
  setCrossfade(): void {}
  setAudioMixing(): void {}
  setSeekEpochs(): void {}
}

// --- harness -------------------------------------------------------------

type PrivatePM = {
  next(): Promise<void>
  prev(): Promise<void>
  _onTrackEnded(fromError?: boolean): Promise<void>
}

function makeManager(): PrivatePM {
  const el = new FakeEl()
  return new PlaybackManager({
    audioManager: Object.assign(new FakeAudioManager(), { activeElement: el as unknown as HTMLAudioElement }) as unknown as typeof audioManager,
    engine: new FakeEngine() as never,
    queueManager,
    sleepTimerManager: new FakeSleepTimer() as unknown as typeof sleepTimerManager,
    webTransport: new FakeWebTransport() as unknown as WebTransport,
    bgTransport: new FakeBgTransport(el) as unknown as WebBgTransport,
    isNative: () => false,
  }) as unknown as PrivatePM
}

const track = (trackId: string): Track => ({
  trackId,
  title: trackId,
  artist: 'A',
  album: 'B',
  duration: 300,
  fileType: 'mp3',
})

const t1 = track('t1')

function reset(ids: string[] = ['t0', 't1', 't2']): void {
  library.set(ids.map(track))
  queue.set({ userQueue: ids, autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  setCurrentTrack(track(ids[0]))
  setPlaybackState('playing')
  currentTime.set(0)
  loopMode.set('none')
  sleepTimer.set({ active: false, mode: 'minutes', minutes: 30, endsAt: 0, remainingSeconds: 0 })
  setCachedConfig({ baseUrl: 'https://srv.example', username: 'u', password: 'p' })
}

function combined(): string[] {
  const q = get(queue)
  return [...q.userQueue, ...q.autoQueue]
}

// --- tests ---------------------------------------------------------------

test('two Next presses in the same tick skip TWO rows (D10 / G3)', async () => {
  reset()
  const m = makeManager()

  await Promise.all([m.next(), m.next()])

  // Press #1 advances the anchor 0→1 and starts the async load. Press #2 lands
  // while `currentTrack` still names t0 — the D10 pending fact records that the
  // anchor is AHEAD of the audio, so the mismatch is a transition, never an
  // active-row removal, and the second press advances again.
  assert.equal(get(queue).activeIndex, 2, 'one row per press')
  assert.equal(get(currentTrack)?.trackId, 't2', 'the last pressed row is the one that plays')
  assert.equal(combined()[get(queue).activeIndex], 't2')
})

test('two Next presses over duplicate copies land on the second COPY, then past it', async () => {
  // [A, A, B]: the first press moves to the sibling copy of the SAME song, the
  // second must leave it — id equality may never short-circuit the advance.
  reset(['a0', 'a0', 'b0'])
  queue.set({ userQueue: ['a0', 'a0', 'b0'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  setCurrentTrack(track('a0'))
  const m = makeManager()

  await m.next()
  assert.equal(get(queue).activeIndex, 1, 'the sibling occurrence, addressed by ROW')
  assert.equal(combined()[1], 'a0')

  await m.next()
  assert.equal(get(queue).activeIndex, 2)
  assert.equal(get(currentTrack)?.trackId, 'b0')
})

test('a stale pending advance never masks an active-row removal (positional rule survives)', async () => {
  reset()
  const m = makeManager()

  // The moment after an advance: the anchor names t1 with its load pending —
  // then the user removes that row before it plays. The anchor keeps its index
  // (t2 slides into it), so the pending fact no longer matches the anchor and
  // the positional removal rule decides: the row AT the anchor is next.
  pendingAdvanceTrackId.set('t1')
  const removed = queueManager.removeFromUserQueue(1)
  assert.equal(removed, 't1')

  await m.next()

  assert.equal(get(queue).activeIndex, 1)
  assert.equal(combined()[1], 't2', 'the row AT the anchor is the next playable one')
  assert.equal(get(currentTrack)?.trackId, 't2')
})

// D8 tail rules (step 5). With the auto queue ON and anything matching, D6
// keeps the tail non-empty, so these are the auto-off / nothing-matches end.
test('Next at the queue tail wraps to the user head under loop-all (D8)', async () => {
  reset()
  queue.set({ userQueue: ['t0'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  loopMode.set('all')
  const m = makeManager()

  await m.next()

  assert.equal(get(currentTrack)?.trackId, 't0', 'repeat-all replays the user queue')
  assert.equal(get(queue).activeIndex, 0)
  assert.equal(get(playbackState), 'playing', 'a manual Next never stops playback under loop-all')
})

test('Next at the queue tail STOPS under loop-none (D8)', async () => {
  reset()
  queue.set({ userQueue: ['t0'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  loopMode.set('none')
  const m = makeManager()

  await m.next()

  assert.equal(get(playbackState), 'stopped', 'the declared end of the queue')
  assert.equal(get(currentTrack), null)
})

test('Next at the queue tail restarts the song under loop-one (D8)', async () => {
  reset()
  queue.set({ userQueue: ['t0'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  loopMode.set('one')
  const m = makeManager()

  await m.next()

  assert.equal(get(currentTrack)?.trackId, 't0', 'loop-one keeps the same song')
  assert.equal(get(queue).activeIndex, 0)
  assert.deepEqual(get(queue).recentTrackIds, [], 'a restart is not a transition')
})

test('Previous at the first row is a NO-OP in every loop mode (D8)', async () => {
  // The as-built split (restart under none, wrap to the last row under all)
  // made one press mean opposite things depending on a setting the user is not
  // looking at. The design chose inert; the >3 s restart is the only restart.
  for (const mode of ['none', 'all', 'one'] as const) {
    reset()
    loopMode.set(mode)
    const m = makeManager()

    await m.prev()

    const q = get(queue)
    assert.equal(q.activeIndex, 0, `no queue move under loop-${mode}`)
    assert.equal(get(currentTrack)?.trackId, 't0')
    assert.deepEqual(q.userQueue, ['t0', 't1', 't2'])
    assert.deepEqual(q.recentTrackIds, [], 'nothing was left behind')
  }
})

test('Previous >3 s into the first row restarts it instead of no-opping (D8)', async () => {
  reset()
  currentTime.set(10)
  const m = makeManager()

  await m.prev()

  assert.equal(get(currentTrack)?.trackId, 't0', 'the playing row is unchanged')
  assert.equal(get(queue).activeIndex, 0)
})

test('Next then Previous in the same tick returns to the starting row', async () => {
  reset()
  const m = makeManager()

  await Promise.all([m.next(), m.prev()])

  const q = get(queue)
  assert.equal(q.activeIndex, 0, 'the two presses are applied in call order, not replayed from a stale snapshot')
  assert.equal(get(currentTrack)?.trackId, 't0')
  assert.equal(combined()[q.activeIndex], 't0')
  // Both rows were LEFT in the process, so both cooled down; the starting row
  // is newest (it was left most recently, by the Previous press).
  assert.deepEqual(q.recentTrackIds, ['t0', 't1'])
})

test('a natural end under loop-all wraps to user[0]; under loop-none at the tail it stops', async () => {
  reset()
  loopMode.set('all')
  queue.set({ userQueue: ['t0', 't1'], autoQueue: [], recentTrackIds: [], activeIndex: 1 })
  setCurrentTrack(t1)
  const m = makeManager()

  await m._onTrackEnded()

  assert.equal(get(currentTrack)?.trackId, 't0')
  assert.equal(get(queue).activeIndex, 0, 'wrap re-anchors to the user head')
  assert.equal(get(playbackState), 'playing')

  // Same position, loop off: the honest stop, never a phantom row.
  reset()
  loopMode.set('none')
  queue.set({ userQueue: ['t0', 't1'], autoQueue: [], recentTrackIds: [], activeIndex: 1 })
  setCurrentTrack(t1)
  await m._onTrackEnded()
  assert.equal(get(currentTrack), null)
  assert.equal(get(playbackState), 'stopped')
})
