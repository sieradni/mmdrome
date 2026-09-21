import { get } from 'svelte/store'
import { Capacitor } from '@capacitor/core'
import { settings, updateSetting } from '../stores/appState'
import { getCachedConfig, buildStreamUrl } from './navidromeApi'
import { nativeEngine } from './nativePlugin'

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
 * platform, independent of any webview. 'unsupported' here only suppresses a
 * probe that would measure the wrong stack; it never upgrades anything to
 * 'ok'.
 *
 * VERSION-GATED opus (2026-09-21 field correction): the 1.2.30 table shipped
 * saying iOS opus = unsupported — true for old iOS, but the user's iOS 26/27
 * device plays raw Ogg-Opus through AVAudioFile fine (the native engine's own
 * `AVAudioFile(forReading:)` probe accepted every preloaded opus file). The
 * codec landscape moved: modern CoreAudio opens Ogg-Opus. iOS 18+ reads 'ok'
 * (conservative floor — older devices keep mp3 as the LDM transcode target,
 * the safe default for a codec we cannot probe natively).
 */
const IOS_OPUS_OK_MIN_MAJOR = 18

/**
 * The OS version comes from the NATIVE BRIDGE (2026-09-21e, the persisted
 * `opus: unsupported` on an iOS 26/27 device): the WKWebView UA guess was
 * wrong in the field — the UA on a Capacitor build does not reliably carry
 * an iOS-tracking `Version/<major>` token, the parse returned 0, and the
 * version gate conservatively pinned 'unsupported' → the mp3 LDM fallback
 * the user could hear. `ProcessInfo.operatingSystemVersion` is authoritative;
 * the plugin exposes it as `getOsVersion { major }` (registered in
 * pluginMethods — the §3.4 getMethod gate drops unregistered names). Absent
 * bridge (web/old build) → null → caller falls back to the UA parse.
 * Exported pure for the test suite.
 */
export function iosMajorVersionForTest(ua: string): number {
  const m = /Version\/(\d+)\.\d+/.exec(ua)
  return m ? parseInt(m[1], 10) : 0
}

async function iosMajorVersion(): Promise<number> {
  try {
    if (Capacitor.getPlatform() !== 'ios') return 0
    const bridge = nativeEngine as unknown as { getOsVersion?: (o?: object) => Promise<{ major?: number }> }
    if (typeof bridge.getOsVersion === 'function') {
      const res = await bridge.getOsVersion()
      const major = Number(res?.major)
      if (Number.isFinite(major) && major > 0) return major
    }
    return iosMajorVersionForTest(navigator.userAgent)
  } catch {
    return 0
  }
}

const NATIVE_VERDICTS: Record<string, 'ok' | 'unsupported'> = {
  mp3: 'ok',
  aac: 'ok',
  flac: 'ok',
  // Opus/ogg are resolved per-call (async OS-version read) — not in this
  // static map; nativeVerdictFor consults them via `resolvedNativeVerdict`.
}

let cachedOsMajor: number | null = null

/**
 * The synchronous verdict path for the STATIC table (mp3/aac/flac) plus the
 * async opus/ogg resolution. `ensureFormatProbe` awaits this before answering;
 * the OS major is read once per session and cached (it cannot change mid-run).
 */
async function resolvedNativeVerdict(format: string): Promise<'ok' | 'unsupported' | null> {
  if (Capacitor.getPlatform() !== 'ios') return null // android/web — probe path
  const staticVerdict = NATIVE_VERDICTS[format]
  if (staticVerdict) return staticVerdict
  if (format === 'opus' || format === 'ogg') {
    if (cachedOsMajor === null) cachedOsMajor = await iosMajorVersion()
    return cachedOsMajor >= IOS_OPUS_OK_MIN_MAJOR ? 'ok' : 'unsupported'
  }
  return null
}

/**
 * Boot-time sync: force the STATIC table over any persisted verdict (2026-09-21
 * regression fix). The 1.2.30 bootstrap only wrote table entries the map was
 * MISSING — it never overwrote stale rows the old WEBVIEW probe had persisted
 * ('aac: unsupported' rode forever even though the table says ok). Every boot
 * now reconciles the whole native-known map; rows outside the table are
 * untouched (the web probe owns them). Opus/ogg resolve through the SAME map
 * once `resolvedNativeVerdict` has computed them (the OS-version gate result
 * is passed in by `ensureFormatProbe`, which awaits the bridge read).
 */
function syncNativeVerdicts(verdicts: Record<string, 'ok' | 'unsupported'>): void {
  if (Capacitor.getPlatform() !== 'ios') return
  const current = get(settings).transcodeProbe ?? {}
  const next = { ...current }
  let changed = false
  for (const [format, verdict] of Object.entries(verdicts)) {
    if (next[format] !== verdict) {
      next[format] = verdict
      changed = true
    }
  }
  if (changed) updateSetting('transcodeProbe', next)
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
  // native engine never uses. The static table above is the native truth —
  // opus/ogg included (the OS-version gate reads the REAL OS version from the
  // native bridge; the UA guess misfired in the field and pinned mp3).
  const native = await resolvedNativeVerdict(format)
  if (native !== null) {
    // Sync the FULL effective table (static rows + this format's verdict) over
    // any persisted rows — the 2026-09-21d bootstrap's partial-write hole let
    // stale 'unsupported' entries ride forever.
    const effective: Record<string, 'ok' | 'unsupported'> = { ...NATIVE_VERDICTS, [format]: native }
    syncNativeVerdicts(effective)
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

