import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebTransport, type WebTransportEngine, type WebTransportTimers } from '../src/lib/playbackCore/webTransport'
import type { TransportEndedEvent } from '../src/lib/playbackCore/types'

// ── fakes ──────────────────────────────────────────────────────────────────

class FakeEl {
  listeners = new Map<string, Array<(e: unknown) => void>>()
  ended = false
  paused = true
  src = ''
  currentTime = 0
  private _playRejections = 0
  private _playCalls = 0

  set rejectPlays(n: number) { this._playRejections = n }
  get playCalls(): number { return this._playCalls }

  async play(): Promise<void> {
    this._playCalls++
    if (this._playCalls <= this._playRejections) {
      this.paused = true
      throw new Error('play rejected')
    }
    this.paused = false
  }

  pause(): void { this.paused = true }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }

  removeEventListener(type: string, fn: (e: unknown) => void): void {
    const arr = this.listeners.get(type) ?? []
    this.listeners.set(type, arr.filter((f) => f !== fn))
  }

  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ target: this })
  }
}

class FakeEngine {
  a = new FakeEl()
  b = new FakeEl()
  activeElement: FakeEl = this.a
  playbackElement: FakeEl = this.a
  onTrackEnd: (() => void) | null = null
  nextTrackUrl: string | null = null
  nextTrackLinear: number | null = null
  reapplyCalls = 0
  rgCalls: Array<[number | null, number | null]> = []

  setNextTrack(url: string | null, replayGainLinear?: number): void {
    this.nextTrackUrl = url
    this.nextTrackLinear = replayGainLinear ?? null
  }

  cancelNextTrack(): void { this.setNextTrack(null) }
  reapplyEffects(): void { this.reapplyCalls++ }
  applyReplayGain(trackGainDb?: number | null, albumGainDb?: number | null): void {
    this.rgCalls.push([trackGainDb ?? null, albumGainDb ?? null])
  }
}

class FakeTimers implements WebTransportTimers {
  scheduled: Array<{ delayMs: number; fn: () => void; cancelled: boolean }> = []
  sleepCalls = 0

  sleep(_ms: number): Promise<void> {
    this.sleepCalls++
    return Promise.resolve()
  }

  schedule(delayMs: number, fn: () => void): () => void {
    const entry = { delayMs, fn, cancelled: false }
    this.scheduled.push(entry)
    return () => { entry.cancelled = true }
  }

  fire(index: number): void {
    const entry = this.scheduled[index]
    if (entry && !entry.cancelled) entry.fn()
  }

  fireAll(): void {
    for (const entry of this.scheduled) if (!entry.cancelled) entry.fn()
  }
}

function makeTransport(): { t: WebTransport; engine: FakeEngine; timers: FakeTimers; ended: TransportEndedEvent[]; retried: string[]; states: string[] } {
  const engine = new FakeEngine()
  const timers = new FakeTimers()
  const t = new WebTransport(engine as unknown as WebTransportEngine, timers)
  const ended: TransportEndedEvent[] = []
  const retried: string[] = []
  const states: string[] = []
  t.onTrackEnded = (e) => ended.push(e)
  t.onRetry = (trackId) => retried.push(trackId)
  t.onPlaybackState = (s) => states.push(s)
  return { t, engine, timers, ended, retried, states }
}

// ── init ───────────────────────────────────────────────────────────────────

test('init wires the engine crossfade callback and element listeners', async () => {
  const { t, engine } = makeTransport()
  await t.init()
  assert.equal(typeof engine.onTrackEnd, 'function')
  assert.equal(engine.a.listeners.get('ended')?.length, 1)
  assert.equal(engine.b.listeners.get('error')?.length, 1)
})

// ── crossfade end ──────────────────────────────────────────────────────────

test('crossfade end → RG refresh with the armed fields + ended event with the target (1.10-3)', async () => {
  const { t, engine, ended } = makeTransport()
  await t.init()
  t.prepareNext('t2', 'url2', { linearGain: 0.5, trackGainDb: -6, albumGainDb: -3 })
  assert.equal(engine.nextTrackLinear, 0.5)
  engine.onTrackEnd?.() // the standby play() rejection is swallowed engine-side; the switch completes anyway
  assert.deepEqual(ended, [{ kind: 'crossfade', targetId: 't2' }])
  assert.deepEqual(engine.rgCalls, [[-6, -3]])
  // the arm is consumed
  engine.onTrackEnd?.()
  assert.deepEqual(engine.rgCalls, [[-6, -3], [null, null]])
})

test('mid-fade cancel → crossfade event with null target, refresh with null fields', async () => {
  const { t, engine, ended } = makeTransport()
  await t.init()
  t.prepareNext('t2', 'url2', { linearGain: 0.5, trackGainDb: -6, albumGainDb: -3 })
  t.cancelNext()
  assert.equal(engine.nextTrackUrl, null)
  engine.onTrackEnd?.()
  assert.deepEqual(ended, [{ kind: 'crossfade', targetId: null }])
  assert.deepEqual(engine.rgCalls, [[null, null]])
})

test('prepareNext(null, null) disarms without an arm being consumed', async () => {
  const { t, engine, ended } = makeTransport()
  await t.init()
  t.prepareNext(null, null)
  engine.onTrackEnd?.()
  assert.deepEqual(ended, [{ kind: 'crossfade', targetId: null }])
  assert.equal(engine.nextTrackUrl, null)
})

