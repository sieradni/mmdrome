/**
 * Pure transcoding + low-data policy (F2: no stores, no DOM — pinned by
 * tests/transcodePolicy.test.ts). The manager/networkMode adapters feed it
 * inputs and apply the decision; this module owns ALL the rules.
 *
 * Server semantics verified against Navidrome master (core/stream/
 * legacy_client.go + consts/consts.go): an explicit `format` forces a
 * transcode profile at `maxBitRate`; bitrate-only caps downsample via the
 * server's DefaultDownsamplingFormat; source at/below the cap with no format
 * direct-plays raw. `format=raw` bypasses everything. Sending maxBitRate
 * universally is therefore free for files already under the cap.
 *
 * Default format is opus (user decision 2026-09-06, corroborated by
 * Navidrome's own `DefaultDownsamplingFormat = "opus"`); mp3 is an automatic
 * fallback ONLY when the per-device capability probe failed for the chosen
 * format — never a silent downgrade.
 */

export type TranscodeMode = 'off' | 'lowData' | 'always'

/** The formats Navidrome ships built-in transcode commands for (consts.go). */
export const BUILTIN_TRANSCODE_FORMATS = ['opus', 'mp3', 'aac', 'flac'] as const

/** Canonical cover sizes — Navidrome caches resizes per size, so arbitrary
 *  values would trigger one-off resize jobs. Stick to these. */
export type CanonicalThumbSize = 96 | 128 | 256 | 512

/** Server fallback constant (consts.fallbackBitrate) — kept for UI hints. */
export const SERVER_FALLBACK_BITRATE = 256

export interface TranscodeInput {
  mode: TranscodeMode | undefined
  lowDataActive: boolean
  /** Credentials present — without a config there is no stream URL to decorate. */
  hasConfig: boolean
  /** Persisted capability-probe verdict for the CHOSEN format is 'unsupported'
   *  → the mp3 fallback applies (formatProbe.ts). */
  probeFailed?: boolean
}

export interface TranscodeParams {
  format: string
  maxBitRate: number
}

/**
 * The ONE decision every stream-URL call site uses. A `null` return means
 * "build the URL exactly as before" (byte-identical legacy behavior); a
 * non-null return carries the EFFECTIVE format (probe fallback already
 * resolved) and the bitrate cap.
 */
export function transcodeParams(input: TranscodeInput, chosenFormat: string | undefined, bitrate: number | undefined): TranscodeParams | null {
  if (!input.hasConfig) return null
  const mode = input.mode ?? 'off'
  if (mode === 'off') return null
  if (mode === 'lowData' && !input.lowDataActive) return null
  return { format: resolveTranscodeFormat(chosenFormat, !!input.probeFailed), maxBitRate: bitrate ?? 128 }
}

/**
 * Resolves the EFFECTIVE stream format: the user's choice, or mp3 when the
 * capability probe failed for it on this device (probe state carried by the
 * caller; `probeFailed` is only ever true after a real failed probe — no
 * probe pass, no fallback, ever).
 */
export function resolveTranscodeFormat(chosen: string | undefined, probeFailed: boolean): string {
  const fmt = (chosen ?? 'opus').trim().toLowerCase()
  if (probeFailed && fmt !== 'mp3') return 'mp3'
  return fmt
}

/** Lossless targets ignore bitrate server-side — the UI hides the picker. */
export function isLosslessTranscodeFormat(format: string): boolean {
  return format === 'flac' || format === 'wav' || format === 'alac'
}

export interface ThumbSizeInput {
  /** The context's canonical size (128 rows / 256 grids / 512 now-playing). */
  size: number
  lowDataActive: boolean
}

/**
 * LDM steps thumbnails DOWN one canonical level (512→256, 256→128, 128→96);
 * 96 stays. Failure mode is cosmetic blur only. Returns canonical sizes only
 * so the server's disk-cached resizes are reused.
 */
export function effectiveThumbSize(input: ThumbSizeInput): number {
  if (!input.lowDataActive) return input.size
  if (input.size >= 512) return 256
  if (input.size >= 256) return 128
  if (input.size >= 128) return 96
  return input.size
}
