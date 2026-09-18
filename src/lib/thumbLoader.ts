import {
  RETRY_FRAMES,
  VISIBLE_HOLDOUT_RATIO,
  planFreshArming,
  shouldHoldZeroSize,
  thumbFlowSignal,
} from './thumbFlow'


interface PendingThumb {
  el: HTMLElement
  load: () => void
  distance: number
  retries: number
  /** The row was ALREADY loaded once (a revisit after unlatch) — its cover
   *  comes from the browser's HTTP cache (immutable covers: no revalidation),
   *  so arming it is a local decode, not a network fetch. Pacing a free
   *  operation was the pop-in mechanism: cached rows waited behind the same
   *  pace windows as fresh rows and appeared in visible batches. */
  cached: boolean
}

/** Cached-lane cap per tick (rows armed per frame — the decode cost bound). */
const CACHED_PER_TICK = 8

let pending: PendingThumb[] = []
let running = false

// --- Flow bookkeeping (the policy itself lives in the pure `thumbFlow.ts`) ---
let lastScrollAt = 0
/** Fresh-lane arm clocks (one per lane — a tier batch never delays the band
 *  trickle and vice versa). `lastArmedAt` (debug) is the latest of the two. */
let lastTierArmAt = 0
let lastBandArmAt = 0
let flowInstalled = false
let armedTotal = 0
let cachedTotal = 0
let droppedTotal = 0
let lastNearestRatio = Infinity
/** The nearest row's element as the last tick saw it. The debug snapshot must
 *  feed the SAME value back into thumbFlowSignal (which records what its deps
 *  hand it) — a snapshot without the id would clobber the baseline to
 *  undefined and delay the next tick's settle detection by a cycle. */
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
  /** Rows armed through the free cached lane (revisits). */
  cachedTotal: number
  droppedTotal: number
  lastArmedAt: number
  /** The nearest row is the same as last tick (the view is stationary). */
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
    cachedTotal,
    droppedTotal,
    lastArmedAt: Math.max(lastTierArmAt, lastBandArmAt),
    stationary: flow.nearestStable,
  }
}

function tick(): void {
  running = false
  if (pending.length === 0) return

  const vh = window.innerHeight
  const midViewport = vh / 2
  const dropDistance = vh * 6 // in step with LazyThumb's ±4000px unlatch

  // Partition by (lane, urgency). The nearest/identity bookkeeping runs over
  // ALL kept entries regardless of lane — identity stability is a property of
  // the viewport's motion, not of what is cached.
  let nearestDistance = Infinity
  let nearestEntry: PendingThumb | undefined
  const tierFresh: PendingThumb[] = []
  const bandFresh: PendingThumb[] = []
  const tierCached: PendingThumb[] = []
  const bandCached: PendingThumb[] = []
  const keep: PendingThumb[] = []
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
    const inTier = dist <= vh * VISIBLE_HOLDOUT_RATIO
    if (p.cached) {
      if (inTier) tierCached.push(p)
      else bandCached.push(p)
    } else {
      if (inTier) tierFresh.push(p)
      else bandFresh.push(p)
    }
    keep.push(p)
  }

  pending = keep
  if (pending.length === 0) return

  // Velocity gate (thumbFlow.ts). The distance bookkeeping above runs every
  // frame regardless, so the queue is always current when the gate opens.
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

  let armedThisTick = 0
  const armedEls = new Set<HTMLElement>()
  const armBatch = (entries: PendingThumb[], count: number): number => {
    if (count <= 0 || entries.length === 0) return 0
    const sorted = [...entries].sort((a, b) => a.distance - b.distance)
    let n = 0
    for (const p of sorted) {
      if (n >= count) break
      armedEls.add(p.el)
      p.load()
      n++
      armedThisTick++
      if (p.cached) cachedTotal++
      else armedTotal++
    }
    return n
  }

  // LANE 0 — cached tier: rows the user can SEE whose cover is already in the
  // HTTP cache. No network, no server load — arm at the frame cadence, in any
  // flow state (visible pop-in is exactly this lane; pacing it was pure loss).
  if (flow.visible || !flow.blocked) armBatch(tierCached, CACHED_PER_TICK)

  // LANES 1+2 — fresh rows, planned by the pure two-lane policy: the tier
  // (on-screen) at the fast cadence, the band (pre-roll) as a trickle that
  // never floods the server; mid-gesture fresh arming requires identity
  // stability (a slow drag's reading position), so a glide charges nothing.
  const plan = planFreshArming({
    blocked: flow.blocked,
    visible: flow.visible,
    nearestStable: flow.nearestStable,
    tierCount: tierFresh.length,
    bandCount: bandFresh.length,
    now,
    lastTierArmAt,
    lastBandArmAt,
  })
  if (plan.tierArmed) armBatch(tierFresh, plan.count)
  else if (plan.bandArmed) armBatch(bandFresh, plan.count)
  lastTierArmAt = plan.tierArmAt
  lastBandArmAt = plan.bandArmAt

  // LANE 3 — cached band (off-screen, cached): pre-warms scroll-back for free
  // while the gate is open. Runs LAST — the screen has absolute priority.
  if (!flow.blocked) armBatch(bandCached, CACHED_PER_TICK)

  if (armedThisTick > 0) {
    pending = pending.filter((p) => !armedEls.has(p.el))
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
 * Queue a thumbnail load. Arming is LANE-BASED (thumbFlow.ts `planFreshArming`):
 * - rows already loaded once (`cached`) arm at the frame cadence in any flow
 *   state — their cover is an HTTP-cache hit, and pacing a free operation was
 *   the pop-in mechanism;
 * - fresh rows split into the TIER (everything on screen — fast cadence, the
 *   screen never waits behind the band) and the BAND (the pre-roll — a
 *   deliberate 8-per-250 ms trickle that keeps lead time growing without
 *   flooding a self-hosted server with a ~90-request burst, which is what
 *   made even the on-screen covers land late);
 * - mid-gesture, fresh arming additionally requires the nearest row's
 *   identity to be STABLE (a slow drag's reading position) — a glide arms
 *   nothing fresh mid-flight, so no stale fetch is ever launched and the
 *   landing starts at full speed.
 *
 * The distance bookkeeping runs every frame in every state, so the queue is
 * always ordered by the CURRENT viewport when any lane opens.
 *
 * `cached`: pass true when this row was already loaded once (LazyThumb's
 * revisit flag). A wrong claim degrades to a normal load, never to breakage.
 */
export function requestThumb(el: HTMLElement, load: () => void, cached = false): void {
  ensureFlowListener()
  if (pending.some((p) => p.el === el)) return
  pending.push({ el, load, distance: 0, retries: RETRY_FRAMES, cached })
  start()
}

export function cancelThumb(el: HTMLElement): void {
  const i = pending.findIndex((p) => p.el === el)
  if (i >= 0) pending.splice(i, 1)
}
