import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebBgTransport, type BgFacts, type LoadDecision } from '../src/lib/playbackCore/webBgTransport'
import type { WebBgEngine } from '../src/lib/playbackCore/webBgTransport'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// ── fakes ───────────────────────────────────────────────────────────────────

type ListenerMap = Record<string, Array<() => void>>

class FakeEl {
  src = ''
  currentTime = 0
  playbackRate = 1
  paused = true
  ended = false
  readyState = 0
  manualPlays = false
  rejectPlays = false
  playCalls = 0
  pauseCalls = 0
  loadCalls = 0
  readonly _listeners: ListenerMap = {}
  readonly _pending: Array<() => void> = []
  readonly _rejecting: Array<(e: unknown) => void> = []

  play(): Promise<void> {
    this.playCalls++
    if (this.manualPlays) {
      return new Promise<void>((resolve, reject) => {
        this._pending.push(resolve)
        this._rejecting.push(reject)
      })
    }
    if (this.rejectPlays) return Promise.reject(new Error('play rejected'))
    this.paused = false
    return Promise.resolve()
  }

  settleNextPlay(): void {
    const r = this._pending.shift()
    if (r) {
      this.paused = false
      r()
    }
  }

  rejectNextPlay(): void {
    const r = this._rejecting.shift()
    if (r) r(new Error('play rejected'))
  }

  pause(): void {
    this.pauseCalls++
    this.paused = true
  }

  load(): void {
    this.loadCalls++
    this.readyState = 0
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = ''
  }

  addEventListener(type: string, fn: () => void): void {
    ;(this._listeners[type] ??= []).push(fn)
  }

  removeEventListener(type: string, fn: () => void): void {
    this._listeners[type] = (this._listeners[type] ?? []).filter((f) => f !== fn)
  }

  emit(type: string): void {
    for (const fn of [...(this._listeners[type] ?? [])]) fn()
  }
}

class FakeEngine implements WebBgEngine {
  isIOS = true
  readonly created: FakeEl[] = []
  readonly calls: string[] = []
  offset = 0.2

  createBgElement(): HTMLAudioElement {
    const el = new FakeEl()
    this.created.push(el)
    return el as unknown as HTMLAudioElement
  }

  getTransitionOffset(): number {
    return this.offset
  }

  teardownCrossfadeMonitor(): void {
    this.calls.push('teardownCrossfadeMonitor')
  }

  async reviveContext(): Promise<void> {
    this.calls.push('reviveContext')
  }

  resumeCrossfadeAfterBgExit(): void {
    this.calls.push('resumeCrossfadeAfterBgExit')
  }
}

class FakeTimers {
  readonly entries: Array<{ ms: number; fn: () => void; active: boolean }> = []

  interval(ms: number, fn: () => void): () => void {
    const entry = { ms, fn, active: true }
    this.entries.push(entry)
    return () => {
      entry.active = false
    }
  }

  get count(): number {
    return this.entries.filter((e) => e.active).length
  }

  tick(): void {
    for (const e of [...this.entries]) if (e.active) e.fn()
  }
}

const documentStub = {
  hidden: false,
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
} as unknown as Document

// ── harness ─────────────────────────────────────────────────────────────────

interface Harness {
  t: WebBgTransport
  engine: FakeEngine
  fg: FakeEl
  bgEl: FakeEl
  timers: FakeTimers
  loads: Array<[target: 'fg' | 'bg', decision: LoadDecision]>
  stops: Array<'fg' | 'bg'>
  parked: string[]
  ticks: number[]
  facts: BgFacts
}

function makeHarness(): Harness {
  globalThis.document = documentStub
  const fg = new FakeEl()
  const engine = new FakeEngine()
  const facts: BgFacts = {
    currentTrackId: 't1',
    parkArmed: false,
    loopMode: 'all',
    hasNext: true,
    hasUserQueue: true,
    duration: 300,
  }
  const timers = new FakeTimers()
  const t = new WebBgTransport(engine, { facts: () => facts, fgElement: () => fg as unknown as HTMLAudioElement }, timers)
  const loads: Harness['loads'] = []
  const stops: Harness['stops'] = []
  const parked: string[] = []
  const ticks: number[] = []
  t.onLoad = (target, decision) => {
    loads.push([target, decision])
  }
  t.onStop = (target) => {
    stops.push(target)
  }
  t.onParked = (id) => {
    parked.push(id)
  }
  t.onTick = (pos) => {
    ticks.push(pos)
  }
  t.init()
  const bgEl = engine.created[0]
  return { t, engine, fg, bgEl, timers, loads, stops, parked, ticks, facts }
}

