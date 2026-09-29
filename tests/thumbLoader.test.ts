// Pins the pure thumb-flow policy (`src/lib/thumbFlow.ts`) — the velocity
// gate behind the 2026-09-16 "quickly scrolling" rework, the 2026-09-17j
// gesture pace, the 2026-09-17 two-lane fresh arming, and the 2026-09-28
// cached-lane stability gate. The invariants:
// - the loader's distance sort keeps the queue current every frame, but ARMING
//   is lane-based: cached rows (revisits) arm at frame cadence while the view
//   is resting or settled; fresh rows split into an on-screen TIER lane (fast
//   cadence) and a BAND lane (a deliberate trickle that never floods a
//   self-hosted server);
// - mid-gesture, arming (fresh AND cached) requires the nearest row's identity
//   to be STABLE — a glide charges nothing, so its landing starts at full speed
//   and its DOM never churns;
// - arming is TIMING-only policy — it never changes which covers download,
//   only their order.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SCROLL_HOLD_MS,
  MIN_ARM_INTERVAL_MS,
  VISIBLE_HOLDOUT_RATIO,
  RETRY_FRAMES,
  OPEN_FRESH_BATCH,
  OPEN_FRESH_INTERVAL_MS,
  STABLE_MIN_MS,
  TIER_BATCH,
  CACHED_TIER_BATCH,
  CACHED_BAND_BATCH,
  thumbFlowSignal,
  planFreshArming,
  planCachedArming,
  shouldHoldZeroSize,
} from '../src/lib/thumbFlow'

/** A deps object with an explicit, caller-controlled nearest identity — the
 *  two-tap shape: call the signal twice with the same id to assert stability.
 *  (The signal records what its deps hand it, so consecutive calls form the
 *  comparison.) Fresh object per call is fine — the baseline is module state,
 *  not deps state. */
function signalWithId(opts: { now: number; lastScrollAt?: number; nearestRatio?: number; id?: unknown }) {
  return thumbFlowSignal({
    now: () => opts.now,
    lastScrollAt: () => opts.lastScrollAt ?? 0,
    nearestRatio: () => opts.nearestRatio ?? Infinity,
    lastNearestId: () => opts.id,
  })
}

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

// --- Zero-size retry deadline ---------------------------------------------

test('zero-size entries hold while retries remain, then give up', () => {
  assert.equal(shouldHoldZeroSize(RETRY_FRAMES), true)
  assert.equal(shouldHoldZeroSize(1), true)
  assert.equal(shouldHoldZeroSize(0), false, 'the deadline drops the entry — the IO re-requests it if it ever lays out')
})

test('RETRY_FRAMES matches the loader historical window (10 frames)', () => {
  assert.equal(RETRY_FRAMES, 10)
})

// --- The two-lane fresh-arming planner (open gate) --------------------------
// Pins the 2026-09-17 resource-timing diagnostic: on-screen requests started
// promptly, but the old single queue flooded ~90 fresh fetches out behind
// them at the full cadence and a self-hosted server served the burst slowly
// enough that even the SCREEN's covers landed late ("still 5 s to load").
// The fix: two lanes with independent clocks — the tier at the fast cadence,
// the band as a trickle; the screen is never behind the band.

