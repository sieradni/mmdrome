import {
  GESTURE_VISIBLE_BATCH,
  MIN_ARM_INTERVAL_MS,
  RETRY_FRAMES,
  SCROLL_HOLD_MS,
  VISIBLE_HOLDOUT_RATIO,
  planArming,
  shouldHoldZeroSize,
  thumbFlowSignal,
} from './thumbFlow'


interface PendingThumb {
  el: HTMLElement
  load: () => void
  distance: number
  retries: number
}

const MAX_PER_TICK = 8

let pending: PendingThumb[] = []
let running = false

// --- Flow bookkeeping (the policy itself lives in the pure `thumbFlow.ts`) ---
let lastScrollAt = 0
let lastArmedAt = 0
let flowInstalled = false
let armedTotal = 0
let droppedTotal = 0
let lastNearestRatio = Infinity
/** The nearest row's element as the last tick saw it. The debug snapshot must
 *  feed the SAME value back into thumbFlowSignal (which records what its deps
 *  hand it) — a snapshot without the id would clobber the baseline to
 *  undefined and delay the next tick's settle-expiry by a cycle. */
let lastNearestId: unknown

/** Once per app session: stamp every scroll event. Scroll events do NOT
 *  bubble, but they DO capture-propagate — the views own their scroll
 *  containers (per-view overflow divs), so listen at `document` in the capture
 *  phase. Passive: we only record a timestamp; the hold decays on wall clock
 *  (thumbFlowSignal), so no timer needs re-arming here. Wired lazily on the
 *  first requestThumb so a Node import of this module stays side-effect-free. */
function ensureFlowListener(): void {
  if (flowInstalled || typeof document === 'undefined') return
  flowInstalled = true
  document.addEventListener(
    'scroll',
    () => { lastScrollAt = Date.now() },
    { capture: true, passive: true },
  )
}

export interface ThumbLoaderDebug {
  pending: number
  blocked: boolean
  /** The visible tier is open (nearest row inside the holdout radius). */
  visibleTier: boolean
  armedTotal: number
  droppedTotal: number
  lastArmedAt: number
  /** The nearest row is the same as last tick (settle-expiry armed). */
  stationary: boolean
}

/** Debug HUD read-out — counters only, no DOM or credential surface. */
export function thumbLoaderDebugSnapshot(): ThumbLoaderDebug {
  const flow = thumbFlowSignal({
    now: Date.now,
    lastScrollAt: () => lastScrollAt,
    // Last tick's measurement (the snapshot runs outside the tick loop; the
    // nearest ratio is only meaningful as the loader last saw it).
    nearestRatio: () => lastNearestRatio,
    // Same id the last tick recorded — keeps the signal's baseline write
    // idempotent (see lastNearestId's doc).
    lastNearestId: () => lastNearestId,
  })
  return {
    pending: pending.length,
    blocked: flow.blocked,
    visibleTier: flow.visible,
    armedTotal,
    droppedTotal,
    lastArmedAt,
    stationary: flow.nearestStable,
  }
}