/** Drives the enter-bg path to completion (swap play resolves). */
async function enterBg(h: Harness): Promise<void> {
  h.fg.src = 'u1'
  h.fg.paused = false
  h.t.handleVisibility(true)
  await flush()
}

// ── init / teardown ─────────────────────────────────────────────────────────

test('init creates the bg element and wires ended/error listeners', () => {
  const h = makeHarness()
  assert.equal(h.engine.created.length, 1)
  assert.ok(h.bgEl._listeners['ended'])
  assert.ok(h.bgEl._listeners['error'])
})

test('teardown removes listeners, stops the tick, and disengages', async () => {
  const h = makeHarness()
  await enterBg(h)
  assert.equal(h.t.engaged, true)
  h.t.teardown()
  assert.equal(h.t.engaged, false)
  assert.equal(h.bgEl._listeners['ended']?.length ?? 0, 0)
  assert.equal(h.timers.count, 0)
  assert.equal(h.bgEl.paused, true)
  const ok = await h.t.startBgLoad('u2')
  assert.equal(ok, false)
  assert.equal(h.bgEl.playCalls, 1) // the enter swap — never the post-teardown load
})

// ── enterBg: swap mechanics ─────────────────────────────────────────────────

test('enterBg swaps src/position to the bg element, pauses fg on settle', async () => {
  const h = makeHarness()
  h.fg.src = 'u1'
  h.fg.currentTime = 55.4
  await h.fg.play()
  assert.equal(h.fg.paused, false)
  h.t.handleVisibility(true)
  await flush()
  assert.deepEqual(h.engine.calls, ['teardownCrossfadeMonitor'])
  assert.equal(h.bgEl.src, h.fg.src)
  assert.equal(h.bgEl.currentTime, 55.4 - h.engine.offset)
  assert.equal(h.bgEl.paused, false)
  assert.equal(h.fg.paused, true) // bgStarted pause (origin enter)
  assert.equal(h.t.engaged, true)
  assert.equal(h.timers.count, 1) // 250 ms watchdog started
})

test('enterBg with a paused fg element is a no-op', async () => {
  const h = makeHarness()
  h.t.handleVisibility(true)
  await flush()
  assert.equal(h.bgEl.playCalls, 0)
  assert.equal(h.t.engaged, false)
})

test('enterBg with an ended or src-less fg element is a no-op', async () => {
  const h = makeHarness()
  h.fg.ended = true
  h.fg.paused = false
  h.t.handleVisibility(true)
  await flush()
  assert.equal(h.bgEl.playCalls, 0)
  const h2 = makeHarness()
  h2.fg.paused = false
  h2.fg.src = ''
  h2.t.handleVisibility(true)
  await flush()
  assert.equal(h2.bgEl.playCalls, 0)
})

test('enterBg whose swap play rejects rolls back to foreground (fg never pauses)', async () => {
  const h = makeHarness()
  h.fg.src = 'u1'
  await h.fg.play()
  h.bgEl.rejectPlays = true
  h.t.handleVisibility(true)
  await flush()
  assert.equal(h.t.engaged, false)
  assert.equal(h.fg.paused, false)
  assert.equal(h.bgEl.playCalls, 1)
  assert.equal(h.timers.count, 0)
})

test('a re-hide during the fg resume re-engages the swap (correction 5)', async () => {
  const h = makeHarness()
  await enterBg(h)
  await h.t.handleVisibility(false) // exit while playing → resumeFg → foreground
  assert.equal(h.t.engaged, false)
  assert.equal(h.fg.paused, false)
  h.fg.currentTime = 77
  h.t.handleVisibility(true) // re-hide during/right after the resume
  await flush()
  assert.equal(h.t.engaged, true)
  assert.equal(h.fg.paused, true)
  assert.equal(h.bgEl.src, h.fg.src)
})

