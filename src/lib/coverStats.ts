/**
 * Pure cover-fetch observability (P6, 2026-09-23).
 *
 * The THUMBS debug section counts ARMS (loader-side) but says nothing about
 * what happened after: how long covers take to load, how often the failure
 * ladder has to step down, how often the app-icon fallback answers. Every
 * "thumbnails don't load" field report then requires deduction instead of
 * reading numbers. This core keeps a bounded ring of per-cover outcomes +
 * running aggregates; LazyThumb (the single component through which ALL
 * covers render) feeds it. In-flight covers are NOT counted — the loader's
 * own THUMBS snapshot (pending) owns that number.
 *
 * DOM-free, clock-injected — pinned by tests/coverStats.test.ts.
 */

/** How many per-cover records to keep (the HUD reads the tail). */
export const COVER_STATS_RING_SIZE = 60

export type CoverRole = 'main' | 'micro' | 'fallback'

export interface CoverEvent {
  seq: number
  t: number
  /** Which <img> this outcome belongs to. */
  role: CoverRole
  /** Requested canonical rendition (0 for micro/fallback). */
  size: number
  /** Main-only: ladder steps consumed before success (0 = first url worked). */
  ladderStep: number
  /** Main-only: arm→onload latency, or null when the outcome is a give-up. */
  loadMs: number | null
  /** 'ok' = image on screen; 'failed' = main ladder exhausted → fallback icon;
   *  'micro-failed' = placeholder unavailable (cosmetic, main unaffected). */
  outcome: 'ok' | 'failed' | 'micro-failed'
}

export interface CoverStatsState {
  ring: CoverEvent[]
  nextSeq: number
  /** Successful main covers. */
  loaded: number
  /** Main ladders exhausted → app-icon fallback shown (the visible "thumbnail didn't load"). */
  failed: number
  /** Ladder step-downs (a first-choice URL errored; a smaller rendition answered). */
  stepDowns: number
  /** Micro placeholders that errored (main unaffected — cosmetic only). */
  microFailed: number
  /** Sum of successful main latencies (divide by loaded for the mean). */
  loadMsTotal: number
}

export function freshCoverStats(): CoverStatsState {
  return {
    ring: [],
    nextSeq: 1,
    loaded: 0,
    failed: 0,
    stepDowns: 0,
    microFailed: 0,
    loadMsTotal: 0,
  }
}

/** Record one cover outcome. Pure: returns the next state. */
export function recordCoverEvent(
  state: CoverStatsState,
  event: Omit<CoverEvent, 'seq' | 't'>,
  now: number,
): CoverStatsState {
  const ring = state.ring.length >= COVER_STATS_RING_SIZE
    ? [...state.ring.slice(1), { ...event, seq: state.nextSeq, t: now }]
    : [...state.ring, { ...event, seq: state.nextSeq, t: now }]
  const next: CoverStatsState = {
    ...state,
    ring,
    nextSeq: state.nextSeq + 1,
  }
  if (event.role === 'micro') {
    if (event.outcome === 'micro-failed') next.microFailed++
    return next
  }
  if (event.role === 'fallback') return next
  // main
  if (event.outcome === 'ok') {
    next.loaded++
    if (event.ladderStep > 0) next.stepDowns++
    if (event.loadMs !== null) next.loadMsTotal += event.loadMs
  } else {
    next.failed++
  }
  return next
}

export interface CoverStatsSummary {
  loaded: number
  failed: number
  stepDowns: number
  microFailed: number
  /** Mean main-cover latency, rounded; null when nothing loaded yet. */
  meanLoadMs: number | null
  /** The most recent per-cover records, NEWEST first (HUD rows). */
  recent: CoverEvent[]
}

export function summarizeCoverStats(state: CoverStatsState): CoverStatsSummary {
  return {
    loaded: state.loaded,
    failed: state.failed,
    stepDowns: state.stepDowns,
    microFailed: state.microFailed,
    meanLoadMs: state.loaded > 0 ? Math.round(state.loadMsTotal / state.loaded) : null,
    recent: [...state.ring].reverse(),
  }
}

/**
 * Module-level singleton (thumbLoader's precedent): LazyThumb appends
 * outcomes; the HUD reads. Every cover in the app renders through
 * LazyThumb, so one feed point is complete coverage.
 */
let singleton = freshCoverStats()

export function coverStatsRecord(event: Omit<CoverEvent, 'seq' | 't'>): void {
  singleton = recordCoverEvent(singleton, event, Date.now())
}

export function coverStatsSummary(): CoverStatsSummary {
  return summarizeCoverStats(singleton)
}

/** Test hook. */
export function __resetCoverStats(): void {
  singleton = freshCoverStats()
}
