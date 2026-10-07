/**
 * Seek-capability declaration (2026-10-07, Phase 0 of
 * `docs/plans/2026-10-07-seek-intent-and-stream-epochs.md`).
 *
 * JS DECLARES, NATIVE EXECUTES. The snapshot carries a per-row prediction of
 * whether the server will honor a `timeOffset` re-encode, derived from the SAME
 * transcode decision that built the row's URL (one source of truth, no second
 * guess in Swift). It rides the existing `setQueue`/`refreshQueue` payload —
 * no new bridge method, no `pluginMethods` registration risk.
 *
 * The static rule (plan §2.5) must never cost CORRECTNESS, only work:
 *   - `canServerOffset = false` only when direct play is CERTAIN (requested
 *     format equals the source suffix AND the cap is known to be >= the source
 *     bitrate) or the URL is raw (no transcode params ⇒ the server's decider
 *     direct-plays, `format=raw` ignores the offset — facts 19/20);
 *   - otherwise `true`, and the engine's RUNTIME verdict is the authority: a
 *     false "can" costs one wasted request that the verdict demotes after a
 *     single header read, while a false "cannot" would disable epochs for every
 *     untagged row (`Track.bitrate` is optional).
 *
 * Pure module — no stores, no DOM (F2), pinned by tests/seekCapability.test.ts.
 */

export type SeekCapabilitySplice = 'flac' | 'ogg'

export interface SeekCapability {
  /** The server will re-encode from an offset (the engine still verifies). */
  canServerOffset: boolean
  /** Container proven splice-safe for a raw epoch. ABSENT = wait-only — Ogg
   *  stays unset until the Phase-3 fixture proof lands (never claim it). */
  clientSplice?: SeekCapabilitySplice
  /** The Subsonic query parameter name (Navidrome `timeOffset`). */
  paramName?: 'timeOffset'
  /** Source evidence for the direct-play prediction (rails/diagnostics). */
  sourceBitrate?: number
  sourceFileType?: string
}

export interface SeekCapabilityInput {
  /** The transcode decision that built this row's URL (null = raw URL). */
  transcode: { format: string; maxBitRate: number } | null
  fileType?: string
  bitrate?: number
}

/** True for containers whose byte layout supports a client-side raw splice
 *  once Phase 3 proves it; only FLAC is proven (Ogg is fixture-gated). */
function spliceFor(fileType: string | undefined): SeekCapabilitySplice | undefined {
  return fileType === 'flac' ? 'flac' : undefined
}

export function deriveSeekCapability(input: SeekCapabilityInput): SeekCapability {
  const cap: SeekCapability = { canServerOffset: false }
  const fileType = input.fileType?.trim().toLowerCase()
  if (fileType) cap.sourceFileType = fileType
  if (input.bitrate != null && input.bitrate > 0) cap.sourceBitrate = input.bitrate
  const splice = spliceFor(fileType)
  if (splice) cap.clientSplice = splice

  if (!input.transcode) {
    // Raw URL: no format param ⇒ Navidrome direct-plays the original bytes and
    // the offset is ignored (fact 20). Phase 3's raw splice is the raw lane.
    return cap
  }
  cap.paramName = 'timeOffset'
  const requested = input.transcode.format.trim().toLowerCase()
  // Direct play is CERTAIN: an explicit format equal to the source suffix,
  // with a cap known to cover the source. Unknown bitrate ⇒ not certain ⇒
  // err toward "can" (the runtime verdict is the authority).
  const directPlayCertain =
    fileType != null &&
    requested !== '' &&
    requested === fileType &&
    input.bitrate != null &&
    input.bitrate > 0 &&
    input.transcode.maxBitRate >= input.bitrate
  cap.canServerOffset = !directPlayCertain
  return cap
}
