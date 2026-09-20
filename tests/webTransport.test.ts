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
  readyState = 0
  /** Metadata duration (the truncation-observe gate's input; NaN = unknown). */
  duration = NaN
  /** MediaError dict stand-in (null = healthy). */
  error: { code: number; message: string } | null = null
  private _bufferedEnd = 0
  /** Simulated buffered extent; elProgress reads it via the buffered shim. */
  set bufferedEnd(v: number) { this._bufferedEnd = v }
  get buffered(): { length: number; end: (i: number) => number } {
    return { length: this._bufferedEnd > 0 ? 1 : 0, end: () => this._bufferedEnd }
  }
  private _playRejections = 0
  private _playCalls = 0
  rejectErrorName = 'Error'
  /** When true, play() returns a promise that NEVER settles on its own —
   *  the pending-forever shape the settle watch exists for. */
  hangPlays = false
  private _pendingResolvers: Array<() => void> = []

  set rejectPlays(n: number) { this._playRejections = n }
  get playCalls(): number { return this._playCalls }

  async play(): Promise<void> {
    this._playCalls++
    if (this._playCalls <= this._playRejections) {
      this.paused = true
      const err = new Error('play rejected')
      err.name = this.rejectErrorName
      throw err
    }
    if (this.hangPlays) {
      this.paused = true
      return new Promise((resolve) => { this._pendingResolvers.push(resolve) })
    }
    this.paused = false
  }

  /** Resolves every hung play() (the "device recovered, play() started"
   *  late-settle case the watch must not break). */
  resolveHangs(): void {
    this.paused = false
    for (const r of this._pendingResolvers) r()
    this._pendingResolvers = []
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
  nextTrackDuration: number | null | undefined = undefined
  reapplyCalls = 0
  rgCalls: Array<[number | null, number | null]> = []

  setNextTrack(url: string | null, replayGainLinear?: number, nextDurationSeconds?: number): void {
    this.nextTrackUrl = url
    this.nextTrackLinear = replayGainLinear ?? null
    this.nextTrackDuration = nextDurationSeconds
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

test('prepareNext forwards the target duration for the engine nextTooShort gate', async () => {
  const { t, engine } = makeTransport()
  await t.init()
  t.prepareNext('t2', 'url2', undefined, 240)
  assert.equal(engine.nextTrackDuration, 240)
  t.prepareNext('t3', 'url3')
  assert.equal(engine.nextTrackDuration, undefined)
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
  // Pending timers only — the settled play()'s CANCELLED settle-watch entry
  // stays in the log by design (the fake never mutates history).
  const pendingMs = () => timers.scheduled.filter((e) => !e.cancelled).map((e) => e.delayMs)
  assert.deepEqual(pendingMs(), [1000, 2000, 4000])
  engine.a.dispatch('error')
  assert.deepEqual(ended, [{ kind: 'natural', fromError: true }])
})

test('retry timer fire → onRetry with the last-played track', async () => {
  const { t, engine, timers, retried, ended } = makeTransport()
  await t.init()
  await t.playLoaded({ trackId: 't1' })
  engine.a.dispatch('error')
  const pending = timers.scheduled.filter((e) => !e.cancelled)
  pending[0].fn()
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
  const res = await t.playLoaded({ trackId: 't1', replayGain: -6, albumReplayGain: -3 })
  assert.deepEqual(res, { started: true, errorName: null })
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
  const res = await t.playLoaded({ trackId: 't1' })
  assert.deepEqual(res, { started: true, errorName: null })
  assert.equal(engine.a.playCalls, 3)
  assert.equal(timers.sleepCalls, 2)
})

test('playLoaded gives up after 3 rejections → not-started with the last error name', async () => {
  const { t, engine } = makeTransport()
  await t.init()
  engine.a.rejectPlays = 3
  const res = await t.playLoaded({ trackId: 't1' })
  assert.deepEqual(res, { started: false, errorName: 'Error' })
})

test('playLoaded reports the rejection name the manager routes on (e.g. NotSupportedError)', async () => {
  const { t, engine } = makeTransport()
  await t.init()
  engine.a.rejectPlays = 3
  engine.a.rejectErrorName = 'NotSupportedError'
  const res = await t.playLoaded({ trackId: 't1' })
  assert.deepEqual(res, { started: false, errorName: 'NotSupportedError' })
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Fire the NEWEST pending timer: each watch window arms its successor, and
 *  fired entries stay non-cancelled in the log — firing the first match would
 *  re-run STALE closures and corrupt the sequence (real timers can't). */
function fireOne(timers: FakeTimers): void {
  let idx = -1
  for (let i = timers.scheduled.length - 1; i >= 0; i--) {
    if (!timers.scheduled[i].cancelled) { idx = i; break }
  }
  if (idx >= 0) timers.fire(idx)
}

test('playLoaded bounds a pending-forever play(): consecutive no-progress watch windows → not-started (the CI stall shape)', async () => {
  const { t, engine, timers } = makeTransport()
  await t.init()
  engine.a.hangPlays = true
  const pending = t.playLoaded({ trackId: 't1' })
  // Per attempt: TWO consecutive no-progress windows declare the stall (a
  // single window could be a scheduler hiccup). The rejection rides the SAME
  // 1s/2s backoff as a real rejection and play() is re-issued.
  for (let i = 0; i < 3; i++) {
    await flush(); fireOne(timers); await flush()
    fireOne(timers); await flush()
  }
  const res = await pending
  assert.deepEqual(res, { started: false, errorName: 'PlaySettleTimeout' })
  assert.equal(engine.a.playCalls, 3)
})

test('playLoaded never calls a buffering element stalled: progress resets the stall counter, late settle still plays', async () => {
  const { t, engine, timers } = makeTransport()
  await t.init()
  engine.a.hangPlays = true
  const pending = t.playLoaded({ trackId: 't1' })
  await flush()
  fireOne(timers) // window 1: no progress yet → stalledWindows = 1
  await flush()
  engine.a.bufferedEnd = 0.5 // bytes arrived — the element is working
  fireOne(timers) // window 2: progress → counter reset, watch re-armed
  await flush()
  engine.a.resolveHangs() // the starved start completes
  const res = await pending
  assert.deepEqual(res, { started: true, errorName: null })
  assert.equal(engine.a.paused, false)
  assert.equal(engine.a.playCalls, 1) // never re-issued — healthy-slow
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
// ── observability pins (2026-09-20): the transport's decisions land in the
// debugLog ring so a WEB dump verifies the same assumptions a native one
// does. The ring is module state — snapshot/drain around each test.

test('element error records the MediaError dict + retry verdict in the ring', async () => {
  const { jsDebugEventsSnapshot, clearJsDebugEvents } = await import('../src/lib/debugLog')
  clearJsDebugEvents()
  const { t, engine, timers, retried } = makeTransport()
  await t.init()
  await t.playLoaded({ trackId: 't1' })
  engine.a.error = { code: 2, message: 'network stall' }
  engine.a.dispatch('error')
  const events = jsDebugEventsSnapshot()
  const danger = events.filter((e) => e.level === 'danger')
  assert.ok(danger.some((e) => e.msg.includes('MEDIA_ERR_NETWORK') && e.msg.includes('network stall')), JSON.stringify(danger))
  const infos = events.filter((e) => e.level === 'info')
  assert.ok(infos.some((e) => e.msg.includes('retry 1/3')), JSON.stringify(infos))
  timers.fireAll()
  assert.deepEqual(retried, ['t1'])
  clearJsDebugEvents()
})

test('natural ended with a large shortfall logs the observe-only truncation verdict (no behavior change)', async () => {
  const { jsDebugEventsSnapshot, clearJsDebugEvents } = await import('../src/lib/debugLog')
  clearJsDebugEvents()
  const { t, engine, ended } = makeTransport()
  await t.init()
  await t.playLoaded({ trackId: 't1' })
  // The truncated-stream shape: ended fires at 55 s while the metadata
  // duration still claims 138 s (the LDM cut-mid-body case).
  engine.a.currentTime = 55.2
  engine.a.duration = 138
  engine.a.dispatch('ended')
  assert.deepEqual(ended, [{ kind: 'natural', fromError: false }], 'observe-only: the advance is NOT suppressed')
  const events = jsDebugEventsSnapshot()
  assert.ok(events.some((e) => e.level === 'danger' && e.msg.includes('ended EARLY by 82.8')), JSON.stringify(events))
  clearJsDebugEvents()
})

test('natural ended at the metadata duration logs nothing (healthy path stays quiet)', async () => {
  const { jsDebugEventsSnapshot, clearJsDebugEvents } = await import('../src/lib/debugLog')
  clearJsDebugEvents()
  const { t, engine, ended } = makeTransport()
  await t.init()
  await t.playLoaded({ trackId: 't1' })
  engine.a.currentTime = 179.95
  engine.a.duration = 180
  engine.a.dispatch('ended')
  assert.deepEqual(ended, [{ kind: 'natural', fromError: false }])
  const events = jsDebugEventsSnapshot()
  assert.ok(!events.some((e) => e.msg.includes('ended EARLY')), JSON.stringify(events))
  clearJsDebugEvents()
})

test('natural ended with unknown duration logs nothing (no false positive)', async () => {
  const { jsDebugEventsSnapshot, clearJsDebugEvents } = await import('../src/lib/debugLog')
  clearJsDebugEvents()
  const { t, engine, ended } = makeTransport()
  await t.init()
  await t.playLoaded({ trackId: 't1' })
  engine.a.currentTime = 10
  engine.a.duration = NaN
  engine.a.dispatch('ended')
  assert.deepEqual(ended, [{ kind: 'natural', fromError: false }])
  const events = jsDebugEventsSnapshot()
  assert.ok(!events.some((e) => e.msg.includes('ended EARLY')), JSON.stringify(events))
  clearJsDebugEvents()
})
