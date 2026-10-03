/**
 * Adapter half of the Streaming Self-Test (2026-10-02): probes the REAL
 * transcode URL over HTTP and captures the native `stream` transcript, then
 * hands both to the pure evaluator in `streamVerification.ts`.
 *
 * Designed for ONE PRESS with a paste-ready result:
 *  - the HTTP probe rebuilds the exact URL the manager would use and reads
 *    Content-Length / Accept-Ranges / Content-Type / container magic with no
 *    audio at all;
 *  - the native capture mines a LOOK-BACK window out of the event ring first
 *    (a track already playing when the button was pressed is still captured),
 *    then keeps polling forward. It is read-only: it never plays, seeks or
 *    mutates the queue;
 *  - the assembled bundle (header, HTTP facts, state sample, verdict table,
 *    raw event lines) is returned as text and auto-copied by the caller.
 */
import { Capacitor } from '@capacitor/core'
import { get } from 'svelte/store'
import { settings, currentTrack, playbackState } from '../stores/appState'
import { effectiveLowData, networkStatusStore, networkStabilitySnapshot } from './networkMode'
import { getCachedConfig, buildStreamUrl } from './navidromeApi'
import { transcodeParams } from './transcodePolicy'
import { nativeEngine, BackgroundAudio } from './nativePlugin'
import { appVersion } from './version'
import {
  type HttpProbeFacts,
  type NativeStreamFacts,
  type StreamVerifyReport,
  type NativeEventLike,
  emptyNativeStreamFacts,
  foldStreamEvent,
  selectStreamWindow,
  evaluateStreamVerification,
  sniffContainer,
  formatStreamVerifyBundle,
} from './streamVerification'

/** The exact transcode decision the manager uses (mirrors
 *  `PlaybackManager._activeTranscode` — one decision, read the same way). */
export function activeTranscodeParams(): { format: string; maxBitRate: number } | null {
  const s = get(settings)
  return transcodeParams(
    {
      mode: s.transcodeMode,
      lowDataActive: get(effectiveLowData),
      hasConfig: !!getCachedConfig(),
      probeFailed: s.transcodeProbe?.[s.transcodeFormat ?? 'opus'] === 'unsupported',
    },
    s.transcodeFormat,
    s.transcodeBitrate,
  )
}

/** The URL this app would stream the current track from right now. */
export function currentStreamProbeUrl(): { url: string; variant: string } | null {
  const track = get(currentTrack)
  const config = getCachedConfig()
  if (!track || !config) return null
  const transcode = activeTranscodeParams()
  const url = buildStreamUrl(config, track.trackId.replace(/^navidrome-/, ''), transcode ?? undefined)
  const variant = transcode ? `${transcode.format}@${transcode.maxBitRate}` : 'raw'
  return { url, variant }
}

const PROBE_MAX_BYTES = 262_144

/** Bounded body read: never let a Range-ignoring server pull a whole file. */
async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  try {
    const reader = res.body?.getReader()
    if (!reader) {
      const buf = new Uint8Array(await res.arrayBuffer())
      return buf.slice(0, Math.min(buf.length, maxBytes))
    }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        const take = value.subarray(0, Math.max(0, maxBytes - total))
        chunks.push(take)
        total += take.length
      }
      if (total >= maxBytes) break
    }
    void reader.cancel().catch(() => {})
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      out.set(c, off)
      off += c.length
    }
    return out
  } catch {
    return new Uint8Array()
  }
}

/**
 * Probe the transcode URL. Uses a Range GET; on any failure (CORS preflight on
 * the custom header, network) retries a plain GET, then gives up with a note.
 * Never throws — the bundle carries the reason.
 */
export async function probeTranscodeHttp(url: string): Promise<HttpProbeFacts | null> {
  const attempt = async (withRange: boolean): Promise<HttpProbeFacts> => {
    const res = withRange
      ? await fetch(url, { headers: { Range: `bytes=0-${PROBE_MAX_BYTES - 1}` } })
      : await fetch(url)
    const body = await readBounded(res, PROBE_MAX_BYTES)
    const cl = res.headers.get('content-length')
    return {
      status: res.status,
      contentLength: cl ? Number(cl) : null,
      acceptRanges: res.headers.get('accept-ranges'),
      contentType: res.headers.get('content-type'),
      contentRange: res.headers.get('content-range'),
      bytesRead: body.length,
      sniffed: sniffContainer(body),
    }
  }
  try {
    return await attempt(true)
  } catch {
    try {
      return await attempt(false)
    } catch (e) {
      return {
        status: 0,
        contentLength: null,
        acceptRanges: null,
        contentType: null,
        contentRange: null,
        bytesRead: 0,
        sniffed: 'other',
        note: String((e as Error)?.message ?? e),
      }
    }
  }
}

