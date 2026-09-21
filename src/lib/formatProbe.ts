import { get } from 'svelte/store'
import { Capacitor } from '@capacitor/core'
import { settings, updateSetting } from '../stores/appState'
import { getCachedConfig, buildStreamUrl } from './navidromeApi'

/**
 * Per-device codec capability probe (low-data/transcoding plan, PR-D).
 *
 * On NATIVE platforms the probe is BYPASSED (2026-09-21): the web-only Audio
 * element has no bearing on AVAudioFile's decoders, and the WKWebView probe
 * produced false 'unsupported' verdicts that persisted forever — pinning a
 * bogus mp3 fallback for the native engine. Native verdicts come from the
 * static per-platform table below instead (no probe is required — absence of
 * evidence never triggers the fallback, the plan's "necessity demonstrated,
 * not assumed"). A native 'unsupported' entry therefore only suppresses a
 * probe that would measure the WRONG stack.
 *
 * On the WEB the probe is unchanged: one-shot check per format at connect —
 * an `new Audio()` element is fed a real ~1 s transcoded response
 * (`maxBitRate=16` keeps the sample tiny), so BOTH the device decoder stack
 * AND the server's ability to produce the format are verified. Verdicts
 * persist in the settings store (the DOM never survives a reload, so the
 * persisted flag is the cache); a FAILED probe retries on the next app
 * start — OS updates can add support, and the fallback must un-fall-back.
 *
 * Node/test safety: the web body is guarded — under `node --test` there is
 * no `Audio` constructor and no cached config, so it resolves `unknown`
 * without touching the DOM. Verdict writes go through `updateSetting` so the
 * persisted settings row stays the single source.
 */

export type FormatVerdict = 'ok' | 'unsupported' | 'network' | 'unknown'

export interface FormatProbeDeps {
  audioFactory: () => HTMLAudioElement
  now: () => number
}

const defaultDeps = (): FormatProbeDeps => ({
  audioFactory: () => new Audio(),
  now: () => Date.now(),
})

const PROBE_TIMEOUT_MS = 8000

/**
 * Static NATIVE decode verdicts — what AVAudioFile / CoreAudio decodes on the
 * platform, independent of any webview. This is the truth the web probe
 * cannot measure: iOS natively decodes AAC/M4A, MP3, FLAC, ALAC, PCM
 * (platform stack — Apple's documented CoreAudio formats); Ogg and Opus are
 * NOT supported natively. Web (the WKWebView's webkit codecs for
 * HTMLAudioElement) handles AAC/MP3/FLAC but not raw Ogg.
 * 'unsupported' here suppresses the web probe for that format (measuring the
 * wrong stack); it never upgrades anything to 'ok'.
 */
const NATIVE_VERDICTS: Record<string, Record<string, 'ok' | 'unsupported'>> = {
  ios: {
    mp3: 'ok',
    aac: 'ok',
    flac: 'ok',
    opus: 'unsupported',
    ogg: 'unsupported',
  },
  android: {
    // Android's MediaCodec/MediaExtractor stack handles these natively;
    // extended formats exist but 'ok' here only skips a probe for formats
    // any modern device decodes.
    mp3: 'ok',
    aac: 'ok',
    flac: 'ok',
    opus: 'ok',
    ogg: 'ok',
  },
}

function nativeVerdictFor(format: string): 'ok' | 'unsupported' | null {
  const platform = Capacitor.getPlatform() // 'ios' | 'android' | 'web'
  const table = NATIVE_VERDICTS[platform]
  if (!table) return null // web — probe path
  const hit = table[format]
  return hit ?? null // unknown format on native: nothing to skip a probe for
}

export interface ProbeOutcome {
  verdict: FormatVerdict
  /** The format the verdict applies to (post-fallback resolution is NOT stored). */
  format: string
}