test('a re-hide in an engaged bg state never re-runs the swap', async () => {
  const h = makeHarness()
  await enterBg(h)
  const swapPlays = h.bgEl.playCalls
  h.t.handleVisibility(true)
  await flush()
  assert.equal(h.bgEl.playCalls, swapPlays)
  assert.equal(h.t.engaged, true)
})

// ── bg ended / advance chain ────────────────────────────────────────────────

test('bg ended with hasNext → onLoad([bg, advance]); load settles to bg-playing', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.bgEl.emit('ended')
  await flush()
  assert.deepEqual(h.loads, [['bg', 'advance']])
  assert.equal(h.t.engaged, true)
  const ok = await h.t.startBgLoad('u2')
  assert.equal(ok, true)
  assert.equal(h.bgEl.src, 'u2')
  assert.equal(h.bgEl.currentTime, 0)
  assert.equal(h.bgEl.paused, false)
})

test('bg ended with loop-one → onLoad([bg, restart])', async () => {
  const h = makeHarness()
  h.facts.loopMode = 'one'
  await enterBg(h)
  h.bgEl.emit('ended')
  await flush()
  assert.deepEqual(h.loads, [['bg', 'restart']])
})

test('bg ended at queue end with hasUserQueue (loop-all) → onLoad([bg, wrap])', async () => {
  const h = makeHarness()
  h.facts.hasNext = false
  await enterBg(h)
  h.bgEl.emit('ended')
  await flush()
  assert.deepEqual(h.loads, [['bg', 'wrap']])
})

test('bg ended with loopMode stop and no next → onStop([bg]), idle bg-paused', async () => {
  const h = makeHarness()
  h.facts.loopMode = 'none'
  h.facts.hasNext = false
  await enterBg(h)
  h.bgEl.emit('ended')
  await flush()
  assert.deepEqual(h.stops, ['bg'])
  assert.deepEqual(h.loads, [])
  assert.equal(h.t.engaged, true) // bg-paused — still engaged for media commands
})

test('bg ended with parkArmed → park-pending: pause + nudge + onParked', async () => {
  const h = makeHarness()
  h.facts.parkArmed = true
  await enterBg(h)
  h.bgEl.currentTime = 299.8
  h.bgEl.emit('ended')
  await flush()
  assert.equal(h.bgEl.paused, true)
  assert.equal(h.bgEl.currentTime, 299.8) // inside the window but below dur-0.05 — no nudge
  assert.deepEqual(h.parked, ['t1'])
  assert.deepEqual(h.loads, [])
})

test('park nudge: an ended element parks at dur-0.05 so play resumes the tail', async () => {
  const h = makeHarness()
  h.facts.parkArmed = true
  await enterBg(h)
  h.bgEl.currentTime = 300 // ended — play() would restart the track from 0
  h.bgEl.emit('ended')
  await flush()
  assert.equal(h.bgEl.currentTime, 300 - 0.05)
  assert.deepEqual(h.parked, ['t1'])
})

test('park with unknown duration skips the nudge but still reports onParked', async () => {
  const h = makeHarness()
  h.facts.parkArmed = true
  h.facts.duration = 0
  await enterBg(h)
  h.bgEl.currentTime = 100
  h.bgEl.emit('ended')
  await flush()
  assert.equal(h.bgEl.currentTime, 100)
  assert.deepEqual(h.parked, ['t1'])
})

test('bg error → fromError advance (park skipped), then further errors are dropped', async () => {
  const h = makeHarness()
  h.facts.parkArmed = true // A4: fromError skips the park
  await enterBg(h)
  h.bgEl.emit('error')
  await flush()
  assert.deepEqual(h.loads, [['bg', 'advance']])
  assert.deepEqual(h.parked, [])
  h.bgEl.emit('error') // machine now in handoff — dropped
  await flush()
  assert.deepEqual(h.loads, [['bg', 'advance']])
})

test('bg error with loop-one → onLoad([bg, restart])', async () => {
  const h = makeHarness()
  h.facts.loopMode = 'one'
  await enterBg(h)
  h.bgEl.emit('error')
  await flush()
  assert.deepEqual(h.loads, [['bg', 'restart']])
})

// ── exit: bg-playing ────────────────────────────────────────────────────────