function tick(): void {
  running = false
  if (pending.length === 0) return

  const vh = window.innerHeight
  const midViewport = vh / 2
  const dropDistance = vh * 6 // in step with LazyThumb's ±4000px unlatch

  const keep: PendingThumb[] = []
  let nearestDistance = Infinity
  let nearestEntry: PendingThumb | undefined
  let visibleCount = 0
  for (const p of pending) {
    const rect = p.el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      // Not laid out yet — hold it (unbounded batching would load invisible
      // thumbs early; dropping it strands it forever since the IntersectionObserver
      // only re-fires on intersection *changes*). Give up after a few frames.
      if (shouldHoldZeroSize(p.retries)) {
        p.retries--
        p.distance = Number.MAX_SAFE_INTEGER
        keep.push(p)
      } else {
        droppedTotal++
      }
      continue
    }
    const dist = Math.abs(rect.top + rect.height / 2 - midViewport)
    if (dist > dropDistance) {
      // Far out of the window — the still-active IntersectionObserver
      // re-requests on re-entry (a fresh pending entry), so dropping is safe.
      droppedTotal++
      continue
    }
    p.distance = dist
    if (dist < nearestDistance) {
      nearestDistance = dist
      nearestEntry = p
    }
    if (dist <= vh * VISIBLE_HOLDOUT_RATIO) visibleCount++
    keep.push(p)
  }

  pending = keep
  if (pending.length === 0) return

  // Velocity gate (thumbFlow.ts), two tiers: the far pre-roll stays held
  // while a scroll gesture is recent (or during the first-mount warmup), but
  // the VISIBLE tier — the nearest row within half a viewport of center —
  // arms even mid-gesture, because "load what the user can see" is correct
  // at every scroll speed (the slow-drag placeholder regression). The
  // distance bookkeeping above still runs every frame either way, so the
  // queue is always current when the gate opens.
  const now = Date.now()
  lastNearestRatio = vh > 0 ? nearestDistance / vh : Infinity
  const flow = thumbFlowSignal({
    now: () => now,
    lastScrollAt: () => lastScrollAt,
    nearestRatio: () => lastNearestRatio,
    // THIS tick's nearest identity; the signal compares it against the last
    // verdict's baseline internally and records it for the next tick.
    lastNearestId: () => nearestEntry?.el,
  })
  lastNearestId = nearestEntry?.el
  // Mid-gesture (blocked + visible tier open) the batch is CAPPED to the
  // holdout tier AND PACED at the gesture cadence — one 4-row batch per hold
  // window, not 8/33 ms. A scrollbar-style teleport continuously replaces the
  // rows inside the holdout radius (every screen it passes is briefly
  // "visible"), so full cadence launched a fetch for EVERY screen a fast
  // drag flew past; those stale fetches then starved the landing screen on a
  // real network (the 1.2.23 field report). The gesture pace keeps the
  // reading position loading during a slow drag while bounding the stale
  // fetch count to O(hold windows crossed), not O(screens passed). When the
  // gate is fully open the whole queue is available at the open cadence.
  //
  // Settle-expiry (2026-09-17, the "0.2–0.3 s before the first 4 center
  // thumbnails" report): when the gesture has STOPPED on a view (nearest row
  // is the same row as last tick — isNearestStable) but the hold window is
  // still running, the pace clock is stale (consumed by batches the flick
  // flew past) — waive it so the landing screen arms on the next frame. The
  // scrollbar-firehose case can never reach the waive: churned identity keeps
  // nearestStable false, and the waive lives in the blocked branch where
  // `available` is visibleCount — the on-screen tier itself — so even a
  // misjudged stability arms only what the user is looking at.
  const settledLanding = flow.blocked && flow.visible && flow.nearestStable
  const plan =
    flow.blocked && !flow.visible
      ? { count: 0, markArmed: false }
      : flow.blocked
        ? planArming(visibleCount, GESTURE_VISIBLE_BATCH, now, lastArmedAt, SCROLL_HOLD_MS, settledLanding)
        : planArming(pending.length, MAX_PER_TICK, now, lastArmedAt, MIN_ARM_INTERVAL_MS)

  if (plan.count > 0) {
    if (plan.markArmed) lastArmedAt = now
    pending.sort((a, b) => a.distance - b.distance)
    const batch = pending.splice(0, plan.count)
    armedTotal += batch.length
    for (const p of batch) p.load()
  }

  if (pending.length > 0) {
    running = true
    requestAnimationFrame(tick)
  }
}

function start(): void {
  if (running || pending.length === 0) return
  running = true
  requestAnimationFrame(tick)
}

/**
 * Queue a thumbnail load so the browser fetches/decodes at most `MAX_PER_TICK`
 * per armed batch, always nearest-to-viewport first. Arming is two-tier
 * (thumbFlow.ts): the visible screen arms immediately at ANY scroll speed
 * (the nearest row within half a viewport of center is inside the visible
 * tier even mid-gesture); the far pre-roll holds while a scroll gesture is
 * recent, so a flick queues nothing ahead of itself and the settled view is
 * the first thing armed when the motion stops.
 *
 * 8/batch (2026-09-14, the "albums load slowly on a fast network" report):
 * the old 3/frame serialized ~7+ frames just to ARM a screenful of album-grid
 * cells before any byte moved — decode is already async (`decoding="async"`),
 * so the cap only throttled the fetch starts, not the main thread.
 * Velocity gate (2026-09-16, the "quickly scrolling" pass): batches are paced
 * ≥ MIN_ARM_INTERVAL_MS apart — arming is TIMING-only policy, it never changes
 * WHICH covers download, only their order. Visible tier (2026-09-17, the
 * slow-scroll regression): the original gate held ALL arming during a
 * gesture, which starved exactly the rows being looked at during a slow drag.
 */
export function requestThumb(el: HTMLElement, load: () => void): void {
  ensureFlowListener()
  if (pending.some((p) => p.el === el)) return
  pending.push({ el, load, distance: 0, retries: RETRY_FRAMES })
  start()
}

export function cancelThumb(el: HTMLElement): void {
  const i = pending.findIndex((p) => p.el === el)
  if (i >= 0) pending.splice(i, 1)
}