type StateSample = {
  deliveredBytes: number
  announcedBytes: number
  headerClaimFrames: number
  metadataFrames: number
  scheduledEndFrames?: number
  stalled?: boolean
  recentRate?: number
}

interface RawEvent extends NativeEventLike {
  seq?: number
  t?: number
}

/** Domains worth keeping verbatim in the bundle — the streaming story plus
 *  the surrounding context a reader needs to adjudicate it. */
const RAW_DOMAINS = new Set(['stream', 'loader', 'preload', 'network', 'engine'])

/** `base` is the OLDEST captured event's `t` in MONOTONIC SECONDS (native
 *  `EventLog` timestamps are seconds since process start, never epoch ms — the
 *  1.2.48 look-back bug). */
function fmtRawEv(ev: RawEvent, base: number): string {
  const rel = typeof ev.t === 'number' ? `+${(ev.t - base).toFixed(3)}s` : '     ?'
  return `${rel} ${(ev.level ?? 'info').padEnd(6)} ${(ev.domain ?? '?').padEnd(7)} ${ev.msg}`
}

/**
 * True while the native engine has a staged schedule engaged — i.e. a
 * transcode is being written and/or played right now.
 *
 * The HTTP probe MUST NOT run then (2026-10-02b field report): it would fire a
 * SECOND concurrent GET at the still-running transcode — the same request the
 * report shows dying with a URLSession parse failure at 99.65 % of the body —
 * and it would read Navidrome's IN-PROGRESS output, which it serves whole
 * (200), so the Range verdict would describe the moment rather than the server
 * (the same server answered 206 once its transcode had completed and cached).
 */
async function stagedStreamActive(): Promise<boolean> {
  try {
    const d = await (BackgroundAudio as unknown as { getDebugState?: () => Promise<Record<string, unknown>> }).getDebugState?.()
    return d?.streamActive === true
  } catch {
    return false
  }
}

async function readStateSample(): Promise<StateSample | null> {
  try {
    const d = await (BackgroundAudio as unknown as { getDebugState?: () => Promise<Record<string, unknown>> }).getDebugState?.()
    if (!d) return null
    const sample: StateSample = {
      deliveredBytes: Number(d.streamDeliveredBytes ?? 0),
      announcedBytes: Number(d.streamAnnouncedBytes ?? 0),
      headerClaimFrames: Number(d.streamHeaderClaimedFrames ?? 0),
      metadataFrames: Number(d.streamMetadataFrames ?? 0),
      scheduledEndFrames: Number(d.streamScheduledEndFrames ?? 0),
      stalled: d.streamStalled === true,
      recentRate: Number(d.streamRecentRate ?? 0),
    }
    return d.streamActive === true && sample.deliveredBytes > 0 ? sample : null
  } catch {
    return null
  }
}

export interface StreamSelfTestBundle {
  report: StreamVerifyReport
  text: string
  http: HttpProbeFacts | null
  native: NativeStreamFacts | null
  stateSample: StateSample | null
  rawLines: string[]
}

let lastBundle: StreamSelfTestBundle | null = null

export function getLastStreamVerifyBundle(): StreamSelfTestBundle | null {
  return lastBundle
}

export function clearStreamVerifyReport(): void {
  lastBundle = null
}

export interface RunStreamSelfTestOptions {
  /** How long to keep polling forward after the look-back (default 25 s;
   *  0 = HTTP probe only). */
  captureMs?: number
  /** How far back into the event ring to mine (default 20 s). */
  lookbackMs?: number
  pollMs?: number
}

/**
 * Run the self-test and return the paste-ready bundle.
 *
 * Sequence: probe the URL → read the whole event ring and fold the LAST
 * `lookbackMs` of it (catches a stream already in progress) → poll forward for
 * `captureMs`, folding new events and taking a mid-stream state sample → stop
 * early on a terminal verdict → evaluate → format.
 */