test('exit while playing (no park, not ended) → resumeFg; re-arm called', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.bgEl.currentTime = 33.3
  await h.t.handleVisibility(false)
  assert.equal(h.t.engaged, false)
  assert.equal(h.fg.currentTime, 33.3)
  assert.equal(h.fg.paused, false) // resumed
  assert.equal(h.bgEl.paused, true) // torn down
  assert.ok(h.engine.calls.includes('resumeCrossfadeAfterBgExit'))
  assert.equal(h.timers.count, 0) // tick stopped at exit
})

test('exit while playing with an ENDED bg element → fg advance chain', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.bgEl.ended = true
  await h.t.handleVisibility(false)
  assert.deepEqual(h.loads, [['fg', 'advance']])
  assert.equal(h.fg.paused, true) // no resumeFg — the chain loads
})

test('exit-ended with loop-one RESTARTS via decideAdvance (correction 3)', async () => {
  const h = makeHarness()
  h.facts.loopMode = 'one'
  await enterBg(h)
  h.bgEl.ended = true
  await h.t.handleVisibility(false)
  assert.deepEqual(h.loads, [['fg', 'restart']])
})

test('exit-ended with no next and loop stop → onStop([fg])', async () => {
  const h = makeHarness()
  h.facts.loopMode = 'none'
  h.facts.hasNext = false
  await enterBg(h)
  h.bgEl.ended = true
  await h.t.handleVisibility(false)
  assert.deepEqual(h.stops, ['fg'])
})

test('exit with parkArmed at end → carryPaused, no resume (correction 1)', async () => {
  const h = makeHarness()
  h.facts.parkArmed = true
  await enterBg(h)
  h.bgEl.currentTime = 299.9 // atEnd (>= dur-0.5) but not literally ended
  await h.t.handleVisibility(false)
  assert.deepEqual(h.parked, ['t1']) // the park gate reported the exit park
  assert.equal(h.fg.paused, true)
  assert.equal(h.fg.currentTime, 299.9)
})

test('exit-park gate reports onParked (the manager records the exit park)', async () => {
  const h = makeHarness()
  h.facts.parkArmed = true
  await enterBg(h)
  h.bgEl.currentTime = 300 // ended + atEnd → the correction-1 park gate
  await h.t.handleVisibility(false)
  assert.deepEqual(h.parked, ['t1'])
  assert.equal(h.fg.paused, true)
  assert.equal(h.fg.currentTime, 300)
})

test('exit-park onParked is not re-fired for a matching park-pending carry', async () => {
  const h = makeHarness()
  h.facts.parkArmed = true
  await enterBg(h)
  h.bgEl.emit('ended')
  await flush()
  assert.deepEqual(h.parked, ['t1'])
  await h.t.handleVisibility(false)
  assert.deepEqual(h.parked, ['t1']) // the exit carry reports nothing new
})

test('exit with parkArmed mid-track (not at end) → plain resume', async () => {
  const h = makeHarness()
  h.facts.parkArmed = true
  await enterBg(h)
  h.bgEl.currentTime = 60
  await h.t.handleVisibility(false)
  assert.equal(h.fg.paused, false)
  assert.equal(h.fg.currentTime, 60)
})

// ── exit: paused / parked / handoff ─────────────────────────────────────────

test('exit from a manually-paused bg carries the bg position (correction 2)', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.bgEl.currentTime = 44.4
  h.t.mediaPause()
  await flush()
  assert.equal(h.bgEl.paused, true)
  await h.t.handleVisibility(false)
  assert.equal(h.fg.currentTime, 44.4)
  assert.equal(h.fg.paused, true)
})

test('exit from a matching park-pending carries the position and stays paused', async () => {
  const h = makeHarness()
  h.facts.parkArmed = true
  await enterBg(h)
  h.bgEl.emit('ended')
  await flush()
  assert.deepEqual(h.parked, ['t1'])
  h.bgEl.currentTime = 299.95
  await h.t.handleVisibility(false)
  assert.deepEqual(h.parked, ['t1']) // no second park
  assert.equal(h.fg.paused, true)
  assert.equal(h.fg.currentTime, 299.95)
})

test('a park consumed by resume exits as a normal playing track', async () => {
  const h = makeHarness()
  h.facts.parkArmed = true
  await enterBg(h)
  h.bgEl.emit('ended')
  await flush()
  h.t.mediaPlay() // park consumed — tail plays out
  await flush()
  assert.equal(h.bgEl.paused, false)
  await h.t.handleVisibility(false)
  assert.equal(h.fg.paused, false) // resumed, not re-parked
})

