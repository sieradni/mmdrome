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
  /** The nearest queued row is the SAME row as the previous verdict tick —
   *  the viewport has stopped moving relative to the queue even though the
   *  hold window may not have decayed yet (a tap/hold stopping a flick).
   *  Drives the adapter's settle-expiry (see isNearestStable). Only computed
   *  when the deps carry a `lastNearestId`. */
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
   *  (identity stays put). Absent → `isNearestStable` is always false. */
  lastNearestId?(): unknown
}

/**
 * Whether the nearest queued row is the same row as the previous verdict —
 * the load-bearing signal of the settle-expiry (2026-09-17, the "0.2–0.3 s
 * before the first 4 center thumbnails" report): after a flick stopped by a
 * tap, the nearest row sits PUT (its identity stops changing) while the
 * SCROLL_HOLD_MS window still runs — a window consumed mid-gesture by batches
 * the flick immediately flew past. Waiting out that stale window delays the
 * landing screen for nothing. This predicate distinguishes exactly that case
 * from the scrollbar-firehose the 2026-09-17j pace exists for: a scrollbar
 * drag continuously REPLACES the rows in the holdout tier, so the nearest
 * identity churns every hop and the window never waives. Pure identity
 * comparison — no wall-clock tuning, no epsilon to get wrong.
 */
export function isNearestStable(deps: ThumbFlowDeps): boolean {
  const id = deps.lastNearestId?.()
  return id !== undefined && id === lastSeenNearestId
}

/** The identity the previous verdict saw. INTERNAL: `thumbFlowSignal` updates
 *  it after every verdict (the compare-then-record order makes consecutive
 *  signal calls a proper two-tap comparison); pure callers never touch it. */
let lastSeenNearestId: unknown

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
  const nearestStable = isNearestStable(deps)
  // Record THIS verdict's identity as the next call's baseline (compare-
  // then-record: consecutive calls form the two-tap comparison). An extra
  // signal call with the same deps (the debug snapshot re-derives the verdict)
  // is idempotent — same id in, same baseline out.
  lastSeenNearestId = deps.lastNearestId?.()
  return { blocked, visible, nearestStable }
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
