/**
 * Pure thumb-flow policy (F2): the velocity-gated arming state machine behind
 * `thumbLoader.ts`. DOM-free and clock-injectable so the whole decision surface
 * is unit-pinned; the loader adapter only reads rects and executes the plan.
 *
 * Problem this solves (the "user quickly scrolling" report): arming was
 * one-way — a flick queued rows several screens ahead (IO 800 px pre-roll) and
 * armed them mid-flight, so covers for rows the user already flew past raced
 * the rows now on screen for connection slots. Holding arming while scrolling
 * lets the per-frame distance sort stay current, so the instant the flick ends
 * the FIRST batch armed is the resting view.
 *
 * Deliberate shape of the signal: scroll-event TIMING, not a px/s velocity
 * estimate. A scroll gesture = a stream of scroll events (any speed); a resting
 * view emits none. An estimate adds state without adding a decision — every
 * interesting branch is already covered by "recent scroll events" vs "none".
 * This also means a slow held drag holds correctly (the view isn't resting)
 * and momentum/keyboard paging hold too.
 *
 * ONE exception to the hold (2026-09-17, the "slow scrolling shows
 * placeholders" re-review): the screen the user is LOOKING at must never wait
 * for the gesture to end. Arming splits into two distance tiers — rows whose
 * center is within half a viewport of center (i.e. fully on screen) arm
 * IMMEDIATELY even mid-gesture ("load what I can see" is always correct),
 * while the far pre-roll stays held until the motion stops. A slow drag thus
 * paints at the reading position continuously; a fast flick fills the settled
 * screen in the first post-stop batch and pre-rolls only after.
 */

/**
 * How long arming stays blocked after the LAST scroll event. A flick's event
 * stream runs 150–300 ms; 250 ms doesn't re-open mid-glide but feels instant
 * when the gesture stops.
 */
export const SCROLL_HOLD_MS = 250

/**
 * Minimum wall-clock gap between armed batches. While open, this reproduces
 * the old 8-per-frame cadence (a frame is ≥16 ms) but survives an
 * environment where frames are long (backgrounded rAF) without hammering.
 * It gates BATCHES, not the tick loop — a resting page keeps its per-frame
 * housekeeping cadence.
 */
export const MIN_ARM_INTERVAL_MS = 33

/**
 * The visible-holdout radius, as a fraction of viewport height from center.
 * Widened 2026-09-17 from 0.5 to 1.0 (the "placeholders flash at the screen
 * edges during slow scrolls" report): at 0.5 only the middle half of the
 * screen armed mid-gesture — rows entering at the edges showed unloaded for a
 * beat even on slow drags. At 1.0 the tier is "everything on screen": any row
 * whose center is within a viewport of the center is at least partially
 * visible. The firehose protection is UNTOUCHED by this — mid-gesture fresh
 * arming is capped by GESTURE_FRESH_BATCH per hold window (see
 * planFreshArming); the scrollbar-teleport bound (O(hold windows), not
 * O(screens)) comes from the PACE, not the tier size. What grows with the
 * tier is how much of the current screen arms promptly — which is the point.
 */
export const VISIBLE_HOLDOUT_RATIO = 1.0

export interface ThumbFlowState {
  /** Recent scroll activity (gesture or momentum) — the far pre-roll is held. */
  blocked: boolean
  /** The visible-holdout tier is OPEN (the nearest queued row is inside the
   *  holdout radius). When true, the adapter may arm the nearest batch even
   *  while `blocked`. */
  visible: boolean
  /** How long the nearest queued row's identity has been UNCHANGED (ms; 0
   *  when nothing is queued or the identity just changed). The mid-gesture
   *  arming gate compares this against STABLE_MIN_MS — see the constant's
   *  comment for why a bare identity compare is not enough. */
  stableMs: number
  /** Convenience: stableMs >= STABLE_MIN_MS. Kept alongside the raw value so
   *  the debug snapshot can show both. */
  nearestStable: boolean
}

export interface ThumbFlowDeps {
  now(): number
  /** Tracked scroll activity, as the timestamp of the last scroll event
   *  (0 = none this session). The adapter feeds it from its listener. */
  lastScrollAt(): number
  /** Distance of the NEAREST queued row from the viewport center, as a
   *  FRACTION of viewport height (the adapter measures rects per tick;
   *  Infinity when nothing is queued). The `visible` tier compares this
   *  against VISIBLE_HOLDOUT_RATIO. */
  nearestRatio(): number
  /** Identity of the nearest queued row (the adapter's element). Changes
   *  whenever the viewport flies past rows — the sole input that separates a
   *  scrollbar-style teleport (identity churns every hop) from a resting view
   *  (identity stays put). Absent → `nearestStable` is always false and
   *  `stableMs` is 0. */
  lastNearestId?(): unknown
}

