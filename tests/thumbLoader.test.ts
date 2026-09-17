// Pins the pure thumb-flow policy (`src/lib/thumbFlow.ts`) — the velocity
// gate behind the 2026-09-16 "quickly scrolling" rework. The invariant: the
// loader's distance sort keeps the queue current every frame, but ARMING is
// held while a scroll gesture is recent (and during the one-shot first-mount
// warmup), so the instant a flick ends the first batch armed IS the resting
// view. Arming is TIMING-only policy — it never changes which covers
// download, only their order.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SCROLL_HOLD_MS,
  MIN_ARM_INTERVAL_MS,
  VISIBLE_HOLDOUT_RATIO,
  RETRY_FRAMES,
  thumbFlowSignal,
  planArming,
  shouldHoldZeroSize,
} from '../src/lib/thumbFlow'

/** Drives `thumbFlowSignal` with an explicit clock + scroll bookkeeping. */
function signalAt(opts: {
  now: number
  lastScrollAt?: number
  /** Fraction-of-viewport distance of the nearest queued row. */
  nearestRatio?: number
}) {
  return thumbFlowSignal({
    now: () => opts.now,
    lastScrollAt: () => opts.lastScrollAt ?? 0,
    nearestRatio: () => opts.nearestRatio ?? Infinity,
  })
}

test('no scroll activity: open (arming proceeds)', () => {
  const s = signalAt({ now: 10_000 })
  assert.equal(s.blocked, false)
})

test('a recent scroll event blocks arming for SCROLL_HOLD_MS', () => {
  const now = 10_000
  assert.equal(signalAt({ now, lastScrollAt: now - 1 }).blocked, true)
  assert.equal(signalAt({ now, lastScrollAt: now - SCROLL_HOLD_MS + 1 }).blocked, true)
})

test('the hold decays exactly at SCROLL_HOLD_MS (boundary is exclusive)', () => {
  const now = 10_000
  // At exactly the hold window the gesture is over — arming must resume.
  assert.equal(signalAt({ now, lastScrollAt: now - SCROLL_HOLD_MS }).blocked, false)
  assert.equal(signalAt({ now, lastScrollAt: now - SCROLL_HOLD_MS - 500 }).blocked, false)
})

test('an old scroll timestamp (previous gesture) never blocks', () => {
  const now = 10_000
  assert.equal(signalAt({ now, lastScrollAt: 1 }).blocked, false, 'timestamp 1 is the sentinel-adjacent past, 9_999 ms before now')
  assert.equal(signalAt({ now, lastScrollAt: 0 }).blocked, false, '0 = no scroll this session')
})

test('there is NO mount warmup — a first tick arms the visible tier immediately', () => {
  // The deliberate removal (2026-09-17): warmup delayed even the reading
  // position; the visible tier already bounds what a mount can arm.
  const s = signalAt({ now: 10_000, nearestRatio: 0.1 })
  assert.equal(s.blocked, false)
  assert.equal(s.visible, true)
})

// (The warmup tests were removed with WARMUP_MS — 2026-09-17 trim.)

// --- The visible tier (the slow-scroll fix) --------------------------------

test('the visible tier opens when the nearest row is inside the holdout radius', () => {
  const now = 10_000
  // Nothing queued (Infinity): nothing to arm, tier closed (moot).
  assert.equal(signalAt({ now, nearestRatio: Infinity }).visible, false)
  // Exactly at the radius: open (<=).
  assert.equal(signalAt({ now, nearestRatio: VISIBLE_HOLDOUT_RATIO }).visible, true)
  assert.equal(signalAt({ now, nearestRatio: 0 }).visible, true)
  assert.equal(signalAt({ now, nearestRatio: 0.3 }).visible, true)
  // Just outside: closed.
  assert.equal(signalAt({ now, nearestRatio: VISIBLE_HOLDOUT_RATIO + 0.01 }).visible, false)
})

test('a slow drag: blocked holds the pre-roll, but the visible tier stays open', () => {
  const now = 10_000
  const s = signalAt({ now, lastScrollAt: now - 10, nearestRatio: 0.2 })
  assert.equal(s.blocked, true, 'the gesture is recent — the far pre-roll is held')
  assert.equal(s.visible, true, 'the on-screen tier is open — the reading position never waits')
})

test('a fast flick mid-flight: blocked AND nothing near — both tiers held', () => {
  const now = 10_000
  const s = signalAt({ now, lastScrollAt: now - 10, nearestRatio: 2.5 })
  assert.equal(s.blocked, true)
  assert.equal(s.visible, false)
})

