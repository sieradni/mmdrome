import { get } from 'svelte/store'
import { Capacitor } from '@capacitor/core'
import { settings, updateSetting } from '../stores/appState'
import { getCachedConfig, buildStreamUrl } from './navidromeApi'
import { nativeEngine } from './nativePlugin'
import { appVersion } from './version'

/**
 * Per-device codec capability probe (low-data/transcoding plan, PR-D).
 *
 * ONE PROBE PHILOSOPHY ON BOTH PLATFORMS (2026-09-21, "what is the point of
 * checking if it doesn't actually verify"): a verdict is only ever backed by
 * EVIDENCE — real bytes fed to the decoder that actually plays audio. The
 * earlier native shortcut (a static per-platform table, then an OS-version
 * gate) decided codec support with zero evidence and field-pinned a bogus
 * mp3 fallback twice; lookup tables wearing a probe's clothes are worse
 * than no probe, because their wrong answers persist forever while looking
 * authoritative.
 *
 * - WEB: fetch a tiny ~1 s server-transcoded sample (`maxBitRate=16`), then
 *   feed the RECEIVED bytes to an `Audio` element via a blob URL. The
 *   element's decoder is the browser stack the web engine uses.
 * - NATIVE (iOS): the SAME sample URL goes over the bridge
 *   (`probeFormat`); the native loader writes the bytes to a temp file and
 *   hands them to `AVAudioFile` — the exact decoder the playback graph
 *   uses — and reads frames. An 'ok' verdict is therefore proof the engine
 *   can play the format, on that device, today.
 *
 * TWO-PHASE, both platforms (2026-09-08): transport problems (offline
 * boot, captive portal, server down) and non-media bodies (a Subsonic
 * error-JSON payload) classify as 'network' — never persisted, retried at
 * the next boot. Only an `error`/decode failure AFTER real media bytes is
 * 'unsupported' — the device, not the network.
 *
 * Verdicts persist in the settings store (`transcodeProbe`); 'ok' and
 * 'unsupported' both persist (evidence-backed), 'network'/'unknown' never
 * do (a flaky boot must not pin a permanent fallback). Node/test safety:
 * under `node --test` there is no Audio constructor, no cached config, and
 * no bridge — every path degrades to 'unknown' without touching the DOM.
 */

export type FormatVerdict = 'ok' | 'unsupported' | 'network' | 'unknown'

export interface FormatProbeDeps {
  audioFactory: () => HTMLAudioElement
  now: () => number
  /** NATIVE injection point: the bridge probe call. Defaults to
   *  `nativeEngine.probeFormat`; tests inject a fake. Absent on web/node. */
  nativeProbe?: (url: string) => Promise<{ verdict: string; detail: string }>
}

const defaultDeps = (): FormatProbeDeps => ({
  audioFactory: () => new Audio(),
  now: () => Date.now(),
})

const PROBE_TIMEOUT_MS = 8000

/**
 * PURE persistence decision (exported for the test suite): given the
 * current probe map, a format, and a fresh verdict — should it be stored,
 * and what does the next map look like? Evidence-backed verdicts
 * ('ok'/'unsupported') persist and OVERWRITE stale rows (a device that
 * gained or lost decode support via an OS update must converge);
 * 'network'/'unknown' leave the map untouched (no evidence → no pin).
 */
export function applyProbeResult(
  current: Record<string, FormatVerdict> | undefined,
  format: string,
  verdict: FormatVerdict,
): { persist: boolean; next: Record<string, FormatVerdict> } {
  const base: Record<string, FormatVerdict> = { ...(current ?? {}) }
  if (verdict === 'ok' || verdict === 'unsupported') {
    if (base[format] !== verdict) {
      base[format] = verdict
      return { persist: true, next: base }
    }
    return { persist: false, next: base }
  }
  return { persist: false, next: base }
}

