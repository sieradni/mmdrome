import type { SettingsMap } from '../stores/appState'
import type { LocalMetadataStore } from './db'

/**
 * ONE definition of "should this track be scrobbled as loved" (2026-10-21).
 *
 * Both heart producers read it and nothing re-derives the decision:
 *
 *  - the explicit ♥ flip (`feedbackService.commitFeedback`) asks whether the
 *    EFFECTIVE love state moved, via `planLoveChange`;
 *  - a completed listen (`scrobbleManager.evaluate`) asks the same predicate
 *    for the CURRENT state, so a track that was already loved (tag / Navidrome
 *    star / another device) still reaches Last.fm and ListenBrainz when it is
 *    played — the old fan-out only fired on a local flip, which is exactly why
 *    "only newly changed songs" arrived as loved.
 *
 * The two SIGNALS are independent and each may be switched off, so the user
 * can love by ♥ only, by rating threshold only, by either, or never. Both flags
 * default to the historical behavior (♥ only) until the settings UI lands.
 *
 * Pure (F2): no stores, no network. Rating is the app's 0–100 scale; an
 * unrated track is 0 and therefore can never clear a threshold in 1–100.
 */

export interface LoveSignals {
  /** The ♥ flag — file `LOVERATING`/`LOVE RATING` tag or Navidrome star. */
  loved: boolean
  /** 0–100 rating (0 = unrated). */
  rating: number
}

export interface LovePolicy {
  /** Honor the ♥ flag. */
  fromLovedFlag: boolean
  /** Honor the rating threshold. */
  fromRating: boolean
  /** Inclusive 0–100 cutoff; normalized to 1–100 by `resolveLovePolicy`. */
  ratingThreshold: number
}

/** Settings rows this policy reads. Absent keys fall back to the defaults. */
export type LovePolicySettings = Pick<
  SettingsMap,
  'scrobbleLoveFromLoved' | 'scrobbleLoveFromRating' | 'scrobbleLoveRatingThreshold'
>

/** The app's rating scale is 0–100 in steps of 10 (0 = unrated), so 10 is the
 *  lowest meaningful cutoff and the threshold UI's floor matches it exactly. */
export const LOVE_RATING_MIN = 10
export const LOVE_RATING_MAX = 100

/** Historical behavior for an install that has never touched the new keys. */
export const DEFAULT_LOVE_POLICY: LovePolicy = {
  fromLovedFlag: true,
  fromRating: false,
  ratingThreshold: 80,
}

/** Clamps a persisted threshold into the meaningful band (0/NaN/5/150 are data noise).
 *  Never returns a value the settings row cannot display. */
export function normalizeLoveRatingThreshold(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LOVE_POLICY.ratingThreshold
  return Math.min(LOVE_RATING_MAX, Math.max(LOVE_RATING_MIN, Math.round(value)))
}

export function resolveLovePolicy(s: LovePolicySettings | undefined | null): LovePolicy {
  return {
    fromLovedFlag: s?.scrobbleLoveFromLoved ?? DEFAULT_LOVE_POLICY.fromLovedFlag,
    fromRating: s?.scrobbleLoveFromRating ?? DEFAULT_LOVE_POLICY.fromRating,
    ratingThreshold: normalizeLoveRatingThreshold(s?.scrobbleLoveRatingThreshold),
  }
}

/** Maps a metadata row (or a missing row) onto the signals the policy reads. */
export function loveSignalsOf(row: Pick<LocalMetadataStore, 'loved' | 'rating'> | undefined | null): LoveSignals | null {
  if (!row) return null
  return { loved: !!row.loved, rating: Number(row.rating) || 0 }
}

export function shouldScrobbleAsLoved(signals: LoveSignals | null | undefined, policy: LovePolicy): boolean {
  if (!signals) return false
  if (policy.fromLovedFlag && signals.loved) return true
  if (policy.fromRating && signals.rating >= policy.ratingThreshold) return true
  return false
}

export interface LoveChangePlan {
  /** True when the outbound heart must be (re)sent. */
  deliver: boolean
  /** The polarity to deliver when `deliver` is true. */
  loved: boolean
}

/**
 * The flip-path decision: deliver only when the EFFECTIVE state moved. With the
 * rating signal active, un-hearting a track that still clears the threshold
 * sends nothing (its effective state is unchanged), and a rating that crosses
 * the threshold delivers the heart even though the ♥ flag never moved.
 */
export function planLoveChange(
  prev: LoveSignals | null,
  next: LoveSignals,
  policy: LovePolicy,
): LoveChangePlan {
  const was = shouldScrobbleAsLoved(prev, policy)
  const is = shouldScrobbleAsLoved(next, policy)
  return { deliver: was !== is, loved: is }
}
