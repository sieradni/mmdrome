import {
  RETRY_FRAMES,
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
}

/** Debug HUD read-out — counters only, no DOM or credential surface. */
export function thumbLoaderDebugSnapshot(): ThumbLoaderDebug {
  const flow = thumbFlowSignal({
    now: Date.now,
    lastScrollAt: () => lastScrollAt,
    // Last tick's measurement (the snapshot runs outside the tick loop; the
    // nearest ratio is only meaningful as the loader last saw it).
    nearestRatio: () => lastNearestRatio,
  })
  return {
    pending: pending.length,
    blocked: flow.blocked,
    visibleTier: flow.visible,
    armedTotal,
    droppedTotal,
    lastArmedAt,
  }
}

function tick(): void {
  running = false
  if (pending.length === 0) return

  const vh = window.innerHeight
  const midViewport = vh / 2
  const dropDistance = vh * 3

  const keep: PendingThumb[] = []
  let nearestDistance = Infinity
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
    if (dist < nearestDistance) nearestDistance = dist
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
  })
  // Mid-gesture (blocked + visible tier open) the batch is CAPPED to the
  // holdout tier — the nearest-8 splice must never leak pre-roll rows into a
  // live gesture. When the gate is fully open the whole queue is available.
  const plan =
    flow.blocked && !flow.visible
      ? { count: 0, markArmed: false }
      : planArming(flow.blocked ? visibleCount : pending.length, MAX_PER_TICK, now, lastArmedAt)

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