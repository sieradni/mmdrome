// Pins the pure flap-hysteresis core (P5, 2026-09-23): a cellular-bit blip
// must NOT flip the filtered value until it holds FLAP_CONFIRM_MS — the
// 2026-09-23 dump showed `network exp=false → true → false` within ~6 s and
// every effectiveLowData consumer re-derived twice (transcode/preload/queue
// fan-outs). osLowData is deliberately NOT filtered (explicit user toggle).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideCellularFlap, freshNetworkHysteresis, FLAP_CONFIRM_MS } from '../src/lib/networkHysteresis'

test('boot adopts the first raw value immediately (no confirmation delay)', () => {
  const v = decideCellularFlap(true, 1000, freshNetworkHysteresis())
  assert.equal(v.effective, true)
  assert.equal(v.changed, true)
  assert.equal(v.state.candidate, null)
})

test('a blip shorter than FLAP_CONFIRM_MS never commits', () => {
  let state = freshNetworkHysteresis()
  state = decideCellularFlap(false, 0, state).state
  // cellular appears at t=1000
  const r1 = decideCellularFlap(true, 1000, state)
  assert.equal(r1.effective, false, 'not yet confirmed')
  assert.equal(r1.changed, false)
  assert.equal(r1.state.candidate, true)
  state = r1.state
  // still cellular at t=2500 (under the window) — still not committed
  const r2 = decideCellularFlap(true, 1000 + FLAP_CONFIRM_MS - 1, state)
  assert.equal(r2.effective, false)
  assert.equal(r2.changed, false)
  state = r2.state
  // back to wifi at t=3000 — the blip reversed; wifi stays filtered, blip counted
  const r3 = decideCellularFlap(false, 3000, state)
  assert.equal(r3.effective, false)
  assert.equal(r3.changed, false)
  assert.equal(r3.state.suppressed, 1, 'the reversed blip is counted as suppressed')
  assert.equal(r3.state.candidate, null)
})

test('a change that holds FLAP_CONFIRM_MS commits and resets the candidate', () => {
  let state = freshNetworkHysteresis()
  state = decideCellularFlap(false, 0, state).state
  state = decideCellularFlap(true, 1000, state).state
  const r = decideCellularFlap(true, 1000 + FLAP_CONFIRM_MS, state)
  assert.equal(r.effective, true)
  assert.equal(r.changed, true)
  assert.equal(r.state.candidate, null)
  assert.equal(r.state.effective, true)
})

test('a reversed blip restarts nothing: the candidate keeps its original clock', () => {
  let state = freshNetworkHysteresis()
  state = decideCellularFlap(false, 0, state).state
  // cellular blip at 1000, back to wifi at 1500 (raw === effective → cancelled)
  state = decideCellularFlap(true, 1000, state).state
  state = decideCellularFlap(false, 1500, state).state
  assert.equal(state.suppressed, 1)
  // genuine cellular handoff at 5000 — a NEW candidate window starts there
  const r = decideCellularFlap(true, 5000, state)
  assert.equal(r.changed, false)
  assert.equal(r.state.candidateAt, 5000, 'fresh window, not the stale one')
  // commits at 5000 + FLAP_CONFIRM_MS exactly
  const r2 = decideCellularFlap(true, 5000 + FLAP_CONFIRM_MS, r.state)
  assert.equal(r2.changed, true)
  assert.equal(r2.effective, true)
})

test('changed=false events never alter the effective value the caller reads', () => {
  let state = freshNetworkHysteresis()
  state = decideCellularFlap(true, 0, state).state
  // a burst of alternating noise — none of it may surface
  for (let t = 100; t <= 2900; t += 100) {
    const raw = (t / 100) % 2 === 0
    const v = decideCellularFlap(raw, t, state)
    assert.equal(v.effective, true, `t=${t}`)
    assert.equal(v.changed, false)
    state = v.state
  }
  assert.equal(state.suppressed > 0, true, 'noise recorded as suppressed blips')
})

test('same-value repeats while a candidate pends keep the original clock (no extension)', () => {
  let state = freshNetworkHysteresis()
  state = decideCellularFlap(false, 0, state).state
  state = decideCellularFlap(true, 1000, state).state
  // repeated raw=true at 1400, 1800, 2200 — candidate unchanged, clock holds
  for (const t of [1400, 1800, 2200]) {
    const v = decideCellularFlap(true, t, state)
    assert.equal(v.state.candidateAt, 1000, `t=${t} did not reset the clock`)
    assert.equal(v.changed, false)
    state = v.state
  }
  const r = decideCellularFlap(true, 1000 + FLAP_CONFIRM_MS, state)
  assert.equal(r.changed, true)
})
