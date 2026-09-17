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
  GESTURE_VISIBLE_BATCH,
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

test('a slow drag end-to-end: the visible batch arms mid-gesture, capped to the tier AND the gesture pace', () => {
  const t0 = 100_000
  // 3 rows on screen (ratios 0.1/0.3/0.45), the rest pre-roll; the gesture
  // keeps firing. The verdict: blocked + visible → arm (at GESTURE pace).
  const mid = signalAt({ now: t0 + 40, lastScrollAt: t0 + 39, nearestRatio: 0.1 })
  assert.equal(mid.blocked, true)
  assert.equal(mid.visible, true)
  // The adapter's cap: blocked arms only the 3 visible-tier rows, not the
  // nearest-8 (which would leak pre-roll rows into the gesture), paced at
  // SCROLL_HOLD_MS (the 2026-09-17j scrollbar-firehose fix).
  const plan = planArming(3, GESTURE_VISIBLE_BATCH, t0 + 40, 0, SCROLL_HOLD_MS)
  assert.equal(plan.count, 3)
  assert.equal(plan.markArmed, true)
  // As the drag brings new rows into the tier, the next batch arms them —
  // one hold window later, not 33 ms later.
  assert.equal(
    planArming(4, GESTURE_VISIBLE_BATCH, t0 + 40 + SCROLL_HOLD_MS, t0 + 40, SCROLL_HOLD_MS).count,
    4,
  )
  // But NOT inside the gesture-pace window (the firehose fix: a fast drag
  // must not arm one batch per 33 ms while rows keep streaming through the
  // tier).
  assert.equal(
    planArming(4, GESTURE_VISIBLE_BATCH, t0 + 40 + MIN_ARM_INTERVAL_MS, t0 + 40, SCROLL_HOLD_MS)
      .count,
    0,
  )
})

// --- The gesture pace (2026-09-17j, the scrollbar-firehose fix) -------------

test('mid-gesture pace: one GESTURE_VISIBLE_BATCH per SCROLL_HOLD_MS, never faster', () => {
  const t0 = 10_000
  // First mid-gesture batch: immediate.
  assert.equal(planArming(20, GESTURE_VISIBLE_BATCH, t0, 0, SCROLL_HOLD_MS).count, 4)
  // Inside the window: nothing (this is what bounds a scrollbar-style
  // teleport to ~one batch per hold window instead of one per 33 ms).
  assert.equal(planArming(20, GESTURE_VISIBLE_BATCH, t0 + SCROLL_HOLD_MS - 1, t0, SCROLL_HOLD_MS).count, 0)
  // At the boundary: the next 4.
  assert.equal(planArming(16, GESTURE_VISIBLE_BATCH, t0 + SCROLL_HOLD_MS, t0, SCROLL_HOLD_MS).count, 4)
})

test('a scrollbar-style teleport: stale arming is bounded by O(hold windows), not O(screens)', () => {
  // 1.5 s of continuous stamped scrolling at 40 ms/hop (the e2e fling shape):
  // ~38 hops cross ~38 intermediate screens. At the OLD cadence the visible
  // tier re-armed every 33 ms ⇒ ~45 batches × 8 = 360 stale fetches. At the
  // gesture pace the same gesture arms at most 1.5 s / 250 ms ≈ 6 batches ×
  // 4 = 24 rows — and each armed row that leaves the tier is dropped by the
  // loader's 3×vh drop zone anyway.
  const gestureMs = 1500
  const oldBatches = Math.floor(gestureMs / MIN_ARM_INTERVAL_MS)
  const newBatches = Math.floor(gestureMs / SCROLL_HOLD_MS)
  assert.equal(newBatches * GESTURE_VISIBLE_BATCH, 24)
  assert.ok(
    newBatches * GESTURE_VISIBLE_BATCH < oldBatches * 8 / 2,
    'the gesture pace must at least halve mid-gesture arming vs the open cadence',
  )
})

/** The wall-clock instant the first post-gesture batch arms (test helper). */
function planArmedAt(t0: number): number {
  return t0 + 120 + SCROLL_HOLD_MS
}
function planBatchAt(t0: number, batch: number): number {
  return planArmedAt(t0) + batch * MIN_ARM_INTERVAL_MS - 1
}
