/**
 * Pure re-arm decision for the NATIVE sleep timer (TODO 0.2).
 *
 * The iOS engine owns the actual timer, but EVERY JS queue snapshot
 * (`setQueue` via `_nativeLoadPlay` — next/prev/select/retry and queue-end
 * wraps) calls native `stopPlayback()`, which invalidates both the timer and
 * the end-of-track flag. JS never re-armed, so the timer silently "expired"
 * while playback continued. The JS `sleepTimer` store is the authoritative
 * armed state; this module decides whether a snapshot must re-arm the engine
 * mirror, recomputing the remaining minutes from `endsAt` with a fake-able
 * clock. No timer APIs — fully unit-testable.
 */

export type SleepTimerMode = 'minutes' | 'endOfTrack'

export interface SleepTimerArmedState {
  active: boolean
  mode: SleepTimerMode
  /** Epoch ms at which a minutes-mode timer expires (0 in endOfTrack mode). */
  endsAt: number
  /** The nominal minutes the user picked (passed through for endOfTrack). */
  minutes: number
}

export interface SleepTimerRearm {
  shouldReArm: boolean
  mode: SleepTimerMode
  /** Exact remaining minutes; the native engine clamps each interval to >=1s.
   *  An already-expired minutes timer re-arms at the 1s floor so the pause
   *  arrives promptly instead of never (the JS countdown only clears the UI
   *  store on native — it does not stop playback). */
  minutes: number
}

export function rearmDecision(state: SleepTimerArmedState, now: number): SleepTimerRearm {
  if (!state.active) {
    return { shouldReArm: false, mode: state.mode, minutes: state.minutes }
  }
  if (state.mode === 'endOfTrack') {
    return { shouldReArm: true, mode: 'endOfTrack', minutes: state.minutes }
  }
  const remaining = state.endsAt - now
  return { shouldReArm: true, mode: 'minutes', minutes: Math.max(0.01, remaining / 60_000) }
}