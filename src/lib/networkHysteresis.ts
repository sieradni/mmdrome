/**
 * Pure network-stability classification (2026-10-02, Phase 2 of the
 * network-churn plan). Replaces the first-generation symmetric flap filter
 * (P5, 2026-09-23) whose 3 s hold had no answer for a connection that keeps
 * changing.
 *
 * Field evidence (2026-10-02 dump): NWPathMonitor churned
 * `exp=false→true→false→true` across ~8 s (Connectivity Assist / interface
 * churn), each confirmed flip re-derived every `effectiveLowData` consumer
 * (transcode rendition URLs, preload economics, the native params push,
 * `refreshQueue` fan-outs), and each churn burst tore the in-flight
 * downloads down. The app's job is NOT to stop the OS churn (it cannot) but
 * to stop AMPLIFYING it: a wobble must not flip the mode, and a connection
 * that keeps changing must be HELD in the conservative (metered) state.
 *
 * Two behaviours, both requested by the user:
 *  1. ASYMMETRIC confirmation. Entering metered is the safe direction and
 *     commits quickly (`CONFIRM_TO_METERED_MS`); leaving metered re-derives
 *     the whole data economy and requires a long stretch of *continuous*
 *     unmetered raw (`HOLD_TO_UNMETERED_MS`). Any metered blip restarts the
 *     unmetered clock.
 *  2. CHURN LATCH. `CHURN_MIN_TRANSITIONS` raw flips inside `CHURN_WINDOW_MS`
 *     arm a latch that PINS the classification metered for `CHURN_HOLD_MS`,
 *     refreshed by every further flip. While latched, unmetered simply
 *     cannot commit. On release, the full unmetered hold window starts, so a
 *     brief quiet gap inside an ongoing wobble cannot sneak a flip through.
 *
 * The OS Low Data Mode bit (isConstrained) is deliberately NOT filtered — it
 * flips on an explicit user toggle, never flaps, and rides live in the
 * caller. The boot snapshot (`effective === null`) adopts the first raw value
 * immediately so boot is never delayed.
 *
 * DOM-free and clock-injected (`now` is a parameter) — pinned by
 * tests/networkHysteresis.test.ts (Node, no device needed).
 */

/** Entering metered (cheap→expensive): short — metered is the conservative
 *  state, so committing it promptly is safe and saves data. */
export const CONFIRM_TO_METERED_MS = 2000

/** Leaving metered (expensive→cheap): long — a commit here re-derives
 *  transcode/preload/queue economics, so it needs sustained evidence. Any
 *  metered blip inside this window restarts the clock. */
export const HOLD_TO_UNMETERED_MS = 12000

/** Window over which raw flips are counted for churn detection. */
export const CHURN_WINDOW_MS = 20000

/** Raw flips within `CHURN_WINDOW_MS` that arm the churn latch. */
export const CHURN_MIN_TRANSITIONS = 3

/** How long the latch pins metered; refreshed by each further flip. */
export const CHURN_HOLD_MS = 30000

export interface NetworkStabilityState {
  /** The filtered metered bit. `null` = boot not yet seen (first raw adopts). */
  effective: boolean | null
  /** Pending candidate awaiting confirmation; null when idle. */
  candidate: boolean | null
  /** When the pending candidate FIRST appeared (a repeated same-value sample
   *  keeps its clock; a reversed blip cancels it). */
  candidateAt: number | null
  /** Last raw sample, used to detect flips (churn counting). */
  lastRaw: boolean | null
  /** Raw flip timestamps inside the churn window (bounded on every call). */
  transitions: number[]
  /** Churn latch deadline; null when unlatched or expired. */
  latchedUntil: number | null
  /** Raw flips that never survived classification (dump-visible). */
  suppressed: number
}

export function freshNetworkStability(): NetworkStabilityState {
  return {
    effective: null,
    candidate: null,
    candidateAt: null,
    lastRaw: null,
    transitions: [],
    latchedUntil: null,
    suppressed: 0,
  }
}

export interface StabilityVerdict {
  /** The filtered metered value after this update. */
  effective: boolean
  /** True only when the filtered value CHANGED with this call — the only
   *  signal on which the caller may update consumers (that store write IS
   *  the churn the classifier exists to prevent). */
  changed: boolean
  /** True when the churn latch is active (classification pinned metered). */
  latched: boolean
  state: NetworkStabilityState
}

export function decideNetworkStability(
  raw: boolean,
  now: number,
  state: NetworkStabilityState,
): StabilityVerdict {
  // Boot: adopt the first authoritative snapshot without confirmation, so
  // `initNetworkMode` never delays the boot pipeline.
  if (state.effective === null) {
    return {
      effective: raw,
      changed: true,
      latched: false,
      state: { ...state, effective: raw, lastRaw: raw, candidate: null, candidateAt: null },
    }
  }

  // 1. Record raw flips, bounded to the churn window.
  const isNewFlip = state.lastRaw !== raw
  let transitions = isNewFlip ? [...state.transitions, now] : state.transitions
  transitions = transitions.filter((t) => now - t <= CHURN_WINDOW_MS)

  // 2. Churn latch: enough flips inside the window → pin metered for
  //    CHURN_HOLD_MS. Refreshed ONLY by a further FLIP — a repeated same-value
  //    monitor event must not extend the hold (otherwise the deadline kept
  //    sliding while ≥3 flips sat in the window, so the latch lasted up to
  //    CHURN_WINDOW past the last flip instead of exactly CHURN_HOLD_MS).
  let latchedUntil = state.latchedUntil
  if (isNewFlip && transitions.length >= CHURN_MIN_TRANSITIONS) latchedUntil = now + CHURN_HOLD_MS
  const latched = latchedUntil !== null && now < latchedUntil
  if (latchedUntil !== null && !latched) latchedUntil = null // expired

  const base: NetworkStabilityState = { ...state, lastRaw: raw, transitions, latchedUntil }

  // 3. While latched: pin metered; unmetered cannot commit. A pending
  //    candidate is cancelled (counted as suppressed).
  if (latched) {
    const changed = state.effective !== true
    return {
      effective: true,
      changed,
      latched: true,
      state: {
        ...base,
        effective: true,
        candidate: null,
        candidateAt: null,
        suppressed: state.suppressed + (state.candidate !== null ? 1 : 0),
      },
    }
  }

  // 4. Raw agrees with the filtered value: any pending candidate died (a blip
  //    that reversed before confirming) — count it, go idle.
  if (raw === state.effective) {
    const cancelled = state.candidate !== null
    return {
      effective: state.effective,
      changed: false,
      latched: false,
      state: {
        ...base,
        candidate: null,
        candidateAt: null,
        suppressed: state.suppressed + (cancelled ? 1 : 0),
      },
    }
  }

  // 5. Asymmetric confirmation of the differing raw value.
  const confirmWindow = raw ? CONFIRM_TO_METERED_MS : HOLD_TO_UNMETERED_MS
  if (state.candidate === raw && state.candidateAt !== null && now - state.candidateAt >= confirmWindow) {
    return {
      effective: raw,
      changed: true,
      latched: false,
      state: { ...base, effective: raw, candidate: null, candidateAt: null },
    }
  }
  // New (or first) candidate — start its window; a repeated same-value sample
  // keeps the original clock (no extension).
  const candidateAt = state.candidate === raw && state.candidateAt !== null ? state.candidateAt : now
  return {
    effective: state.effective,
    changed: false,
    latched: false,
    state: { ...base, candidate: raw, candidateAt },
  }
}
