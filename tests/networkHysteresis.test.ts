// Pins the pure network-stability classifier (2026-10-02, Phase 2 of the
// network-churn plan) — asymmetric debounce + churn latch. The prior
// generation was a single symmetric 3 s hold (P5, 2026-09-23) with no answer
// for a connection that keeps flipping; the 2026-10-02 dump showed
// `exp=false→true→false→true` across ~8 s and every confirmed flip re-derived
// `effectiveLowData` (transcode/preload/queue economics). The new contract:
//   - entering metered commits after CONFIRM_TO_METERED_MS,
//   - leaving metered needs HOLD_TO_UNMETERED_MS of CONTINUOUS unmetered raw,
//   - CHURN_MIN_TRANSITIONS flips inside CHURN_WINDOW_MS latch metered for
//     CHURN_HOLD_MS, refreshed by every further flip.
// osLowData is NOT filtered here (explicit user toggle) — the wiring pins
// live in tests/lowDataMode.test.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideNetworkStability,
  freshNetworkStability,
  CONFIRM_TO_METERED_MS,
  HOLD_TO_UNMETERED_MS,
} from '../src/lib/networkHysteresis'

test('boot adopts the first raw value immediately (no confirmation delay)', () => {
  const v = decideNetworkStability(true, 1000, freshNetworkStability())
  assert.equal(v.effective, true)
  assert.equal(v.changed, true)
  assert.equal(v.latched, false)
  assert.equal(v.state.candidate, null)
  assert.equal(v.state.lastRaw, true)
})

test('asymmetric: entering metered commits after CONFIRM_TO_METERED_MS', () => {
  let state = decideNetworkStability(false, 0, freshNetworkStability()).state
  // metered appears at t=1000
  const r1 = decideNetworkStability(true, 1000, state)
  assert.equal(r1.effective, false, 'not yet confirmed')
  assert.equal(r1.changed, false)
  state = r1.state
  // still under the window — not committed
  const r2 = decideNetworkStability(true, 1000 + CONFIRM_TO_METERED_MS - 1, state)
  assert.equal(r2.changed, false)
  // exactly at the window — committed
  const r3 = decideNetworkStability(true, 1000 + CONFIRM_TO_METERED_MS, r2.state)
  assert.equal(r3.changed, true)
  assert.equal(r3.effective, true)
  assert.equal(r3.latched, false)
  assert.equal(r3.state.candidate, null)
})

test('asymmetric: leaving metered needs the LONG HOLD window', () => {
  let state = decideNetworkStability(true, 0, freshNetworkStability()).state
  const r1 = decideNetworkStability(false, 1000, state)
  assert.equal(r1.effective, true, 'unmetered not yet confirmed')
  assert.equal(r1.changed, false)
  // well past the SHORT metered window, still not committed
  const r2 = decideNetworkStability(false, 1000 + CONFIRM_TO_METERED_MS + 1000, r1.state)
  assert.equal(r2.changed, false)
  const r3 = decideNetworkStability(false, 1000 + HOLD_TO_UNMETERED_MS - 1, r2.state)
  assert.equal(r3.changed, false)
  const r4 = decideNetworkStability(false, 1000 + HOLD_TO_UNMETERED_MS, r3.state)
  assert.equal(r4.changed, true)
  assert.equal(r4.effective, false)
})

test('a metered blip inside the unmetered hold window restarts the clock', () => {
  // Spaced > CHURN_WINDOW_MS apart so this pins ONLY the asymmetric reset,
  // not the churn latch (that has its own tests below).
  let state = decideNetworkStability(true, 0, freshNetworkStability()).state
  const a = decideNetworkStability(false, 1000, state)
  assert.equal(a.state.candidate, false)
  assert.equal(a.state.candidateAt, 1000)
  // back to metered at t=30000 (the old flip has aged out of the churn window)
  const b = decideNetworkStability(true, 30000, a.state)
  assert.equal(b.changed, false)
  assert.equal(b.effective, true)
  assert.equal(b.state.candidate, null)
  assert.equal(b.state.suppressed, 1, 'the reversed blip is counted')
  assert.equal(b.latched, false, 'two spaced flips must not latch')
  // a fresh unmetered candidate starts its own clock
  const c = decideNetworkStability(false, 31000, b.state)
  assert.equal(c.state.candidateAt, 31000, 'fresh window, not the stale one')
  assert.equal(c.latched, false)
  const d = decideNetworkStability(false, 31000 + HOLD_TO_UNMETERED_MS - 1, c.state)
  assert.equal(d.changed, false)
  const e = decideNetworkStability(false, 31000 + HOLD_TO_UNMETERED_MS, d.state)
  assert.equal(e.changed, true)
  assert.equal(e.effective, false)
})

test('churn latch: three flips inside the window pin metered', () => {
  let state = decideNetworkStability(false, 0, freshNetworkStability()).state
  state = decideNetworkStability(true, 1000, state).state // flip 1
  state = decideNetworkStability(false, 3000, state).state // flip 2
  const r = decideNetworkStability(true, 5000, state) // flip 3 → latch
  assert.equal(r.latched, true)
  assert.equal(r.effective, true, 'latched classification pins metered')
  assert.equal(r.changed, true, 'the pin itself is the one store transition')
})