test('exit during an uncompleted enter-swap is a no-op (fg untouched, stale settle dropped)', async () => {
  const h = makeHarness()
  h.fg.src = 'u1'
  await h.fg.play()
  h.bgEl.manualPlays = true
  h.t.handleVisibility(true)
  await flush()
  assert.equal(h.t.engaged, true) // handoff
  await h.t.handleVisibility(false)
  assert.equal(h.fg.paused, false) // still audible — machine went straight to foreground
  assert.ok(h.engine.calls.includes('resumeCrossfadeAfterBgExit'))
  h.bgEl.settleNextPlay() // stale settle
  await flush()
  assert.equal(h.t.engaged, false) // never entered bg-playing
})

test('exit racing an in-flight bg load re-routes to onLoad([fg, reload])', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.bgEl.emit('ended') // → handoff{load} + onLoad([bg, advance])
  await flush()
  await h.t.handleVisibility(false)
  assert.deepEqual(h.loads, [
    ['bg', 'advance'],
    ['fg', 'reload'],
  ])
  assert.equal(h.fg.paused, true)
})

test('exit racing a superseded enter-swap re-routes to onLoad([fg, reload]) (correction 7)', async () => {
  const h = makeHarness()
  h.fg.src = 'u1'
  await h.fg.play()
  h.bgEl.manualPlays = true
  h.t.handleVisibility(true)
  await flush()
  h.t.loadRequest() // supersedes the swap
  await flush()
  await h.t.handleVisibility(false)
  assert.deepEqual(h.loads, [['bg', 'reload'], ['fg', 'reload']])
  h.bgEl.settleNextPlay()
  await flush()
  assert.equal(h.t.engaged, false)
})

// ── media commands ──────────────────────────────────────────────────────────

test('mediaPlay resumes bg-paused → bg-playing', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.t.mediaPause()
  await flush()
  assert.equal(h.bgEl.paused, true)
  h.t.mediaPlay()
  await flush()
  assert.equal(h.bgEl.paused, false)
  assert.equal(h.t.engaged, true)
})

test('mediaPlay consumes a park and replays the tail', async () => {
  const h = makeHarness()
  h.facts.parkArmed = true
  await enterBg(h)
  h.bgEl.currentTime = 300 // the ended position
  h.bgEl.emit('ended')
  await flush()
  assert.equal(h.bgEl.currentTime, 299.95)
  h.facts.parkArmed = false // the manager clears the park on an explicit play
  h.t.mediaPlay()
  await flush()
  assert.equal(h.bgEl.paused, false)
  assert.equal(h.bgEl.playCalls, 2)
  h.bgEl.emit('ended') // tail ends → natural advance (loop-all)
  await flush()
  assert.deepEqual(h.loads, [['bg', 'advance']])
  await h.t.startBgLoad('u2') // the manager's load — back to bg-playing
  h.facts.hasNext = false // queue drained while parked — the tail end wraps
  h.bgEl.emit('ended')
  await flush()
  assert.deepEqual(h.loads, [
    ['bg', 'advance'],
    ['bg', 'wrap'],
  ])
})

test('mediaPlay in bg-playing / handoff is a no-op', async () => {
  const h = makeHarness()
  await enterBg(h)
  const plays = h.bgEl.playCalls
  h.t.mediaPlay()
  await flush()
  assert.equal(h.bgEl.playCalls, plays)
})

test('mediaPause during an enter-handoff pauses the fg element and cancels the swap', async () => {
  const h = makeHarness()
  h.fg.src = 'u1'
  await h.fg.play()
  h.bgEl.manualPlays = true
  h.t.handleVisibility(true)
  await flush()
  h.t.mediaPause()
  await flush()
  assert.equal(h.fg.paused, true) // the AUDIBLE element
  assert.equal(h.bgEl.pauseCalls, 1)
  h.bgEl.settleNextPlay() // stale — token bumped
  await flush()
  assert.equal(h.t.engaged, true) // bg-paused — never bg-playing
})

// ── watchdog tick ───────────────────────────────────────────────────────────

