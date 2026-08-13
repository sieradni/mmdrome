import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  transitionBg,
  type BgCommand,
  type BgEvent,
  type BgState,
} from '../src/lib/playbackCore/bgStateMachine'

const fg: BgState = { name: 'foreground' }

function trackEndedEv(over: Partial<Extract<BgEvent, { type: 'trackEnded' }>> = {}): Extract<BgEvent, { type: 'trackEnded' }> {
  return { type: 'trackEnded', trackId: 't1', fromError: false, parkArmed: false, loopMode: 'none', hasNext: false, hasUserQueue: false, ...over }
}

function exitBgEv(over: Partial<Extract<BgEvent, { type: 'exitBg' }>> = {}): Extract<BgEvent, { type: 'exitBg' }> {
  return { type: 'exitBg', ended: false, atEnd: false, wasPlaying: true, position: 42, trackId: 't1', parkArmed: false, loopMode: 'none', hasNext: false, hasUserQueue: false, ...over }
}

function expectTransition(state: BgState, event: BgEvent, next: BgState, command: BgCommand | null): void {
  const t = transitionBg(state, event)
  assert.deepEqual(t.state, next)
  assert.deepEqual(t.command, command)
}

// ── enterBg ────────────────────────────────────────────────────────────────

test('enterBg: foreground → handoff{enter} (fg element still audible)', () => {
  expectTransition(fg, { type: 'enterBg' }, { name: 'handoff', origin: 'enter' }, null)
})

test('enterBg: no-op in every non-foreground state', () => {
  const states: BgState[] = [
    { name: 'handoff', origin: 'enter' },
    { name: 'handoff', origin: 'load' },
    { name: 'bg-playing' },
    { name: 'bg-paused' },
    { name: 'park-pending', trackId: 't1' },
    { name: 'resuming' },
  ]
  for (const s of states) expectTransition(s, { type: 'enterBg' }, s, null)
})

// ── bgStarted / bgFailed ───────────────────────────────────────────────────

test('bgStarted: enter-handoff → bg-playing, pauses the now-silent fg element', () => {
  expectTransition({ name: 'handoff', origin: 'enter' }, { type: 'bgStarted' }, { name: 'bg-playing' }, { kind: 'pause' })
})

test('bgStarted: load-handoff → bg-playing, no command', () => {
  expectTransition({ name: 'handoff', origin: 'load' }, { type: 'bgStarted' }, { name: 'bg-playing' }, null)
})

test('bgStarted: stale in any non-handoff state', () => {
  for (const s of [fg, { name: 'bg-playing' }, { name: 'bg-paused' }, { name: 'park-pending', trackId: 't1' }] as BgState[]) {
    expectTransition(s, { type: 'bgStarted' }, s, null)
  }
})

test('bgFailed: enter-handoff rolls back to foreground (fg element never paused)', () => {
  expectTransition({ name: 'handoff', origin: 'enter' }, { type: 'bgFailed' }, fg, null)
})

test('bgFailed: load-handoff idles in bg-paused (bg has no retry policy)', () => {
  expectTransition({ name: 'handoff', origin: 'load' }, { type: 'bgFailed' }, { name: 'bg-paused' }, null)
})

// ── trackEnded (the bg advance chain) ──────────────────────────────────────

test('trackEnded: park → park-pending, pause', () => {
  expectTransition(
    { name: 'bg-playing' },
    trackEndedEv({ parkArmed: true }),
    { name: 'park-pending', trackId: 't1' },
    { kind: 'pause' },
  )
})

test('trackEnded: loop-one restarts via the bg load path', () => {
  expectTransition(
    { name: 'bg-playing' },
    trackEndedEv({ loopMode: 'one' }),
    { name: 'handoff', origin: 'load' },
    { kind: 'load', target: 'bg', decision: 'restart' },
  )
})

test('trackEnded: advances via the bg load path', () => {
  expectTransition(
    { name: 'bg-playing' },
    trackEndedEv({ hasNext: true }),
    { name: 'handoff', origin: 'load' },
    { kind: 'load', target: 'bg', decision: 'advance' },
  )
})

test('trackEnded: loop-all wraps via the bg load path', () => {
  expectTransition(
    { name: 'bg-playing' },
    trackEndedEv({ loopMode: 'all', hasNext: false, hasUserQueue: true }),
    { name: 'handoff', origin: 'load' },
    { kind: 'load', target: 'bg', decision: 'wrap' },
  )
})

test('trackEnded: stop idles in bg-paused (parity — the ended element sits silent)', () => {
  expectTransition(
    { name: 'bg-playing' },
    trackEndedEv({ hasNext: false }),
    { name: 'bg-paused' },
    { kind: 'stop', target: 'bg' },
  )
})