/**
 * Whether a scroll gesture is ACTIVE right now (a scroll event within the
 * last `SCROLL_HOLD_MS`) — the gesture-time DOM freeze's signal, exported for
 * LazyThumb's unlatch deferral. Reads wall clock against the last activity
 * timestamp; the loader owns the listener and stamps it.
 */
export function thumbFlowGestureActive(): boolean {
  if (lastScrollStamp <= 0) return false
  return Date.now() - lastScrollStamp < SCROLL_HOLD_MS
}

/** The single shared scroll stamp (stamped by the loader's scroll listener;
 *  thumbFlow.ts itself stays DOM-free). */
let lastScrollStamp = 0

/** Called by the loader's scroll listener — the one writer of the stamp. */
export function noteScrollActivity(): void {
  lastScrollStamp = Date.now()
}

/**
 * How long the nearest row's identity must stay UNCHANGED before a
 * mid-gesture view counts as a stationary reading position (the
 * `nearestStable` verdict). A bare two-tick identity compare (the original
 * 2026-09-17 settle-expiry form) is too weak for TELEPORT-WITH-GAPS: a
 * scrollbar/fling profile hops ~12 screens every ~50 ms, and between hops the
 * view is genuinely stationary for 2–3 rAF frames — the bare compare read
 * each gap as a "landing" and armed a fresh batch there (~8 stale fetches
 * per hop; measured 2026-09-28 once the unlatch teardown stopped masking
 * it). A real reading position — a slow drag's pauses, a tap-stopped flick's
 * landing — persists for hundreds of ms, and the original complaint this
 * gate serves was a 200–300 ms delay, so 100 ms stays far inside the
 * perceived-instant budget while no momentum hop gap survives it.
 */
export const STABLE_MIN_MS = 100

/** The identity the previous verdict saw. INTERNAL: `thumbFlowSignal` updates
 *  it after every verdict (the compare-then-record order makes consecutive
 *  signal calls a proper two-tap comparison); pure callers never touch it. */
let lastSeenNearestId: unknown

/** Wall-clock instant the current nearest identity FIRST appeared (the
 *  stability clock). INTERNAL to `thumbFlowSignal`, same contract as
 *  `lastSeenNearestId`. */
let identityStableSince = 0

/**
 * The verdict for one tick. `blocked` = (now − lastScrollAt) < SCROLL_HOLD_MS;
 * `visible` = the nearest queued row sits inside the holdout radius — the
 * "user is looking at it" tier that opens even mid-gesture. There is
 * deliberately NO mount warmup: the visible tier already bounds what a mount
 * can arm (only rows actually near the viewport), so a first tick arms the
 * reading position immediately and the far pre-roll only after stillness.
 */
export function thumbFlowSignal(deps: ThumbFlowDeps): ThumbFlowState {
  const now = deps.now()
  const blocked = deps.lastScrollAt() > 0 && now - deps.lastScrollAt() < SCROLL_HOLD_MS
  const visible = deps.nearestRatio() <= VISIBLE_HOLDOUT_RATIO
  const id = deps.lastNearestId?.()
  // Duration-carrying stability: when the identity CHANGES (or first
  // appears), restart the stability clock. A repeated id accumulates stableMs
  // — two consecutive verdicts with the same id are only "stable" once the
  // clock exceeds STABLE_MIN_MS.
  if (id === undefined || id !== lastSeenNearestId) identityStableSince = now
  const stableMs = id !== undefined && identityStableSince > 0 ? now - identityStableSince : 0
  const nearestStable = stableMs >= STABLE_MIN_MS
  // Record THIS verdict's identity as the next call's baseline (compare-
  // then-record: consecutive calls form the two-tap comparison). An extra
  // signal call with the same deps (the debug snapshot re-derives the verdict)
  // is idempotent — same id in, same baseline out.
  lastSeenNearestId = id
  return { blocked, visible, stableMs, nearestStable }
}

export interface ArmPlan {
  /** How many entries to arm this tick (0 = hold). */
  count: number
  /** Whether the batch bookkeeping should remember this tick as armed. */
  markArmed: boolean
}
/** Fresh-arming pace while the gate is OPEN: rows per batch / ms between
 *  batches. 8 per 250 ms — a TRICKLE, deliberately slower than the old full
 *  cadence (8 per 33 ms). The resource-timing diagnostic measured why: after
 *  a far teleport the old cadence flooded ~90 getCoverArt requests in half a
 *  second and a self-hosted Navidrome serves that burst slowly (resize
 *  cache, disk) — even the ON-SCREEN covers sat behind the server's work, the
 *  "still 5 s to load" report. The band trickle-loads from the screen
 *  outward; the screen itself never waits behind it (the tier lane below). */
