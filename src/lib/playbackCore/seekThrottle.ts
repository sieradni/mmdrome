/**
 * Live-seek throttle for scrubbing (2026-09-12).
 *
 * Native `seek(to:)` is a HEAVY operation — it cancels the scheduled segment,
 * re-opens the AVAudioFile, and re-schedules from the new frame. Firing it per
 * pointermove (60–120 events/s while scrubbing) stacks re-schedules and the
 * playhead audibly lags the thumb, worse the longer the drag is held.
 *
 * The SeekBar emits `onSeek` per move; this core decides which of those
 * samples become engine commands:
 *   - press, release, keyboard, and programmatic seeks always pass (and reset
 *     the cadence) — the release carries the finger's final intent and the
 *     press gives instant feedback;
 *   - a held drag passes through only on a ≥150 ms cadence, so a slow drag
 *     still tracks (one engine seek per step) while a fast scrub collapses
 *     into the single seek at release.
 * Web element seeks stay unthrottled — `el.currentTime` is cheap there (the
 * A12 held-drag cascade is already handled by the suppression latch).
 */
export const SEEK_THROTTLE_MS = 150

export interface SeekThrottleState {
  lastEmittedAt: number | null
}

export const freshSeekThrottle = (): SeekThrottleState => ({ lastEmittedAt: null })

/**
 * Decides whether this live-seek sample should reach the engine, advancing
 * the cadence when it passes. `now` is injectable (performance.now() at the
 * call site) so the timing matrix is unit-verifiable without fake timers.
 */
export function shouldEmitSeek(
  state: SeekThrottleState,
  now: number,
  minIntervalMs = SEEK_THROTTLE_MS,
): boolean {
  if (state.lastEmittedAt === null || now - state.lastEmittedAt >= minIntervalMs) {
    state.lastEmittedAt = now
    return true
  }
  return false
}

/** Resets the cadence so the NEXT sample (a fresh press) always emits. */
export function resetSeekThrottle(state: SeekThrottleState): void {
  state.lastEmittedAt = null
}
