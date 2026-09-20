/**
 * Pure track-end advance decision — the single source of truth for the
 * park → loop-one → advance → wrap → stop chain (TODO 1.0 Step 1).
 *
 * The chain is currently copied at four sites in playbackManager
 * (`_onTrackEnded`, `_onBgTrackEnd`, `_handleExitBackground`,
 * `_handleCrossfadeEnd`) with subtle drift (e.g. `_handleExitBackground`'s
 * ended branch has no loop-one branch and advances instead of restarting).
 * This module pins the guard order once, table-tested; the callers execute
 * the decision against the real queue.
 *
 * Guard order (matches the four sites):
 *   1. park beats everything EXCEPT error-driven advances (`fromError` — a
 *      dead stream can't play out its end, advancing is correct);
 *   2. loop-one restarts the current track;
 *   3. the next queue row advances;
 *   4. loop-all wraps to the first user row;
 *   5. otherwise stop.
 *
 * `hasNext`/`hasUserQueue` are computed by the caller BEFORE any queue
 * mutation — the decision itself never touches queue state.
 *
 * STOP is uniform here; what it MEANS is the adapter's call: the foreground
 * path clears the element and reports stopped, the background path idles
 * (parity with `_onBgTrackEnd`, which has no stop branch — the ended element
 * simply sits silent).
 */

export type LoopMode = 'none' | 'one' | 'all'

export type AdvanceDecision = 'park' | 'restart' | 'advance' | 'wrap' | 'stop'

/** Error-driven give-up cycles allowed under loop-one before the restart
 *  loop is declared pathological and playback stops (2026-09-20, the
 *  ledger's loop-one edge): a permanently broken track under loop-one
 *  otherwise restarts forever (give-up → restart → error → give-up …).
 *  3 ≈ three full retry rounds (native 2 retries/cycle, web 3) — generous
 *  for transient failures, bounded for a dead file. The count resets on
 *  any natural end or track change (healthy loop-one never accumulates). */
export const LOOP_ONE_ERROR_CYCLE_LIMIT = 3

export interface AdvanceDecisionInput {
  /** True when the advance is driven by a retry-exhausted stream error — skips the park. */
  fromError: boolean
  /** True while the end-of-track sleep timer is armed (web only; native owns it). */
  parkArmed: boolean
  loopMode: LoopMode
  /** True when a next row exists to advance to (the caller's playing-track-
   *  aware advance target — normally `activeIndex + 1`, but `activeIndex`
   *  itself after an active-row removal, 2.4 option b). */
  hasNext: boolean
  /** True when the user queue is non-empty (loop-all wrap target). */
  hasUserQueue: boolean
  /** Consecutive error-driven give-ups for the CURRENT track (0 = fresh;
   *  the caller resets on any natural end or track change). Only consulted
   *  under loop-one — outside it an error advance moves to a different
   *  row, so the failure cycle cannot repeat. */
  errorRestartCycles?: number
}

export function decideAdvance(input: AdvanceDecisionInput): AdvanceDecision {
  if (!input.fromError && input.parkArmed) return 'park'
  if (input.loopMode === 'one') {
    // The loop-one bound (LOOP_ONE_ERROR_CYCLE_LIMIT doc): the count only
    // grows on fromError events — the caller bumps it BEFORE this call in
    // the same flow — so reaching the limit here means THIS event is the
    // Nth consecutive failure, and the loop is pathological. Stop.
    return (input.errorRestartCycles ?? 0) >= LOOP_ONE_ERROR_CYCLE_LIMIT ? 'stop' : 'restart'
  }
  if (input.hasNext) return 'advance'
  if (input.loopMode === 'all' && input.hasUserQueue) return 'wrap'
  return 'stop'
}