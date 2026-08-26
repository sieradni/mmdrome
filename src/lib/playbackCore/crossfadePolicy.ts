/**
 * Pure crossfade policy (2026-08-25) — the decisions the web engine's
 * crossfade machinery consults, extracted so they are table-testable without
 * an AudioContext. Mirrors the native gates in
 * `BackgroundAudioCore/Crossfade.swift::crossfadeReadiness` where the two
 * platforms share a rule (durations, margins) and adds the web-only
 * manual-seek suppression.
 *
 * Background (2026-08-25 field report): seeking into the crossfade window
 * executed a fade per scrub event — each switch flipped the active element,
 * the UI slider max followed the NEXT track, and a still-held drag kept
 * landing the new element inside ITS window (skip cascade). Overlapping fades
 * also left an untracked `setTimeout` retire whose target element could become
 * ACTIVE again before the timer fired, pausing live audio. The policy fixes
 * the decision layer; `audioManager` is the device driver.
 */

export type CrossfadeBlockReason =
  | 'disabled'
  | 'missingCurrentDuration'
  | 'currentTooShort'
  | 'noTarget'
  | 'nextTooShort'
  | 'seekSuppressed'

export interface CrossfadeGateInput {
  /** Configured crossfade length in seconds (0 = feature off). */
  fadeDuration: number
  /** Metadata duration of the PLAYING track (0 = unknown). */
  currentDuration: number
  /** Whether a next-track URL is armed. */
  hasTarget: boolean
  /**
   * Metadata duration of the ARMED target — null/0 = unknown. Unknown counts
   * as too short (conservative, parity with Swift's `.noSuccessor`): a fade
   * must never run blind into a target that may end mid-ramp.
   */
  nextDuration: number | null
  /** A user seek landed inside this track's window — suppress until reload. */
  seekSuppressed: boolean
}

export type CrossfadeGate =
  | { allowed: true }
  | { allowed: false; blockedBy: CrossfadeBlockReason }

/**
 * Whether the monitor may EXECUTE a crossfade right now. Check order mirrors
 * `crossfadeReadiness` (Swift) — cheapest/most-fundamental first — so the
 * reported reason is deterministic:
 *  - `disabled`            fadeDuration <= 0
 *  - `missingCurrentDuration` current duration unknown (A1: metadata is truth)
 *  - `currentTooShort`     current < fadeDuration + 1 (web + Swift margin)
 *  - `noTarget`            nothing armed
 *  - `nextTooShort`        target unknown or < fadeDuration (Swift parity —
 *                          a shorter-than-fade target ends mid-ramp)
 *  - `seekSuppressed`      the user scrubbed into this track's window
 */
export function evaluateCrossfadeGate(input: CrossfadeGateInput): CrossfadeGate {
  const { fadeDuration, currentDuration, hasTarget, nextDuration, seekSuppressed } = input
  if (fadeDuration <= 0) return { allowed: false, blockedBy: 'disabled' }
  if (currentDuration <= 0) return { allowed: false, blockedBy: 'missingCurrentDuration' }
  if (currentDuration < fadeDuration + 1) return { allowed: false, blockedBy: 'currentTooShort' }
  if (!hasTarget) return { allowed: false, blockedBy: 'noTarget' }
  if (nextDuration === null || nextDuration < fadeDuration) {
    return { allowed: false, blockedBy: 'nextTooShort' }
  }
  if (seekSuppressed) return { allowed: false, blockedBy: 'seekSuppressed' }
  return { allowed: true }
}

/**
 * True when a user seek lands INSIDE the playing track's crossfade window
 * (the last `fadeDuration` seconds). Such a seek latches the suppression for
 * the remainder of the track instance — the tail plays out and the normal
 * natural-end chain advances. Seeks elsewhere leave automation intact.
 */
export function isSeekInCrossfadeWindow(
  positionSeconds: number,
  trackDuration: number,
  fadeDuration: number,
): boolean {
  if (fadeDuration <= 0 || trackDuration <= 0) return false
  return positionSeconds >= trackDuration - fadeDuration
}

/**
 * Validity check for the DELAYED retire of the fade-out element (the engine
 * pauses it once the ramp completes). A stale retire must never touch live
 * audio: after overlapping switches the element can have become ACTIVE again
 * (now carrying a newer track), or ended on its own. Only genuinely retired,
 * still-running elements may be paused.
 */
export function shouldPauseOldElement(oldEnded: boolean, oldIsActive: boolean): boolean {
  return !oldEnded && !oldIsActive
}