export const OPEN_FRESH_BATCH = 8
export const OPEN_FRESH_INTERVAL_MS = 250

/** Fresh-arming pace for the TIER lane (the rows the user is looking at):
 *  one batch per MIN_ARM_INTERVAL_MS while the gate is open — cadence
 *  priority over the band lane, so the screen is never queued behind the
 *  pre-roll trickle. */
export const TIER_BATCH = 8

/** Cached-lane pace (2026-09-28, the "songs tab lags when scrolling" field
 *  report): the cached lanes previously armed at the raw frame cadence in ANY
 *  flow state — and during a fling the nearest row is ALWAYS inside the
 *  viewport, so the tier-cached lane armed 8 imgs per frame mid-glide while
 *  the unlatch observer unmounted the ones flying past. The A/B e2e measured
 *  the result on a 2,400-row list at 4× CPU: p50 frame 177 ms with ~68 img
 *  mount/unmount flips per 6 s sweep — and p50 17 ms (60 fps, worst 20) with
 *  the cover observers disabled. Same list, same scroll. The churn, not the
 *  row paint, WAS the jank. The gate below applies the SAME identity-stability
 *  rule the fresh lane already uses: a resting or settled view arms its
 *  cached revisits at frame cadence (the pop-in fix keeps working — a tap-
 *  stopped flick's nearest row is stable), but a glide arms nothing until the
 *  gesture settles. A cached cover is free to LOAD; mounting its <img> mid-
 *  flight is not free to RENDER. */
export const CACHED_TIER_BATCH = 8
export const CACHED_BAND_BATCH = 8

export interface CachedArmingInputs {
  /** The flow verdict for this tick (the scroll-activity gate). */
  blocked: boolean
  /** The nearest queued row's identity is stable (view is stationary
   *  relative to the queue — resting, landed, or a slow drag's reading
   *  position). Same signal the fresh tier lane gates on. */
  nearestStable: boolean
  /** Cached rows waiting INSIDE the tier (on-screen holdout). */
  tierCount: number
  /** Cached rows waiting OUTSIDE the tier (pre-warm band). */
  bandCount: number
  /** Wall clock now / last cached tier-lane arm / last cached band-lane arm
   *  (0 = never). */
  now: number
  lastTierArmAt: number
  lastBandArmAt: number
}

export interface CachedArmingPlan {
  count: number
  tierArmed: boolean
  bandArmed: boolean
  tierArmAt: number
  bandArmAt: number
}

/**
 * The cached-lane planner: on-screen cached revisits arm at the frame cadence
 * (MIN_ARM_INTERVAL_MS batches) whenever the view is resting, settled, or a
 * stable reading position — mid-gesture arming requires `nearestStable`, so a
 * fling's churn arms nothing and the mount/unmount pump stops. The band lane
 * (scroll-back pre-warm) stays a not-blocked-only lane: it is the lowest
 * priority, runs after the fresh lanes, and never arms mid-gesture.
 */
export function planCachedArming(inputs: CachedArmingInputs): CachedArmingPlan {
  const plan: CachedArmingPlan = {
    count: 0,
    tierArmed: false,
    bandArmed: false,
    tierArmAt: inputs.lastTierArmAt,
    bandArmAt: inputs.lastBandArmAt,
  }
  const tierReady =
    inputs.tierCount > 0 &&
    (inputs.lastTierArmAt === 0 || inputs.now - inputs.lastTierArmAt >= MIN_ARM_INTERVAL_MS)
  const bandReady =
    inputs.bandCount > 0 &&
    (inputs.lastBandArmAt === 0 || inputs.now - inputs.lastBandArmAt >= MIN_ARM_INTERVAL_MS)

  if (tierReady && (!inputs.blocked || inputs.nearestStable)) {
    plan.count = Math.min(inputs.tierCount, CACHED_TIER_BATCH)
    plan.tierArmed = true
    plan.tierArmAt = inputs.now
    return plan
  }
  if (bandReady && !inputs.blocked) {
    plan.count = Math.min(inputs.bandCount, CACHED_BAND_BATCH)
    plan.bandArmed = true
    plan.bandArmAt = inputs.now
    return plan
  }
  return plan
}