/**
 * TWO-PHASE probe (2026-09-08): the old single-shot design fed the stream URL
 * straight to an Audio element, so a NETWORK failure (offline boot, captive
 * portal, server down) or an ERROR-JSON body (stale song id after a server
 * switch) fired the element's `error` event and got branded 'unsupported' —
 * a permanent false "this device can't decode X" for devices that play X
 * fine every day. Phase 1 fetches the tiny sample with plain fetch (Navidrome
 * is CORS-enabled, §3.3) and classifies transport problems as 'network'
 * (never persisted → retried next boot); a JSON-looking body (a Subsonic
 * error payload, not media) is 'network' too. Phase 2 hands the RECEIVED
 * bytes to the element via a blob URL — only an `error` after real media
 * bytes is a genuine decode failure ('unsupported').
 */
async function probeFormatOnce(format: string, songId: string, deps: FormatProbeDeps): Promise<FormatVerdict> {
  const config = getCachedConfig()
  if (!config || !songId) return 'unknown'
  const audio = deps.audioFactory()
  if (!audio) return 'unknown'

  // Phase 1 — transport: fetch the sample bytes ourselves.
  const controller = new AbortController()
  const fetchTimer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  let blob: Blob
  try {
    const res = await fetch(buildStreamUrl(config, songId, { format, maxBitRate: 16 }), {
      signal: controller.signal,
    })
    if (!res.ok) return 'network'
    blob = await res.blob()
  } catch {
    return 'network'
  } finally {
    window.clearTimeout(fetchTimer)
  }
  // A Subsonic error payload is JSON, not media — a server problem, not a
  // device codec gap. (The element would fire `error` on it; do not persist.)
  const head = new Uint8Array(await blob.slice(0, 1).arrayBuffer())
  if (head[0] === 0x7b /* { */ || head[0] === 0x5b /* [ */) return 'network'

  // Phase 2 — decode: real bytes in the element. `error` here IS the device.
  const objectUrl = URL.createObjectURL(blob)
  return new Promise<FormatVerdict>((resolve) => {
    let settled = false
    const finish = (verdict: FormatVerdict) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      audio.removeAttribute('src')
      try { audio.load() } catch { /* element already torn down */ }
      try { URL.revokeObjectURL(objectUrl) } catch { /* already revoked */ }
      resolve(verdict)
    }
    const timer = window.setTimeout(() => finish('unknown'), PROBE_TIMEOUT_MS)
    audio.addEventListener('canplay', () => finish('ok'), { once: true })
    audio.addEventListener('error', () => finish('unsupported'), { once: true })
    audio.src = objectUrl
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
  if (!format) return { verdict: 'unknown', format }
  // NATIVE BYPASS: the web probe measures the WKWebView's decoders, which the
  // native engine never uses. The static table above is the native truth.
  // A native 'unsupported' entry is PERSISTED so the user-visible probe
  // status reads honestly (e.g. iOS opus → unsupported), and it suppresses
  // any future web-probe attempt for that format (the wrong stack).
  const native = nativeVerdictFor(format)
  if (native !== null) {
    const probeMap = get(settings).transcodeProbe
    if (probeMap?.[format] !== native) {
      updateSetting('transcodeProbe', { ...(get(settings).transcodeProbe ?? {}), [format]: native })
    }
    return { verdict: native, format }
  }
  const probeMap = get(settings).transcodeProbe
  const existing = probeMap?.[format]
  if (existing === 'ok' || existing === 'unsupported') {
    return { verdict: existing, format }
  }
  const verdict = await probeFormatOnce(format, rawSongId, deps)
  // `unknown` (0 s timeout) and `network` (offline boot / server down / error
  // JSON) are deliberately NOT persisted — a slow server on one boot, or a
  // captive portal, must not pin a permanent mp3 fallback. Only a verdict
  // backed by real received bytes that the ELEMENT rejected is 'unsupported'.
  if (verdict !== 'unknown' && verdict !== 'network') {
    updateSetting('transcodeProbe', { ...(get(settings).transcodeProbe ?? {}), [format]: verdict })
  }
  return { verdict, format }
}