test('tick reports position; trips trackEnded at duration-0.25', async () => {
  const h = makeHarness()
  await enterBg(h)
  assert.equal(h.timers.count, 1)
  h.bgEl.currentTime = 100
  h.timers.tick()
  assert.deepEqual(h.ticks, [100])
  assert.deepEqual(h.loads, [])
  h.bgEl.currentTime = 299.8 // >= 299.75
  h.timers.tick()
  await flush()
  assert.deepEqual(h.ticks, [100, 299.8])
  assert.deepEqual(h.loads, [['bg', 'advance']])
})

test('watchdog never trips with unknown duration', async () => {
  const h = makeHarness()
  h.facts.duration = 0
  await enterBg(h)
  h.bgEl.currentTime = 999
  h.timers.tick()
  await flush()
  assert.deepEqual(h.loads, [])
})

test('watchdog re-trips are dropped in paused/parked states', async () => {
  const h = makeHarness()
  h.facts.parkArmed = true
  await enterBg(h)
  h.bgEl.currentTime = 299.9
  h.timers.tick() // → park-pending (watchdog)
  await flush()
  assert.deepEqual(h.parked, ['t1'])
  assert.deepEqual(h.loads, [])
  h.timers.tick() // re-trip in park-pending — dropped
  await flush()
  assert.deepEqual(h.parked, ['t1'])
  assert.deepEqual(h.loads, [])
})

// ── loadRequest / reload ────────────────────────────────────────────────────

test('loadRequest while bg-playing → onLoad([bg, reload])', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.t.loadRequest()
  await flush()
  assert.deepEqual(h.loads, [['bg', 'reload']])
  const ok = await h.t.startBgLoad('u2')
  assert.equal(ok, true)
  assert.equal(h.bgEl.src, 'u2')
})

test('loadRequest while foreground is a no-op', async () => {
  const h = makeHarness()
  h.t.loadRequest()
  await flush()
  assert.deepEqual(h.loads, [])
})

test('two racing startBgLoads — the last settle wins (token)', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.bgEl.emit('ended') // → onLoad([bg, advance]) — the load is the manager's call
  await flush()
  h.bgEl.manualPlays = true
  const p1 = h.t.startBgLoad('u2')
  const p2 = h.t.startBgLoad('u3') // overwrites the first (old playBg parity)
  h.bgEl.settleNextPlay() // first play resolves — stale (token bumped by the 2nd)
  await flush()
  assert.equal(h.bgEl.src, 'u3')
  h.bgEl.settleNextPlay() // second resolves — wins
  await flush()
  assert.equal(await p1, false)
  assert.equal(await p2, true)
  assert.equal(h.t.engaged, true)
  h.bgEl.emit('ended')
  await flush()
  assert.deepEqual(h.loads, [
    ['bg', 'advance'],
    ['bg', 'advance'],
  ])
})

// ── abort / in-flight vs exit ───────────────────────────────────────────────

test('abortBgLoad cancels the pending settle and idles in bg-paused', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.bgEl.manualPlays = true
  h.t.loadRequest()
  await flush()
  h.t.abortBgLoad()
  await flush()
  h.bgEl.settleNextPlay() // stale — dropped
  await flush()
  assert.equal(h.t.engaged, true) // bg-paused
  h.bgEl.emit('ended') // dropped in bg-paused
  await flush()
  assert.deepEqual(h.loads, [['bg', 'reload']])
})

test('startBgLoad after an exit is refused (machine already re-routed to fg)', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.bgEl.emit('ended') // → onLoad([bg, advance]) — manager does NOT load (exited)
  await flush()
  await h.t.handleVisibility(false)
  const ok = await h.t.startBgLoad('u2')
  assert.equal(ok, false)
  assert.equal(h.bgEl.src, '') // torn down by the exit — the load was refused
  assert.equal(h.bgEl.playCalls, 1) // only the enter swap ever played
})

// ── fg src mirror (exit-resume must play the CURRENT bg track) ─────────────

test('startBgLoad mirrors the src onto the fg element', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.bgEl.emit('ended')
  await flush()
  await h.t.startBgLoad('u2')
  assert.equal(h.fg.src, 'u2')
})

test('exit-resume after a bg advance plays the bg track src', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.bgEl.emit('ended')
  await flush()
  await h.t.startBgLoad('u2')
  h.bgEl.currentTime = 40
  await h.t.handleVisibility(false)
  assert.equal(h.fg.src, 'u2') // not the stale pre-swap 'u1'
  assert.equal(h.fg.currentTime, 40)
  assert.equal(h.fg.paused, false)
})