// ── element events ─────────────────────────────────────────────────────────

test('natural ended on the active element → natural event, retry cancelled', async () => {
  const { t, engine, ended } = makeTransport()
  await t.init()
  await t.playLoaded({ trackId: 't1' })
  engine.a.dispatch('error')
  engine.a.dispatch('ended')
  assert.deepEqual(ended, [{ kind: 'natural', fromError: false }])
  assert.equal(engine.a.paused, false)
})

test('ended on the standby element is ignored', async () => {
  const { t, engine, ended } = makeTransport()
  await t.init()
  await t.playLoaded({ trackId: 't1' })
  engine.activeElement = engine.b
  engine.a.dispatch('ended')
  assert.deepEqual(ended, [])
})

test('pause event: active element → paused; ended element and standby → nothing', async () => {
  const { t, engine, states } = makeTransport()
  await t.init()
  engine.a.dispatch('pause')
  assert.deepEqual(states, ['paused'])
  engine.a.ended = true
  engine.a.dispatch('pause')
  engine.activeElement = engine.b
  engine.a.dispatch('pause')
  assert.deepEqual(states, ['paused'])
})

test('play/waiting/playing events map to playback states', async () => {
  const { t, engine, states } = makeTransport()
  await t.init()
  engine.a.dispatch('play')
  engine.a.dispatch('waiting')
  engine.a.dispatch('playing')
  assert.deepEqual(states, ['playing', 'buffering', 'playing'])
})

// ── retry machine (RetryPolicy-owned, per its documented contract) ─────────

test('stream error schedules web backoff 1s/2s/4s; the 4th error gives up via natural+fromError', async () => {
  const { t, engine, timers, ended } = makeTransport()
  await t.init()
  await t.playLoaded({ trackId: 't1' })
  for (let i = 0; i < 3; i++) engine.a.dispatch('error')
  assert.deepEqual(ended, [])
  assert.deepEqual(timers.scheduled.map((e) => e.delayMs), [1000, 2000, 4000])
  engine.a.dispatch('error')
  assert.deepEqual(ended, [{ kind: 'natural', fromError: true }])
})

test('retry timer fire → onRetry with the last-played track', async () => {
  const { t, engine, timers, retried, ended } = makeTransport()
  await t.init()
  await t.playLoaded({ trackId: 't1' })
  engine.a.dispatch('error')
  timers.fire(0)
  assert.deepEqual(retried, ['t1'])
  assert.deepEqual(ended, [])
})

test('error on an element when nothing was loaded → no retry machine', async () => {
  const { t, engine, timers } = makeTransport()
  await t.init()
  engine.a.dispatch('error')
  assert.deepEqual(timers.scheduled, [])
})

test('a new load cancels a pending retry (stale timer never fires)', async () => {
  const { t, engine, timers, retried } = makeTransport()
  await t.init()
  await t.playLoaded({ trackId: 't1' })
  engine.a.dispatch('error')
  await t.playLoaded({ trackId: 't2' })
  timers.fireAll()
  assert.deepEqual(retried, [])
})

test('crossfade switch cancels a pending retry for the old track', async () => {
  const { t, engine, timers, retried } = makeTransport()
  await t.init()
  await t.playLoaded({ trackId: 't1' })
  engine.a.dispatch('error')
  t.prepareNext('t2', 'url2', undefined)
  engine.onTrackEnd?.()
  timers.fireAll()
  assert.deepEqual(retried, [])
})

// ── playLoaded ─────────────────────────────────────────────────────────────

test('playLoaded success: plays, re-applies effects + RG, resets retry, anchors the track', async () => {
  const { t, engine } = makeTransport()
  await t.init()
  const ok = await t.playLoaded({ trackId: 't1', replayGain: -6, albumReplayGain: -3 })
  assert.equal(ok, true)
  assert.equal(engine.a.paused, false)
  assert.equal(engine.reapplyCalls, 1)
  assert.deepEqual(engine.rgCalls, [[-6, -3]])
  // retry was reset: a subsequent error is attempt 1 again
  assert.equal(engine.a.playCalls, 1)
})

test('playLoaded survives autoplay rejections (1s/2s backoff), succeeds on the 3rd try', async () => {
  const { t, engine, timers } = makeTransport()
  await t.init()
  engine.a.rejectPlays = 2
  const ok = await t.playLoaded({ trackId: 't1' })
  assert.equal(ok, true)
  assert.equal(engine.a.playCalls, 3)
  assert.equal(timers.sleepCalls, 2)
})

test('playLoaded gives up after 3 rejections → false', async () => {
  const { t, engine } = makeTransport()
  await t.init()
  engine.a.rejectPlays = 3
  const ok = await t.playLoaded({ trackId: 't1' })
  assert.equal(ok, false)
})

// ── destroy ────────────────────────────────────────────────────────────────

test('destroy unwires the engine, removes listeners, cancels the retry timer and the arm', async () => {
  const { t, engine, timers, retried } = makeTransport()
  await t.init()
  await t.playLoaded({ trackId: 't1' })
  engine.a.dispatch('error')
  t.prepareNext('t2', 'url2', { linearGain: 0.5, trackGainDb: -6, albumGainDb: -3 })
  t.destroy()
  assert.equal(engine.onTrackEnd, null)
  assert.equal(engine.a.listeners.get('ended')?.length ?? 0, 0)
  assert.equal(engine.nextTrackUrl, null)
  timers.fireAll()
  assert.deepEqual(retried, [])
})