/**
 * F5 (2026-09-22 field dump): the PROBE-STAMP gate. Verdicts persisted by
 * the 1.2.30 static-table regression shipped inside `transcodeProbe` with
 * NO provenance — the short-circuit in `ensureFormatProbe` then trusted
 * them forever, so an iOS 27 device kept its bogus "opus unsupported" pin
 * even after the probe became evidence-based (the real probe WOULD answer
 * 'ok'). PURE decision, pinned in tests: a map that carries no stamp (the
 * legacy shape) is stale by definition; a map stamped by an older app
 * version is stale; same-version is fresh.
 */
export const PROBE_STAMP_KEY = '__probedBy'

export function probeMapIsStale(
  map: Record<string, FormatVerdict> | undefined,
  currentVersion: string,
): boolean {
  if (!map) return false // empty = nothing cached, the probe runs anyway
  const stamp = (map as Record<string, unknown>)[PROBE_STAMP_KEY]
  if (typeof stamp !== 'string') return true // legacy map — table-era verdicts
  return stamp !== currentVersion
}

/**
 * Pure: stamp a probe map with the app version that produced it. Called on
 * every persist so the map always carries provenance.
 */
export function stampProbeMap(
  map: Record<string, FormatVerdict>,
  version: string,
): Record<string, FormatVerdict> {
  return { ...map, [PROBE_STAMP_KEY]: version } as Record<string, FormatVerdict>
}

/**
 * The NATIVE probe (2026-09-21, evidence-based): one bridge call with the
 * same tiny-sample URL the web probe builds. The bridge returns
 * 'ok' | 'unsupported' | 'network' + a diagnostic detail string. Errors
 * (old build without the method, bridge hiccup) → 'unknown' — same
 * not-persisted semantics as a web timeout.
 */
async function nativeProbeOnce(
  format: string,
  rawSongId: string,
  deps: FormatProbeDeps,
): Promise<FormatVerdict> {
  const config = getCachedConfig()
  if (!config || !rawSongId) return 'unknown'
  const probe = deps.nativeProbe ?? ((url: string) => nativeEngine.probeFormat({ url }))
  const url = buildStreamUrl(config, rawSongId, { format, maxBitRate: 16 })
  try {
    const res = await probe(url)
    if (res?.verdict === 'ok' || res?.verdict === 'unsupported' || res?.verdict === 'network') {
      return res.verdict
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export interface ProbeOutcome {
  verdict: FormatVerdict
  /** The format the verdict applies to (post-fallback resolution is NOT stored). */
  format: string
}

/**
 * TWO-PHASE WEB probe (2026-09-08): the old single-shot design fed the stream URL
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
 *
 * An ALREADY-persisted evidence-backed verdict short-circuits the probe
 * (one check per format per install — the same cache semantics on both
 * platforms). 'network'/'unknown' outcomes never persist, so the next app
 * start re-probes: OS updates can add support, and the fallback must
 * un-fall-back.
 */
export async function ensureFormatProbe(
  format: string,
  rawSongId = '',
  deps: FormatProbeDeps = defaultDeps(),
  /** F5: skip the cached-verdict short-circuit (the Settings test button —
   *  a stale pin must be re-testable on demand). */
  force = false,
): Promise<ProbeOutcome> {
  if (!format) return { verdict: 'unknown', format }
  const probeMap = get(settings).transcodeProbe as Record<string, FormatVerdict> | undefined
  // F5 stamp gate: verdicts persisted before the current app version (or by
  // the pre-stamp table era) are stale — they re-probe this boot. A stale
  // map must never short-circuit the probe that can correct it.
  if (!force && !probeMapIsStale(probeMap, appVersion)) {
    const existing = probeMap?.[format]
    if (existing === 'ok' || existing === 'unsupported') {
      return { verdict: existing, format }
    }
  }
  const verdict = Capacitor.isNativePlatform()
    ? await nativeProbeOnce(format, rawSongId, deps)
    : await probeFormatOnce(format, rawSongId, deps)
  const { persist, next } = applyProbeResult(probeMap, format, verdict)
  if (persist) {
    // Every persist re-stamps provenance (F5) — the map can never go back
    // to the unversioned shape that trusted 1.2.30's table verdicts.
    updateSetting('transcodeProbe', stampProbeMap(next, appVersion) as Record<string, 'ok' | 'unsupported'>)
  }
  return { verdict, format }
}