export interface FreshArmingInputs {
  /** The flow verdict for this tick. */
  blocked: boolean
  visible: boolean
  nearestStable: boolean
  /** Fresh (uncached) rows waiting INSIDE the tier (on-screen holdout). */
  tierCount: number
  /** Fresh rows waiting OUTSIDE the tier (pre-roll band + far). */
  bandCount: number
  /** Wall clock now / last tier-lane arm / last band-lane arm (0 = never). */
  now: number
  lastTierArmAt: number
  lastBandArmAt: number
}

export interface FreshArmingPlan {
  /** Fresh rows to arm this tick; the caller executes nearest-first. */
  count: number
  tierArmed: boolean
  bandArmed: boolean
  /** Arm instants the caller must persist for the next tick. */
  tierArmAt: number
  bandArmAt: number
}

/**
 * The two-lane fresh-arming planner (2026-09-17, the resource-timing
 * diagnostic: on-screen requests DID start promptly after settle — but 43
 * more flooded out behind them at the full cadence, and a self-hosted server
 * serves a 90-request burst slowly enough that the screen's covers landed
 * late anyway). Replaces the single-queue `planArming`.
 *
 * TWO LANES by urgency, NOT one queue:
 * - TIER (on-screen): one TIER_BATCH per MIN_ARM_INTERVAL_MS — cadence
 *   priority. The screen never waits behind the band.
 * - BAND (pre-roll and beyond): one OPEN_FRESH_BATCH per 250 ms — a trickle
 *   that keeps the pool warm and lead time growing without flooding the
 *   server. Runs only on a tick where the tier lane did NOT arm (the pool
 *   belongs to the screen first).
 * Cached rows are NOT planned here — the loader executes them on a separate
 * fast path (a cached cover needs no network; pacing a free operation was
 * the pop-in mechanism).
 *
 * MID-GESTURE (`blocked`): fresh arming only while `nearestStable` and
 * `visible`, at the SAME open tier cadence — the stability gate IS the pace:
 * a stationary view (tap-stopped flick landing, slow drag's reading position)
 * arms at full speed because nothing stale was fetched mid-flight, and a
 * glide's churning identity arms NOTHING (the scrollbar-firehose is closed,
 * not paced). No gesture-specific constant survives.
 */
export function planFreshArming(inputs: FreshArmingInputs): FreshArmingPlan {
  const plan: FreshArmingPlan = {
    count: 0,
    tierArmed: false,
    bandArmed: false,
    tierArmAt: inputs.lastTierArmAt,
    bandArmAt: inputs.lastBandArmAt,
  }

  const tierReady =
    inputs.tierCount > 0 &&
    (inputs.lastTierArmAt === 0 || inputs.now - inputs.lastTierArmAt >= MIN_ARM_INTERVAL_MS)
  const bandReady =
    inputs.bandCount > 0 &&
    (inputs.lastBandArmAt === 0 || inputs.now - inputs.lastBandArmAt >= OPEN_FRESH_INTERVAL_MS)

  if (inputs.blocked) {
    // Mid-gesture: only a STABLE reading position may arm, at the SAME open
    // tier cadence — the view is stationary relative to the queue, so this
    // IS the landing/settle screen (tap-stopped flick, slow drag). A glide's
    // churning identity arms nothing; the band never arms mid-gesture.
    if (!inputs.nearestStable || !inputs.visible || !tierReady) return plan
    const count = Math.min(inputs.tierCount, TIER_BATCH)
    plan.count = count
    plan.tierArmed = true
    plan.tierArmAt = inputs.now
    return plan
  }

  if (tierReady) {
    const count = Math.min(inputs.tierCount, TIER_BATCH)
    plan.count = count
    plan.tierArmed = true
    plan.tierArmAt = inputs.now
    return plan
  }
  if (bandReady) {
    const count = Math.min(inputs.bandCount, OPEN_FRESH_BATCH)
    plan.count = count
    plan.bandArmed = true
    plan.bandArmAt = inputs.now
    return plan
  }
  return plan
}

/**
 * Zero-size retry deadline (the loader's stranding fix): an entry with a
 * 0×0 rect (not laid out yet) retries for `RETRY_FRAMES` ticks before the
 * loader gives up on it. Pure here so the deadline is pinned; the loader owns
 * the counter.
 */
export const RETRY_FRAMES = 10

/**
 * Whether a zero-size entry survives this tick. `retries` is the remaining
 * counter (10 at enqueue, decremented per held tick).
 */
export function shouldHoldZeroSize(retries: number): boolean {
  return retries > 0
}