test('exit park-carry after a bg advance lands on the bg track src', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.bgEl.emit('ended')
  await flush()
  await h.t.startBgLoad('u2') // advance — the fg element mirrors u2
  h.facts.parkArmed = true
  h.bgEl.currentTime = 299.9
  h.timers.tick() // watchdog park
  await flush()
  assert.deepEqual(h.parked, ['t1'])
  await h.t.handleVisibility(false)
  assert.equal(h.fg.src, 'u2')
  assert.equal(h.fg.currentTime, 299.9)
  assert.equal(h.fg.paused, true)
})

test('abortBgLoad after an exit is a no-op', async () => {
  const h = makeHarness()
  await enterBg(h)
  await h.t.handleVisibility(false)
  h.t.abortBgLoad()
  await flush()
  assert.equal(h.t.engaged, false)
})

// ── visible while fg / revive ───────────────────────────────────────────────

test('visible while foreground only revives the context', async () => {
  const h = makeHarness()
  await h.t.handleVisibility(false)
  assert.deepEqual(h.engine.calls, ['reviveContext'])
  assert.equal(h.t.engaged, false)
})

test('exit revives the context BEFORE the teardown snapshot (order)', async () => {
  const h = makeHarness()
  await enterBg(h)
  h.bgEl.currentTime = 55
  await h.t.handleVisibility(false)
  const ctxIdx = h.engine.calls.indexOf('reviveContext')
  const rearmIdx = h.engine.calls.indexOf('resumeCrossfadeAfterBgExit')
  assert.ok(ctxIdx >= 0 && rearmIdx > ctxIdx)
  assert.equal(h.bgEl.src, '') // torn down
  assert.equal(h.fg.currentTime, 55)
})

// ── syncSource / setSpeed ───────────────────────────────────────────────────

test('syncSource pre-warms while fg, no-ops while engaged', async () => {
  const h = makeHarness()
  h.t.syncSource('warm')
  assert.equal(h.bgEl.src, 'warm')
  await enterBg(h)
  assert.equal(h.bgEl.src, 'u1') // the swap replaced the pre-warm src
  h.t.syncSource('later')
  assert.equal(h.bgEl.src, 'u1') // engaged — no-op
})

test('setSpeed applies to the bg element and survives the swap', async () => {
  const h = makeHarness()
  h.t.setSpeed(1.5)
  assert.equal(h.bgEl.playbackRate, 1.5)
  await h.fg.play()
  h.t.handleVisibility(true)
  await flush()
  assert.equal(h.bgEl.playbackRate, 1.5)
})

// ── sessionElement ──────────────────────────────────────────────────────────

test('sessionElement is the bg element while engaged, fg otherwise', async () => {
  const h = makeHarness()
  assert.equal(h.t.sessionElement, h.fg as unknown as HTMLAudioElement)
  await enterBg(h)
  assert.equal(h.t.sessionElement, h.bgEl as unknown as HTMLAudioElement)
})

// ── full saga ───────────────────────────────────────────────────────────────

test('saga: enter → play → tick → ended advance → pause → play → exit resume', async () => {
  const h = makeHarness()
  h.fg.src = 'u1'
  await h.fg.play()
  h.fg.currentTime = 10
  h.t.handleVisibility(true)
  await flush()
  assert.equal(h.t.engaged, true)
  assert.equal(h.fg.paused, true)

  h.bgEl.currentTime = 20
  h.timers.tick()
  assert.deepEqual(h.ticks, [20])

  h.bgEl.emit('ended')
  await flush()
  assert.deepEqual(h.loads, [['bg', 'advance']])
  const ok = await h.t.startBgLoad('u2')
  assert.equal(ok, true)

  h.t.mediaPause()
  await flush()
  assert.equal(h.bgEl.paused, true)
  h.t.mediaPlay()
  await flush()
  assert.equal(h.bgEl.paused, false)

  h.bgEl.currentTime = 40
  await h.t.handleVisibility(false)
  assert.equal(h.fg.paused, false)
  assert.equal(h.fg.currentTime, 40)
  assert.equal(h.t.engaged, false)
  assert.ok(h.engine.calls.includes('resumeCrossfadeAfterBgExit'))
})