test('the TIER lane arms first at the fast cadence (the screen never waits)', () => {
  const t0 = 10_000
  // First arm: immediate (clock 0), capped at TIER_BATCH.
  const plan = planFreshArming({ blocked: false, visible: true, nearestStable: false, tierCount: 50, bandCount: 90, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(plan.tierArmed, true)
  assert.equal(plan.count, TIER_BATCH)
  assert.equal(plan.bandArmed, false, 'the band lane does not run on a tier tick — the pool belongs to the screen first')
  assert.equal(plan.tierArmAt, t0)
})

test('the TIER lane is paced by MIN_ARM_INTERVAL_MS', () => {
  const last = 10_000
  const plan = planFreshArming({ blocked: false, visible: true, nearestStable: false, tierCount: 50, bandCount: 0, now: last + MIN_ARM_INTERVAL_MS - 1, lastTierArmAt: last, lastBandArmAt: 0 })
  assert.equal(plan.tierArmed, false)
  assert.equal(plan.count, 0, 'inside the tier window: nothing (bandCount 0 isolates the tier lane)')
  const ready = planFreshArming({ blocked: false, visible: true, nearestStable: false, tierCount: 50, bandCount: 0, now: last + MIN_ARM_INTERVAL_MS, lastTierArmAt: last, lastBandArmAt: 0 })
  assert.equal(ready.tierArmed, true)
  assert.equal(ready.count, TIER_BATCH)
})

test('the BAND lane trickles: OPEN_FRESH_BATCH per OPEN_FRESH_INTERVAL_MS, only when the tier is quiet', () => {
  const t0 = 10_000
  // Tier empty → the band lane owns the tick. First arm immediate.
  const plan = planFreshArming({ blocked: false, visible: false, nearestStable: false, tierCount: 0, bandCount: 90, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(plan.bandArmed, true)
  assert.equal(plan.count, OPEN_FRESH_BATCH)
  assert.equal(plan.bandArmAt, t0)
  // Inside the trickle window: nothing — this is the anti-flood bound (~90
  // rows take ~2.8 s to LAUNCH, letting the server drain between batches).
  const held = planFreshArming({ blocked: false, visible: false, nearestStable: false, tierCount: 0, bandCount: 82, now: t0 + OPEN_FRESH_INTERVAL_MS - 1, lastTierArmAt: 0, lastBandArmAt: t0 })
  assert.equal(held.bandArmed, false)
  // At the boundary: the next trickle batch.
  const next = planFreshArming({ blocked: false, visible: false, nearestStable: false, tierCount: 0, bandCount: 82, now: t0 + OPEN_FRESH_INTERVAL_MS, lastTierArmAt: 0, lastBandArmAt: t0 })
  assert.equal(next.bandArmed, true)
  assert.equal(next.count, OPEN_FRESH_BATCH)
})

test('a landing tier batch never delays the band clock (independent lanes)', () => {
  const t0 = 10_000
  // Tier arms at t0; the band was last armed at t0-250+1 (its window is up).
  const plan = planFreshArming({ blocked: false, visible: true, nearestStable: false, tierCount: 4, bandCount: 90, now: t0, lastTierArmAt: 0, lastBandArmAt: t0 - OPEN_FRESH_INTERVAL_MS + 1 })
  assert.equal(plan.tierArmed, true)
  // The band clock is UNTOUCHED by the tier arm (it was not ready this tick,
  // but the tier arm does not push it back either).
  assert.equal(plan.bandArmAt, t0 - OPEN_FRESH_INTERVAL_MS + 1)
})

test('a fresh band arm defers to a ready tier on the same tick', () => {
  const t0 = 20_000
  // Tier ready (clock 0) AND band ready (clock 0): the tier wins the tick.
  const plan = planFreshArming({ blocked: false, visible: true, nearestStable: false, tierCount: 3, bandCount: 90, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(plan.tierArmed, true)
  assert.equal(plan.bandArmed, false)
})

test('the fresh planner is capped by availability', () => {
  const t0 = 30_000
  const tier = planFreshArming({ blocked: false, visible: true, nearestStable: false, tierCount: 3, bandCount: 0, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(tier.count, 3)
  const band = planFreshArming({ blocked: false, visible: false, nearestStable: false, tierCount: 0, bandCount: 2, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(band.count, 2)
  const none = planFreshArming({ blocked: false, visible: true, nearestStable: false, tierCount: 0, bandCount: 0, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(none.count, 0)
  assert.equal(none.tierArmed, false)
  assert.equal(none.bandArmed, false)
})

// --- Mid-gesture fresh arming: the STABILITY gate ----------------------------
// The stronger form of the old settle-expiry waive: a glide's churning
// nearest-row identity arms NOTHING fresh mid-flight, so no stale fetch is
// ever launched and the landing starts at full speed because its lane clocks
// were never charged. A slow drag (identity stable between hops) still arms
// its reading position at the gesture pace.

test('mid-gesture with churning identity: NOTHING fresh arms (no stale fetches)', () => {
  const t0 = 100_000
  const plan = planFreshArming({ blocked: true, visible: true, nearestStable: false, tierCount: 4, bandCount: 90, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(plan.count, 0)
  assert.equal(plan.tierArmed, false)
  assert.equal(plan.bandArmed, false, 'the band never arms mid-gesture at all')
})

test('mid-gesture with a STABLE reading position: the landing arms at the full open tier cadence', () => {
  const t0 = 100_000
  // First arm: immediate (clock 0), full TIER_BATCH — the view is stationary,
  // so this IS the settle screen; the hold window never throttles it.
  const plan = planFreshArming({ blocked: true, visible: true, nearestStable: true, tierCount: 20, bandCount: 90, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(plan.tierArmed, true)
  assert.equal(plan.count, TIER_BATCH)
  assert.equal(plan.tierArmAt, t0)
  // The next tier batch is paced only by the normal 33 ms cadence — the hold
  // window never throttles a stable view.
  const next = planFreshArming({ blocked: true, visible: true, nearestStable: true, tierCount: 12, bandCount: 90, now: t0 + MIN_ARM_INTERVAL_MS, lastTierArmAt: t0, lastBandArmAt: 0 })
  assert.equal(next.count, TIER_BATCH)
})

test('mid-gesture without the tier open: nothing (rows far away wait for settle)', () => {
  const t0 = 110_000
  const plan = planFreshArming({ blocked: true, visible: false, nearestStable: true, tierCount: 0, bandCount: 90, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(plan.count, 0)
  assert.equal(plan.bandArmed, false)
})

test('a scrollbar-style teleport now arms ZERO stale fetches mid-gesture', () => {
  // The old gesture PACE bounded mid-gesture arming to ~24 rows per 1.5 s of
  // continuous scrolling; the stability gate eliminates it entirely — during
  // a teleport the nearest identity churns every hop (never stable), so the
  // firehose is not paced, it is CLOSED. The landing screen arms the moment
  // the gesture stops because the fresh clocks were never charged.
  const gestureMs = 1500
  const oldPacedBatches = Math.floor(gestureMs / SCROLL_HOLD_MS)
  let armed = 0
  for (let t = 0; t <= gestureMs; t += SCROLL_HOLD_MS) {
    const plan = planFreshArming({ blocked: true, visible: true, nearestStable: false, tierCount: 4, bandCount: 90, now: t, lastTierArmAt: 0, lastBandArmAt: 0 })
    armed += plan.count
  }
  assert.equal(armed, 0)
  assert.ok(armed < oldPacedBatches * 4, 'strictly better than the paced bound it replaces')
})

// --- The landing (the subsumed settle-expiry) --------------------------------

test('tap-stopped flick: the landing arms at full speed on the next frame', () => {
  const t0 = 400_000
  // Mid-glide: scroll stamped at t0+119, nearest identity churning — nothing
  // fresh arms, no lane clock is charged.
  signalWithId({ now: t0 + 120, id: 'row-x', nearestRatio: 2.5, lastScrollAt: t0 + 119 })
  const midPlan = planFreshArming({ blocked: true, visible: false, nearestStable: false, tierCount: 0, bandCount: 90, now: t0 + 120, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(midPlan.count, 0)
  // Tap at t0+150 stops the gesture; the landing row settles in the tier.
  const landing = signalWithId({ now: t0 + 160, id: 'row-y', nearestRatio: 0.1, lastScrollAt: t0 + 119 })
  assert.equal(landing.blocked, true, 'the hold window still runs — the gesture only just stopped')
  assert.equal(landing.visible, true, 'the landing row is on screen')
  assert.equal(landing.nearestStable, false, 'first landing verdict — baseline was row-x')
  // The landing screen arms DESPITE the still-running hold window — the whole
  // point of the stability gate. The identity must persist STABLE_MIN_MS
  // (2026-09-28: a bare two-tick compare armed every 50 ms fling hop gap —
  // the firehose returned un-masked once the unlatch freeze shipped), so the
  // landing arms at the first verdict ≥100 ms after the identity settled.
  // Full TIER_BATCH, immediately (clock 0 — never charged mid-flight).
  const settled = signalWithId({ now: t0 + 270, id: 'row-y', nearestRatio: 0.1, lastScrollAt: t0 + 119 })
  assert.equal(settled.blocked, true, 'the hold window still runs — the gesture only just stopped')
  assert.equal(settled.visible, true)
  assert.equal(settled.nearestStable, true, '110 ms of stable identity clears STABLE_MIN_MS')
  const plan = planFreshArming({ blocked: settled.blocked, visible: settled.visible, nearestStable: settled.nearestStable, tierCount: 12, bandCount: 78, now: t0 + 270, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(plan.tierArmed, true, 'the landing screen arms while the hold window still runs')
  assert.equal(plan.count, TIER_BATCH)
  // The band lane waits — the screen empties first.
  assert.equal(plan.bandArmed, false)
})

test('a mid-gesture slow drag still arms its reading position (stable identity)', () => {
  const t0 = 500_000
  // A slow touch drag: rows move gradually, the nearest row is stable for
  // well over STABLE_MIN_MS between hops, and the tier is open. The reading
  // position loads at the gesture pace — all later, never never.
  signalWithId({ now: t0, id: 'row-a', nearestRatio: 0.2, lastScrollAt: t0 - 1 })
  const stable = signalWithId({ now: t0 + 150, id: 'row-a', nearestRatio: 0.15, lastScrollAt: t0 + 149 })
  assert.equal(stable.nearestStable, true, '150 ms of one row is a reading position, not churn')
  const plan = planFreshArming({ blocked: stable.blocked, visible: stable.visible, nearestStable: stable.nearestStable, tierCount: 5, bandCount: 40, now: t0 + 150, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(plan.tierArmed, true)
  assert.equal(plan.count, 5, 'capped by availability — 5 tier rows, not the full batch')
})

// --- Constants sanity --------------------------------------------------------

test('the lane constants keep the screen strictly ahead of the band', () => {
  // The tier lane empties a screenful (≥8 rows) in ~2 frames while the band
  // launches 8 per 250 ms — the screen is never queued behind the trickle.
  assert.equal(TIER_BATCH, 8)
  assert.equal(OPEN_FRESH_BATCH, 8)
  assert.ok(OPEN_FRESH_INTERVAL_MS > MIN_ARM_INTERVAL_MS * 4, 'the band trickle must be strictly slower than the tier cadence')
  assert.equal(CACHED_TIER_BATCH, 8)
  assert.equal(CACHED_BAND_BATCH, 8)
})

// --- The cached-lane planner (2026-09-28, the scroll-churn fix) --------------
// The cached lanes armed at the RAW frame cadence in ANY flow state, and
// during a fling the nearest row is ALWAYS inside the viewport — so the
// tier-cached lane armed 8 imgs per frame mid-glide while the unlatch
// observer unmounted the ones flying past. The 4× CPU A/B e2e measured p50
// frame 177 ms with ~68 img flips per 6 s sweep, and p50 17 ms (worst 20)
// with the cover observers disabled: the MOUNT/UNMOUNT churn was the jank,
// not the row paint. The cached lanes now key on the SAME identity-stability
// signal as the fresh lanes: a resting/settled/stable view arms at frame
// cadence; a glide arms nothing. A cached cover is free to load; mounting its
// <img> mid-flight is not free to render.

test('cached tier arms at the fast cadence while the view is resting (open gate)', () => {
  const t0 = 40_000
  const plan = planCachedArming({ blocked: false, nearestStable: false, tierCount: 30, bandCount: 0, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(plan.tierArmed, true)
  assert.equal(plan.count, CACHED_TIER_BATCH)
  assert.equal(plan.bandArmed, false, 'the band lane does not run on a tier tick')
})

test('cached tier arm is paced by MIN_ARM_INTERVAL_MS', () => {
  const t0 = 40_000
  const held = planCachedArming({ blocked: false, nearestStable: false, tierCount: 30, bandCount: 0, now: t0 + MIN_ARM_INTERVAL_MS - 1, lastTierArmAt: t0, lastBandArmAt: 0 })
  assert.equal(held.tierArmed, false)
  const ready = planCachedArming({ blocked: false, nearestStable: false, tierCount: 30, bandCount: 0, now: t0 + MIN_ARM_INTERVAL_MS, lastTierArmAt: t0, lastBandArmAt: 0 })
  assert.equal(ready.tierArmed, true)
  assert.equal(ready.count, CACHED_TIER_BATCH)
})

test('mid-gesture churning identity arms NOTHING cached (the pump is closed)', () => {
  // The regression pin: the old lane armed here because the cached rows were
  // 'free' — but each arm mounts an <img>, and the unlatch unmounts it a
  // frame later. The churn is the cost the free-ness ignored.
  const t0 = 50_000
  const plan = planCachedArming({ blocked: true, nearestStable: false, tierCount: 20, bandCount: 40, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(plan.tierArmed, false)
  assert.equal(plan.bandArmed, false)
  assert.equal(plan.count, 0)
})

test('mid-gesture STABLE view arms cached revisits (tap-stop landing stays instant)', () => {
  const t0 = 50_000
  const plan = planCachedArming({ blocked: true, nearestStable: true, tierCount: 12, bandCount: 40, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(plan.tierArmed, true)
  assert.equal(plan.count, Math.min(12, CACHED_TIER_BATCH))
  assert.equal(plan.bandArmed, false, 'the pre-warm band never arms mid-gesture')
})

test('the cached pre-warm band arms only when the gate is open and the tier lane is quiet', () => {
  const t0 = 60_000
  const plan = planCachedArming({ blocked: false, nearestStable: false, tierCount: 0, bandCount: 25, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(plan.bandArmed, true)
  assert.equal(plan.count, CACHED_BAND_BATCH)
  const heldMidGesture = planCachedArming({ blocked: true, nearestStable: true, tierCount: 0, bandCount: 25, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(heldMidGesture.bandArmed, false)
})

test('a cached tier arm does not charge the band clock (independent lanes)', () => {
  const t0 = 60_000
  const plan = planCachedArming({ blocked: false, nearestStable: false, tierCount: 4, bandCount: 25, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(plan.tierArmed, true)
  assert.equal(plan.bandArmAt, 0, 'the band clock is untouched')
})

test('the cached planner is capped by availability', () => {
  const t0 = 70_000
  const tier = planCachedArming({ blocked: false, nearestStable: false, tierCount: 3, bandCount: 0, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(tier.count, 3)
  const none = planCachedArming({ blocked: true, nearestStable: false, tierCount: 0, bandCount: 0, now: t0, lastTierArmAt: 0, lastBandArmAt: 0 })
  assert.equal(none.count, 0)
  assert.equal(none.tierArmed, false)
  assert.equal(none.bandArmed, false)
})

// --- STABLE_MIN_MS: the teleport-with-gaps hole (2026-09-28) ----------------
// A scrollbar/fling profile hops ~12 screens every ~50 ms. Between hops the
// view is genuinely stationary for 2–3 rAF frames — the bare two-tick
// identity compare read each gap as a landing and armed a fresh batch there
// (~8 stale fetches per hop). The original unlatch teardown MASKED this by
// unmounting the stale covers mid-flight; the gesture-time DOM freeze removed
// the mask, the queueflood/thumbflow e2e caught the regression, and the
// duration floor is the honest fix.

test('a 50 ms fling hop gap never reaches stability (the firehose stays closed)', () => {
  const t0 = 800_000
  // Hop 1: identity appears.
  signalWithId({ now: t0, id: 'row-1', nearestRatio: 0.2, lastScrollAt: t0 - 1 })
  // 50 ms later the next hop replaces it.
  signalWithId({ now: t0 + 50, id: 'row-2', nearestRatio: 0.2, lastScrollAt: t0 + 49 })
  // Hop 3 lands on row-3 and sits for the full between-hop gap... then flies
  // on. Even two consecutive verdicts 60 ms apart must NOT read stable.
  signalWithId({ now: t0 + 100, id: 'row-3', nearestRatio: 0.2, lastScrollAt: t0 + 99 })
  const gap = signalWithId({ now: t0 + 160, id: 'row-3', nearestRatio: 0.2, lastScrollAt: t0 + 99 })
  assert.equal(gap.nearestStable, false, '60 ms of stability is a hop gap, not a reading position')
  // The same row 100+ ms after first appearance IS stable.
  const settled = signalWithId({ now: t0 + 210, id: 'row-3', nearestRatio: 0.2, lastScrollAt: t0 + 99 })
  assert.equal(settled.nearestStable, true)
  assert.equal(settled.stableMs >= 100, true)
})

test('the stability clock restarts on every identity change', () => {
  const t0 = 810_000
  signalWithId({ now: t0, id: 'row-a', nearestRatio: 0.1, lastScrollAt: t0 - 1 })
  const grown = signalWithId({ now: t0 + 200, id: 'row-a', nearestRatio: 0.1, lastScrollAt: t0 - 1 })
  assert.equal(grown.nearestStable, true)
  // A new identity restarts the clock from zero.
  const moved = signalWithId({ now: t0 + 210, id: 'row-b', nearestRatio: 0.1, lastScrollAt: t0 + 209 })
  assert.equal(moved.nearestStable, false)
  assert.equal(moved.stableMs, 0)
})

test('STABLE_MIN_MS stays far below the perceived-instant budget', () => {
  // The gate this floor serves was written against a 200–300 ms delay report;
  // the floor must never approach that, and no 50 ms hop gap may survive it.
  assert.equal(STABLE_MIN_MS, 100)
  assert.ok(STABLE_MIN_MS < 200)
})