// --- Batch pacing ---------------------------------------------------------

test('the first batch arms immediately (lastArmedAt 0)', () => {
  const plan = planArming(50, 8, 10_000, 0)
  assert.equal(plan.count, 8)
  assert.equal(plan.markArmed, true)
})

test('a batch inside MIN_ARM_INTERVAL_MS plans nothing', () => {
  const last = 10_000
  const plan = planArming(50, 8, last + MIN_ARM_INTERVAL_MS - 1, last)
  assert.equal(plan.count, 0)
  assert.equal(plan.markArmed, false)
})

test('at the interval boundary a new batch arms (boundary is exclusive)', () => {
  const last = 10_000
  const plan = planArming(50, 8, last + MIN_ARM_INTERVAL_MS, last)
  assert.equal(plan.count, 8)
  assert.equal(plan.markArmed, true)
})

test('the batch is capped by MAX_PER_TICK and by availability', () => {
  assert.equal(planArming(3, 8, 10_000, 0).count, 3)
  assert.equal(planArming(0, 8, 10_000, 0).count, 0)
  assert.equal(planArming(0, 8, 10_000, 0).markArmed, false)
})

// --- Zero-size retry deadline ---------------------------------------------

test('zero-size entries hold while retries remain, then give up', () => {
  assert.equal(shouldHoldZeroSize(RETRY_FRAMES), true)
  assert.equal(shouldHoldZeroSize(1), true)
  assert.equal(shouldHoldZeroSize(0), false, 'the deadline drops the entry — the IO re-requests it if it ever lays out')
})

test('RETRY_FRAMES matches the loader historical window (10 frames)', () => {
  assert.equal(RETRY_FRAMES, 10)
})

// --- Composition: the flick scenario end-to-end through the policy -------

test('a fast flick: blocked mid-gesture, then the resting view arms first', () => {
  const t0 = 100_000
  // Gesture events at t0 and t0+120 (a flick's event stream); the queue is
  // all pre-roll (nearest 2.5 vh away — the flick is in flight).
  const mid = signalAt({ now: t0 + 120, lastScrollAt: t0 + 119, nearestRatio: 2.5 })
  assert.equal(mid.blocked, true)
  assert.equal(mid.visible, false)
  // Loader ticks during the gesture plan nothing.
  assert.equal(planArming(120, 8, t0 + 120, 0).markArmed, true, 'pacing alone never blocks — the FLOW verdict does')
  // Momentum decays: at t0+120+SCROLL_HOLD_MS the gate opens.
  const open = signalAt({ now: t0 + 120 + SCROLL_HOLD_MS, lastScrollAt: t0 + 119, nearestRatio: 2.5 })
  assert.equal(open.blocked, false)
  // The resting view (nearest entries) arms in the first post-gesture batch.
  const plan = planArming(120, 8, t0 + 120 + SCROLL_HOLD_MS, 0)
  assert.equal(plan.count, 8)
  assert.equal(plan.markArmed, true)
  // The next batch is paced behind it.
  assert.equal(planArming(112, 8, planBatchAt(t0, 1), planArmedAt(t0)).count, 0)
})

test('a slow drag end-to-end: the visible batch arms mid-gesture, capped to the tier', () => {
  const t0 = 100_000
  // 3 rows on screen (ratios 0.1/0.3/0.45), the rest pre-roll; the gesture
  // keeps firing. The verdict: blocked + visible → arm.
  const mid = signalAt({ now: t0 + 40, lastScrollAt: t0 + 39, nearestRatio: 0.1 })
  assert.equal(mid.blocked, true)
  assert.equal(mid.visible, true)
  // The adapter's cap: blocked arms only the 3 visible-tier rows, not the
  // nearest-8 (which would leak pre-roll rows into the gesture).
  const plan = planArming(3, 8, t0 + 40, 0)
  assert.equal(plan.count, 3)
  assert.equal(plan.markArmed, true)
  // As the drag brings new rows into the tier, the next batch arms them.
  assert.equal(planArming(4, 8, t0 + 40 + MIN_ARM_INTERVAL_MS, t0 + 40).count, 4)
})

/** The wall-clock instant the first post-gesture batch arms (test helper). */
function planArmedAt(t0: number): number {
  return t0 + 120 + SCROLL_HOLD_MS
}
function planBatchAt(t0: number, batch: number): number {
  return planArmedAt(t0) + batch * MIN_ARM_INTERVAL_MS - 1
}