test('trackEnded: error-driven advance skips the park', () => {
  expectTransition(
    { name: 'bg-playing' },
    trackEndedEv({ fromError: true, parkArmed: true, hasNext: true }),
    { name: 'handoff', origin: 'load' },
    { kind: 'load', target: 'bg', decision: 'advance' },
  )
})

test('trackEnded: no-op in paused/in-flight states (watchdog re-trip + in-flight guards)', () => {
  const states: BgState[] = [
    fg,
    { name: 'handoff', origin: 'enter' },
    { name: 'handoff', origin: 'load' },
    { name: 'bg-paused' },
    { name: 'park-pending', trackId: 't1' },
    { name: 'resuming' },
  ]
  for (const s of states) expectTransition(s, trackEndedEv(), s, null)
})

// ── loadRequest ────────────────────────────────────────────────────────────

test('loadRequest: bg-playing / bg-paused / park-pending → bg load of the resolved track', () => {
  for (const s of [{ name: 'bg-playing' }, { name: 'bg-paused' }, { name: 'park-pending', trackId: 't1' }] as BgState[]) {
    expectTransition(s, { type: 'loadRequest' }, { name: 'handoff', origin: 'load' }, { kind: 'load', target: 'bg', decision: 'reload' })
  }
})

test('loadRequest: during a handoff supersedes it (last wins, origin kept)', () => {
  const h = { name: 'handoff', origin: 'enter' } as BgState
  expectTransition(h, { type: 'loadRequest' }, h, { kind: 'load', target: 'bg', decision: 'reload' })
})

test('loadRequest: no-op in foreground and resuming', () => {
  for (const s of [fg, { name: 'resuming' }] as BgState[]) {
    expectTransition(s, { type: 'loadRequest' }, s, null)
  }
})

// ── lock-screen play/pause ─────────────────────────────────────────────────

test('pauseCmd: bg-playing → bg-paused + pause', () => {
  expectTransition({ name: 'bg-playing' }, { type: 'pauseCmd' }, { name: 'bg-paused' }, { kind: 'pause' })
})

test('pauseCmd: no-op when already paused', () => {
  expectTransition({ name: 'bg-paused' }, { type: 'pauseCmd' }, { name: 'bg-paused' }, null)
})

test('playCmd: bg-paused → bg-playing + play', () => {
  expectTransition({ name: 'bg-paused' }, { type: 'playCmd' }, { name: 'bg-playing' }, { kind: 'play' })
})

test('playCmd: park-pending → bg-playing + play (park consumed — the tail plays out)', () => {
  expectTransition({ name: 'park-pending', trackId: 't1' }, { type: 'playCmd' }, { name: 'bg-playing' }, { kind: 'play' })
})

test('playCmd: no-op while already playing', () => {
  expectTransition({ name: 'bg-playing' }, { type: 'playCmd' }, { name: 'bg-playing' }, null)
})

// ── exitBg ─────────────────────────────────────────────────────────────────

test('exitBg: no-op in foreground and resuming', () => {
  for (const s of [fg, { name: 'resuming' }] as BgState[]) {
    expectTransition(s, exitBgEv(), s, null)
  }
})

test('exitBg: enter-handoff abandons the swap (fg element still audible)', () => {
  expectTransition({ name: 'handoff', origin: 'enter' }, exitBgEv(), fg, null)
})

test('exitBg: load-handoff retries the in-flight track via the fg path', () => {
  expectTransition({ name: 'handoff', origin: 'load' }, exitBgEv(), fg, { kind: 'load', target: 'fg', decision: 'reload' })
})

test('exitBg: bg-paused carries the bg position, stays paused (correction 2)', () => {
  expectTransition({ name: 'bg-paused' }, exitBgEv({ wasPlaying: false }), fg, { kind: 'carryPaused', position: 42 })
})

test('exitBg: park-pending with matching track carries the park, stays paused', () => {
  expectTransition({ name: 'park-pending', trackId: 't1' }, exitBgEv({ wasPlaying: false }), fg, { kind: 'carryPaused', position: 42 })
})

test('exitBg: park-pending superseded (wasPlaying) falls through to the regular exit', () => {
  expectTransition({ name: 'park-pending', trackId: 't1' }, exitBgEv({ wasPlaying: true, ended: true, hasNext: true }), fg, { kind: 'load', target: 'fg', decision: 'advance' })
})

test('exitBg: park-pending with a mismatched track id falls through', () => {
  expectTransition({ name: 'park-pending', trackId: 't1' }, exitBgEv({ wasPlaying: false, trackId: 't2', ended: true, hasNext: false }), fg, { kind: 'stop', target: 'fg' })
})

test('exitBg: end-of-track sleep parks ONLY at the track end (correction 1 — mid-track unlock resumes)', () => {
  expectTransition({ name: 'bg-playing' }, exitBgEv({ parkArmed: true, ended: true }), fg, { kind: 'carryPaused', position: 42 })
  expectTransition({ name: 'bg-playing' }, exitBgEv({ parkArmed: true, atEnd: true, wasPlaying: true }), fg, { kind: 'carryPaused', position: 42 })
  expectTransition({ name: 'bg-playing' }, exitBgEv({ parkArmed: true, wasPlaying: true }), { name: 'resuming' }, { kind: 'resumeFg', position: 42 })
})

