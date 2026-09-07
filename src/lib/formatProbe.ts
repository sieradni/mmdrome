import { get } from 'svelte/store'
import { settings, updateSetting } from '../stores/appState'
import { getCachedConfig, buildStreamUrl } from './navidromeApi'

/**
 * Per-device codec capability probe (low-data/transcoding plan, PR-D).
 *
 * One-shot check per format at connect: an `new Audio()` element is fed a real
 * ~1 s transcoded response (`maxBitRate=16` keeps the sample tiny), so BOTH
 * the device decoder stack AND the server's ability to produce the format are
 * verified. Verdicts persist in the settings store (the DOM never survives a
 * reload, so the persisted flag is the cache); a FAILED probe retries on the
 * next app start — OS updates can add support, and the fallback must
 * un-fall-back. No probe pass is ever required: absence of evidence never
 * triggers the mp3 fallback (the plan's "necessity demonstrated, not assumed").
 *
 * Node/test safety: the whole function body is guarded — under `node --test`
 * there is no `Audio` constructor and no cached config, so it resolves
 * `unknown` without touching the DOM. Verdict writes go through
 * `updateSetting` so the persisted settings row stays the single source.
 */

export type FormatVerdict = 'ok' | 'unsupported' | 'unknown'

export interface FormatProbeDeps {
  audioFactory: () => HTMLAudioElement
  now: () => number
}

const defaultDeps = (): FormatProbeDeps => ({
  audioFactory: () => new Audio(),
  now: () => Date.now(),
})

const PROBE_TIMEOUT_MS = 8000

export interface ProbeOutcome {
  verdict: FormatVerdict
  /** The format the verdict applies to (post-fallback resolution is NOT stored). */
  format: string
}

async function probeFormatOnce(format: string, songId: string, deps: FormatProbeDeps): Promise<FormatVerdict> {
  const config = getCachedConfig()
  if (!config || !songId) return 'unknown'
  const audio = deps.audioFactory()
  if (!audio) return 'unknown'
  return new Promise<FormatVerdict>((resolve) => {
    let settled = false
    const finish = (verdict: FormatVerdict) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      audio.removeAttribute('src')
      try { audio.load() } catch { /* element already torn down */ }
      resolve(verdict)
    }
    const timer = window.setTimeout(() => finish('unknown'), PROBE_TIMEOUT_MS)
    audio.addEventListener('canplay', () => finish('ok'), { once: true })
    audio.addEventListener('error', () => finish('unsupported'), { once: true })
    // The raw URL (no resolveTranscodeFormat fallback wrap — this probe asks
    // the SERVER for the format too) needs a REAL song id: a fake one would
    // 404 and the element's `error` would falsely read as decode failure.
    // With a real id, 'ok' means the whole path works (even a server without
    // ffmpeg passes — it returns raw bytes, which IS playable end-to-end).
    audio.src = buildStreamUrl(config, songId, { format, maxBitRate: 16 })
    void audio.load()
  })
}

/**
 * Ensures a persisted verdict for `format`; returns the CURRENT effective
 * verdict. Fire-and-forget at connect: callers must not await boot on it.
 * `rawSongId` (a REAL navidrome song id, prefix stripped — usually the first
 * library track) is required: without one the probe is skipped (`unknown`).
 */
export async function ensureFormatProbe(
  format: string,
  rawSongId = '',
  deps: FormatProbeDeps = defaultDeps(),
): Promise<ProbeOutcome> {
  const probeMap = get(settings).transcodeProbe
  const existing = probeMap?.[format]
  if (existing === 'ok' || existing === 'unsupported') {
    return { verdict: existing, format }
  }
  const verdict = await probeFormatOnce(format, rawSongId, deps)
  // A `probe` (0 s timeout) is deliberately NOT persisted — a slow server on
  // one boot shouldn't pin a permanent mp3 fallback.
  if (verdict !== 'unknown') {
    updateSetting('transcodeProbe', { ...(get(settings).transcodeProbe ?? {}), [format]: verdict })
  }
  return { verdict, format }
}

