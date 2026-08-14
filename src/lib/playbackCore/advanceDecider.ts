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
}

export function decideAdvance(input: AdvanceDecisionInput): AdvanceDecision {
  if (!input.fromError && input.parkArmed) return 'park'
  if (input.loopMode === 'one') return 'restart'
  if (input.hasNext) return 'advance'
  if (input.loopMode === 'all' && input.hasUserQueue) return 'wrap'
  return 'stop'
}