test('exitBg: ended → fg advance chain (advance / loop-one restart / wrap / stop)', () => {
  expectTransition({ name: 'bg-playing' }, exitBgEv({ ended: true, hasNext: true }), fg, { kind: 'load', target: 'fg', decision: 'advance' })
  expectTransition({ name: 'bg-playing' }, exitBgEv({ ended: true, loopMode: 'one' }), fg, { kind: 'load', target: 'fg', decision: 'restart' })
  expectTransition({ name: 'bg-playing' }, exitBgEv({ ended: true, loopMode: 'all', hasUserQueue: true }), fg, { kind: 'load', target: 'fg', decision: 'wrap' })
  expectTransition({ name: 'bg-playing' }, exitBgEv({ ended: true }), fg, { kind: 'stop', target: 'fg' })
})

test('exitBg: wasPlaying resumes the fg element at the bg position', () => {
  expectTransition({ name: 'bg-playing' }, exitBgEv({ wasPlaying: true }), { name: 'resuming' }, { kind: 'resumeFg', position: 42 })
})

test('exitBg: paused + not ended + no park → carry the bg position, stay paused', () => {
  expectTransition({ name: 'bg-playing' }, exitBgEv({ wasPlaying: false }), fg, { kind: 'carryPaused', position: 42 })
})

// ── resumed ────────────────────────────────────────────────────────────────

test('resumed: resuming → foreground', () => {
  expectTransition({ name: 'resuming' }, { type: 'resumed' }, fg, null)
})

test('resumed: stale elsewhere', () => {
  for (const s of [fg, { name: 'bg-playing' }, { name: 'handoff', origin: 'load' }] as BgState[]) {
    expectTransition(s, { type: 'resumed' }, s, null)
  }
})

// ── integration: the interlock protections as end-to-end flows ─────────────

test('flow: bg natural end with sleep armed parks, survives the watchdog re-trip, carries out on exit', () => {
  let s: BgState = { name: 'bg-playing' }
  const ended = trackEndedEv({ parkArmed: true })
  ;({ state: s } = transitionBg(s, ended))
  assert.deepEqual(s, { name: 'park-pending', trackId: 't1' })
  // The watchdog re-fires while paused near the end — structurally a no-op.
  const t = transitionBg(s, ended)
  assert.deepEqual(t.state, { name: 'park-pending', trackId: 't1' })
  assert.equal(t.command, null)
  // Lock-screen play consumes the park and plays the tail out.
  ;({ state: s } = transitionBg(s, { type: 'playCmd' }))
  assert.deepEqual(s, { name: 'bg-playing' })
})

test('flow: bg natural end with sleep armed then exit carries the park into fg', () => {
  let s: BgState = { name: 'bg-playing' }
  ;({ state: s } = transitionBg(s, trackEndedEv({ parkArmed: true })))
  const t = transitionBg(s, exitBgEv({ wasPlaying: false }))
  assert.deepEqual(t.state, fg)
  assert.deepEqual(t.command, { kind: 'carryPaused', position: 42 })
})

test('flow: enter → play → end → advance → next track → exit mid-track resumes seamlessly', () => {
  let s: BgState = fg
  ;({ state: s } = transitionBg(s, { type: 'enterBg' }))
  assert.equal(s.name, 'handoff')
  ;({ state: s } = transitionBg(s, { type: 'bgStarted' }))
  assert.deepEqual(s, { name: 'bg-playing' })
  ;({ state: s } = transitionBg(s, trackEndedEv({ hasNext: true })))
  assert.deepEqual(s, { name: 'handoff', origin: 'load' })
  ;({ state: s } = transitionBg(s, { type: 'bgStarted' }))
  assert.deepEqual(s, { name: 'bg-playing' })
  const t = transitionBg(s, exitBgEv({ wasPlaying: true, position: 12 }))
  assert.deepEqual(t.state, { name: 'resuming' })
  assert.deepEqual(t.command, { kind: 'resumeFg', position: 12 })
  const t2 = transitionBg(t.state, { type: 'resumed' })
  assert.deepEqual(t2.state, fg)
})

test('flow: enter-bg handoff failure rolls back without touching the fg element', () => {
  const t = transitionBg({ name: 'handoff', origin: 'enter' }, { type: 'bgFailed' })
  assert.deepEqual(t.state, fg)
  assert.equal(t.command, null)
})

test('flow: a stale enter during resuming is a no-op (sequence race)', () => {
  const s: BgState = { name: 'resuming' }
  expectTransition(s, { type: 'enterBg' }, s, null)
  expectTransition(s, { type: 'bgStarted' }, s, null)
})