test('while latched, unmetered cannot commit and further flips refresh the hold', () => {
  let state = decideNetworkStability(false, 0, freshNetworkStability()).state
  state = decideNetworkStability(true, 1000, state).state
  state = decideNetworkStability(false, 3000, state).state
  const latched = decideNetworkStability(true, 5000, state).state // latch at 5000 → until 35000
  // a further flip at 6000 refreshes the latch → until 36000
  const r2 = decideNetworkStability(false, 6000, latched)
  assert.equal(r2.latched, true)
  assert.equal(r2.effective, true)
  assert.equal(r2.changed, false)
  // The 6000 flip refreshed the deadline from 35000 to 36000: at 35001 the
  // latch is still active (an unrefreshed latch would have expired).
  const r3 = decideNetworkStability(false, 35001, r2.state)
  assert.equal(r3.latched, true, 'the 6000 flip refreshed the latch past 35000')
  assert.equal(r3.effective, true)
})

test('latch release starts the full unmetered hold window', () => {
  let state = decideNetworkStability(false, 0, freshNetworkStability()).state
  state = decideNetworkStability(true, 1000, state).state
  state = decideNetworkStability(false, 3000, state).state
  state = decideNetworkStability(true, 5000, state).state // latch until 35000
  state = decideNetworkStability(false, 6000, state).state // refresh until 36000
  const released = decideNetworkStability(false, 36001, state)
  assert.equal(released.latched, false)
  assert.equal(released.effective, true, 'not flipped the instant the latch freed')
  assert.equal(released.state.candidate, false)
  assert.equal(released.state.candidateAt, 36001)
  const still = decideNetworkStability(false, 36001 + HOLD_TO_UNMETERED_MS - 1, released.state)
  assert.equal(still.changed, false)
  const done = decideNetworkStability(false, 36001 + HOLD_TO_UNMETERED_MS, still.state)
  assert.equal(done.changed, true)
  assert.equal(done.effective, false)
})

test('the latch is not extended by repeated same-value events', () => {
  // Dense flips keep ≥3 transitions inside the churn window at every later
  // call; the hold must still end at lastFlip + CHURN_HOLD_MS, not slide
  // forward while the window stays populated.
  let state = decideNetworkStability(false, 0, freshNetworkStability()).state
  let raw = false
  for (let t = 1000; t <= 13000; t += 1000) {
    raw = !raw
    state = decideNetworkStability(raw, t, state).state
  }
  // last flip at 13000 → latch must end at 13000 + CHURN_HOLD_MS = 43000
  const mid = decideNetworkStability(raw, 20000, state)
  assert.equal(mid.latched, true)
  const after = decideNetworkStability(raw, 43001, mid.state)
  assert.equal(after.latched, false, 'the latch ended at lastFlip + CHURN_HOLD_MS')
})

test('a single genuine handoff does not latch', () => {
  const state = decideNetworkStability(false, 0, freshNetworkStability()).state
  const r1 = decideNetworkStability(true, 1000, state)
  assert.equal(r1.latched, false)
  const r2 = decideNetworkStability(true, 1000 + CONFIRM_TO_METERED_MS, r1.state)
  assert.equal(r2.changed, true)
  assert.equal(r2.effective, true)
  assert.equal(r2.latched, false)
})

test('same-value repeats while a candidate pends keep the original clock', () => {
  let state = decideNetworkStability(false, 0, freshNetworkStability()).state
  state = decideNetworkStability(true, 1000, state).state
  for (const t of [1400, 1800]) {
    const v = decideNetworkStability(true, t, state)
    assert.equal(v.state.candidateAt, 1000, `t=${t} did not reset the clock`)
    assert.equal(v.changed, false)
    state = v.state
  }
  const r = decideNetworkStability(true, 1000 + CONFIRM_TO_METERED_MS, state)
  assert.equal(r.changed, true)
})

test('alternating noise never surfaces a flip once latched', () => {
  let state = decideNetworkStability(true, 0, freshNetworkStability()).state // boot metered
  for (let t = 100; t <= 2900; t += 100) {
    const raw = (t / 100) % 2 === 0
    const v = decideNetworkStability(raw, t, state)
    assert.equal(v.effective, true, `t=${t}`)
    assert.equal(v.changed, false)
    state = v.state
  }
  assert.equal(state.suppressed > 0, true, 'noise recorded as suppressed blips')
})

test('transition history is bounded to the churn window', () => {
  let state = decideNetworkStability(false, 0, freshNetworkStability()).state
  // one flip, then 25 s of quiet: the latch must never arm off a stale flip
  state = decideNetworkStability(true, 1000, state).state
  const v = decideNetworkStability(true, 26000, state)
  assert.equal(v.latched, false)
  assert.equal(v.state.transitions.length, 0, 'aged-out flip dropped')
})
