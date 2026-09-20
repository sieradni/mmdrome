/**
 * Truncation evidence at the web `ended` boundary — the pure predicate behind
 * the OBSERVE-ONLY web mirror of the native premature-completion gate
 * (2026-09-20; the native elapsed gate's counterpart, logged from
 * WebTransport's `_onEnded`).
 *
 * Why a predicate, not inline: the decision (would we call this end early?)
 * is the testable contract; the logging is the glue. When the field data
 * justifies ACTING on it (the ledger's item #2 — drop + evict + bounded
 * retry like native), the same predicate flips from observe to enforce and
 * the tests already pin its edge behavior.
 *
 * The physics (mirrors the native 2026-09-18 analysis): a stream cut
 * mid-body fires `ended` when the DELIVERED data runs out, while the
 * container's metadata duration (FLAC STREAMINFO / MP4 moov / Ogg granule
 * layout) still claims full length. `ended` + `currentTime` well short of
 * `duration` is therefore the web's one cut-position-independent signal —
 * cheap, synchronous, and available on EVERY element without infrastructure.
 *
 * The `buffered`-end variant is deliberately NOT part of the verdict: a
 * fully-played healthy stream ALSO drains its buffer by the end (the browser
 * evicts played ranges), so buffered-end < duration is normal, not evidence.
 */

export interface TruncationEvidenceInput {
  /** The element's currentTime at the `ended` event. */
  currentTime: number
  /** The metadata duration (NaN/0/Infinity when unknown — treated as unknown). */
  duration: number
  /** How far short of duration counts as evidence. The transport's margin
   *  (1.5 s) absorbs codec delay/presentation padding; a legit end lands
   *  within milliseconds. */
  marginSeconds: number
}

export type TruncationVerdict =
  | { kind: 'unknown-duration' }
  | { kind: 'plausible' }
  | { kind: 'ended-early'; shortfallSeconds: number }

export function assessEnded(input: TruncationEvidenceInput): TruncationVerdict {
  const { currentTime, duration, marginSeconds } = input
  // Unknown duration (NaN / 0 / Infinity): metadata never arrived or is
  // degenerate — there is nothing to be short OF. Never evidence.
  if (!Number.isFinite(duration) || duration <= 0) return { kind: 'unknown-duration' }
  const shortfall = duration - currentTime
  if (shortfall > marginSeconds) {
    return { kind: 'ended-early', shortfallSeconds: Number(shortfall.toFixed(2)) }
  }
  return { kind: 'plausible' }
}