export async function runStreamSelfTest(opts: RunStreamSelfTestOptions = {}): Promise<StreamSelfTestBundle> {
  const captureMs = opts.captureMs ?? 25_000
  const lookbackMs = opts.lookbackMs ?? 20_000
  const pollMs = opts.pollMs ?? 500

  const probe = currentStreamProbeUrl()
  const track = get(currentTrack)
  const variant = probe?.variant ?? 'raw'
  const isTranscode = variant !== 'raw'
  const native = Capacitor.isNativePlatform()

  // Probe immediately ONLY when no staged stream owns this track's transcode;
  // otherwise defer it past the capture (see `stagedStreamActive`). Deferring
  // keeps the probe honest AND stops it from perturbing the stream it exists
  // to verify.
  let httpDeferred = false
  let http: HttpProbeFacts | null = null
  if (probe) {
    if (native && (await stagedStreamActive())) httpDeferred = true
    else http = await probeTranscodeHttp(probe.url)
  }
  let probeNote: string | null = null

  let facts = emptyNativeStreamFacts()
  const raw: RawEvent[] = []
  let stateSample: StateSample | null = null

  if (native) {
    // 1. Look-back: read the ring and keep the CURRENT stream's events so a
    //    track already playing (or one that just finished) is still captured.
    //    The window is chosen on the NATIVE MONOTONIC clock — `EventLog.t` is
    //    seconds since process start, so the old `Date.now() - lookbackMs` cut
    //    matched nothing and every runtime check read UNKNOWN (1.2.48 bug).
    const currentTrackId = track?.trackId ?? ''
    let seq = 0
    try {
      const page = await nativeEngine.getDebugEvents(0)
      seq = page.nextSeq
      const selected = selectStreamWindow(page.events as RawEvent[], {
        trackId: currentTrackId,
        nowSeconds: Number(page.now) || 0,
        lookbackSeconds: Math.max(1, Math.round(lookbackMs / 1000)),
      })
      for (const ev of selected) {
        if (ev.domain && RAW_DOMAINS.has(ev.domain)) raw.push(ev)
        facts = foldStreamEvent(facts, ev)
      }
    } catch {
      /* bridge unavailable */
    }
    stateSample = await readStateSample()

    // 2. Forward poll until terminal, the deadline, or captureMs == 0.
    const deadline = Date.now() + captureMs
    while (captureMs > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs))
      try {
        const page = await nativeEngine.getDebugEvents(seq)
        seq = page.nextSeq
        for (const ev of page.events as RawEvent[]) {
          if (ev.domain && RAW_DOMAINS.has(ev.domain)) raw.push(ev)
          facts = foldStreamEvent(facts, ev)
        }
      } catch {
        /* keep polling */
      }
      if (!stateSample) stateSample = await readStateSample()
      const terminal =
        facts.promoted || facts.completedWhole || facts.rejectedTranscodeShort || facts.writerFailed || facts.stallGiveUpCount > 0
      if (terminal && stateSample) break
    }
  }

  // Deferred probe: the capture window has ended, so the transcode has either
  // settled (finish now — the facts then describe a completed, likely cached
  // output) or is still running (skip and say so: probing now would race the
  // stream, and the resulting 200 would be misread as the server's Range
  // capability).
  if (probe && httpDeferred) {
    if (native && (await stagedStreamActive())) {
      probeNote =
        'deferred — a staged stream was still live at the end of the capture; probing now would race the transcode it measures. Run the test with playback stopped for server facts.'
      http = null
    } else {
      http = await probeTranscodeHttp(probe.url)
    }
  }

  const report = evaluateStreamVerification({
    trackId: track?.trackId ?? 'unknown',
    variant,
    isTranscode,
    metadataDuration: (track as unknown as { duration?: number } | null)?.duration ?? 0,
    snapshotSize: (track as unknown as { size?: number } | null)?.size ?? 0,
    http,
    probeNote,
    native: native ? facts : null,
    stateSample,
  })

  // Raw lines read forward from the oldest captured event (a compact timeline
  // the reader can scan), on that event's own monotonic `t` base.
  let rawBase = 0
  for (const ev of raw) {
    if (typeof ev.t === 'number' && (rawBase === 0 || ev.t < rawBase)) rawBase = ev.t
  }
  const rawLines = raw.map((ev) => fmtRawEv(ev, rawBase))

  const st = get(playbackState)
  const net = get(networkStatusStore)
  const stab = networkStabilitySnapshot()
  const text = formatStreamVerifyBundle({
    report,
    context: {
      platform: native ? 'ios-native' : 'web',
      appVersion,
      trackTitle: (track as unknown as { title?: string } | null)?.title ?? '',
      lowData: get(effectiveLowData) ? 'on' : 'off',
      network: `${net.source} cellular=${net.isCellular} osLowData=${net.osLowData} metered=${stab.metered} latched=${stab.latched} sup=${stab.suppressed} playing=${st}`,
    },
    http,
    probeNote,
    native: native ? facts : null,
    stateSample,
    rawLines,
  })

  lastBundle = { report, text, http, native: native ? facts : null, stateSample, rawLines }
  return lastBundle
}
