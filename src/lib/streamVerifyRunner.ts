/**
 * Adapter half of the Streaming Self-Test (2026-10-02): probes the REAL
 * transcode URL over HTTP and captures the native `stream` event transcript,
 * then hands both to the pure evaluator in `streamVerification.ts`.
 *
 * Two evidence legs, both automatic:
 *  - HTTP probe (no audio, no queue disturbance): rebuilds the exact URL the
 *    manager would use, issues a bounded Range GET, and reads Content-Length /
 *    Accept-Ranges / Content-Type plus the container magic at byte 0. This
 *    settles the server-total, range-support and progressive-container
 *    assumptions WITHOUT touching the engine.
 *  - Native capture (armed, passive): folds `getDebugEvents` + a mid-stream
 *    `getDebugState` sample while the user plays normally. Nothing here drives
 *    playback or mutates the queue.
 *
 * Everything the evaluator needs is collected by this file so the judgment
 * stays pure and testable.
 */
import { Capacitor } from '@capacitor/core'
import { get } from 'svelte/store'
import { settings, currentTrack } from '../stores/appState'
import { effectiveLowData } from './networkMode'
import { getCachedConfig, buildStreamUrl } from './navidromeApi'
import { transcodeParams } from './transcodePolicy'
import { nativeEngine, BackgroundAudio } from './nativePlugin'
import {
  type HttpProbeFacts,
  type NativeStreamFacts,
  type StreamVerifyReport,
  emptyNativeStreamFacts,
  foldStreamEvent,
  evaluateStreamVerification,
  sniffContainer,
  formatStreamVerifyReport,
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
 * Never throws — the report carries the reason.
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
      return { status: 0, contentLength: null, acceptRanges: null, contentType: null, contentRange: null, bytesRead: 0, sniffed: 'other', note: String((e as Error)?.message ?? e) }
    }
  }
}

export interface NativeCaptureResult {
  facts: NativeStreamFacts
  stateSample: { deliveredBytes: number; announcedBytes: number; headerClaimFrames: number; metadataFrames: number } | null
  events: number
}

/**
 * Poll the native debug surfaces for `maxMs`, folding `stream` events and
 * taking the FIRST mid-stream state sample (delivered > 0). Stops early on a
 * terminal verdict. Read-only: it never issues a play/seek/queue command.
 */
export async function captureNativeStream(opts: { maxMs: number; pollMs?: number; sinceSeq: number }): Promise<NativeCaptureResult> {
  const pollMs = opts.pollMs ?? 500
  const deadline = Date.now() + opts.maxMs
  let facts = emptyNativeStreamFacts()
  let sample: NativeCaptureResult['stateSample'] = null
  let seq = opts.sinceSeq
  let events = 0

  while (Date.now() < deadline) {
    try {
      const page = await nativeEngine.getDebugEvents(seq)
      seq = page.nextSeq
      for (const ev of page.events as Array<{ domain?: string; msg?: string; level?: string }>) {
        facts = foldStreamEvent(facts, { domain: ev.domain, level: ev.level, msg: ev.msg ?? '' })
        events += 1
      }
    } catch {
      /* bridge unavailable — keep polling until the deadline */
    }
    if (!sample) {
      try {
        const d = await (BackgroundAudio as unknown as { getDebugState?: () => Promise<Record<string, unknown>> }).getDebugState?.()
        if (d && d.streamActive === true && Number(d.streamDeliveredBytes ?? 0) > 0) {
          sample = {
            deliveredBytes: Number(d.streamDeliveredBytes ?? 0),
            announcedBytes: Number(d.streamAnnouncedBytes ?? 0),
            headerClaimFrames: Number(d.streamHeaderClaimFrames ?? 0),
            metadataFrames: Number(d.streamMetadataFrames ?? 0),
          }
        }
      } catch {
        /* state read is best-effort */
      }
    }
    const terminal =
      facts.promoted || facts.completedWhole || facts.rejectedTranscodeShort || facts.writerFailed || facts.stallGiveUpCount > 0
    if (terminal && sample) break
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return { facts, stateSample: sample, events }
}

let lastReport: StreamVerifyReport | null = null
let lastReportText = ''

export function getLastStreamVerifyReport(): { report: StreamVerifyReport | null; text: string } {
  return { report: lastReport, text: lastReportText }
}

export function clearStreamVerifyReport(): void {
  lastReport = null
  lastReportText = ''
}

export interface RunStreamSelfTestOptions {
  /** How long to watch the native transcript (default 30 s; 0 = HTTP only). */
  captureMs?: number
  /** Pre-arm capture watermark (the HUD's own seq). */
  sinceSeq?: number
}

/**
 * Run the self-test. Always does the HTTP probe; on native it also captures
 * the transcript for `captureMs` (0 skips). Returns the report; callers read it
 * from `getLastStreamVerifyReport()` for the Copy dump.
 */
export async function runStreamSelfTest(opts: RunStreamSelfTestOptions = {}): Promise<StreamVerifyReport> {
  const probe = currentStreamProbeUrl()
  const track = get(currentTrack)
  const variant = probe?.variant ?? 'raw'
  const isTranscode = variant !== 'raw'

  const http = probe ? await probeTranscodeHttp(probe.url) : null

  let native: NativeStreamFacts | null = null
  let stateSample: NativeCaptureResult['stateSample'] = null
  const captureMs = opts.captureMs ?? 30_000
  if (Capacitor.isNativePlatform() && captureMs > 0) {
    const cap = await captureNativeStream({ maxMs: captureMs, sinceSeq: opts.sinceSeq ?? 0 })
    native = cap.facts
    stateSample = cap.stateSample
  }

  const report = evaluateStreamVerification({
    trackId: track?.trackId ?? 'unknown',
    variant,
    isTranscode,
    metadataDuration: (track as unknown as { duration?: number } | null)?.duration ?? 0,
    snapshotSize: (track as unknown as { size?: number } | null)?.size ?? 0,
    http,
    native,
    stateSample,
  })
  lastReport = report
  lastReportText = formatStreamVerifyReport(report)
  return report
}
