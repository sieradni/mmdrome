/**
 * Pure evaluator for the native transcode-streaming self-test (2026-10-02).
 *
 * Manual field verification of transcode streaming means: tap a transcoded
 * track, wait, copy the dump, and eyeball ~8 different signals across the
 * event ring. This module is the analysis half of an in-app self-test that
 * offloads that: a runner (streamVerifyRunner.ts) collects two evidence
 * bundles — an HTTP probe of the REAL transcode URL and a transcript of the
 * native `stream` events — and this pure core turns them into a per-assumption
 * PASS/FAIL/UNKNOWN report.
 *
 * No DOM, no fetch, no stores: the whole judgment surface is unit-testable
 * (tests/streamVerification.test.ts), so the harness itself is not another
 * untested layer on top of the feature it verifies.
 */

/** The container magic-byte read from the head of the transcode body. */
export type ContainerSniff = 'ogg-opus' | 'ogg-vorbis' | 'ogg' | 'mp3' | 'aac-adts' | 'flac' | 'mp4' | 'other'

/** Facts read from a bounded GET of the real transcode URL. */
export interface HttpProbeFacts {
  status: number
  /** Content-Length (null when the server streams chunked / omitted it). */
  contentLength: number | null
  /** Accept-Ranges header, e.g. 'bytes' (null when absent). */
  acceptRanges: string | null
  contentType: string | null
  contentRange: string | null
  /** Bytes actually read (bounded by the probe). */
  bytesRead: number
  /** Container magic sniffed from the head of the body. */
  sniffed: ContainerSniff
  /** A human-readable note when the probe could not complete (network). */
  note?: string
}

/** Facts parsed out of the native engine's `stream` event transcript. */
export interface NativeStreamFacts {
  sawStagedLoadStart: boolean
  sawFirstStagedSchedule: boolean
  firstScheduleEndableFrames: number | null
  firstScheduleHeaderClaimFrames: number | null
  firstScheduleSeconds: number | null
  deferredFirstScheduleCount: number
  stallResumeCount: number
  stallGiveUpCount: number
  schedulePastDeliveredCount: number
  /** The writer promoted the file (either route). */
  promoted: boolean
  /** announced bytes reported on the duration-gated promote line. */
  promotedAnnouncedBytes: number | null
  /** The promote came through the transcode duration/decodability route. */
  promotedDurationGated: boolean
  /** A short transcode was rejected rather than poisoned into the cache. */
  rejectedTranscodeShort: boolean
  /** A completion with no staged schedule scheduled the file whole (fallback). */
  completedWhole: boolean
  writerFailed: boolean
  cleanEarlyClose: boolean
}

export function emptyNativeStreamFacts(): NativeStreamFacts {
  return {
    sawStagedLoadStart: false,
    sawFirstStagedSchedule: false,
    firstScheduleEndableFrames: null,
    firstScheduleHeaderClaimFrames: null,
    firstScheduleSeconds: null,
    deferredFirstScheduleCount: 0,
    stallResumeCount: 0,
    stallGiveUpCount: 0,
    schedulePastDeliveredCount: 0,
    promoted: false,
    promotedAnnouncedBytes: null,
    promotedDurationGated: false,
    rejectedTranscodeShort: false,
    completedWhole: false,
    writerFailed: false,
    cleanEarlyClose: false,
  }
}

export interface NativeEventLike {
  domain?: string
  level?: string
  msg: string
}

/**
 * Parse one `stream` event message into the running facts. Kept as a fold so a
 * paginated `getDebugEvents` pull can feed events one at a time.
 */
export function foldStreamEvent(facts: NativeStreamFacts, ev: NativeEventLike): NativeStreamFacts {
  const domain = ev.domain ?? ''
  const msg = ev.msg ?? ''
  if (domain !== 'stream') return facts
  const next = { ...facts }

  if (/staged load start row/.test(msg)) next.sawStagedLoadStart = true
  if (/partial not openable yet/.test(msg) || /no schedulable evidence yet/.test(msg)) {
    next.deferredFirstScheduleCount += 1
  }
  const first = /first staged schedule id=\S+ endable=(\d+) frames \(([\d.]+)s of header claim (\d+)\)/.exec(msg)
  if (first) {
    next.sawFirstStagedSchedule = true
    next.firstScheduleEndableFrames = Number(first[1])
    next.firstScheduleSeconds = Number(first[2])
    next.firstScheduleHeaderClaimFrames = Number(first[3])
  }
  if (/stall resume at/.test(msg)) next.stallResumeCount += 1
  if (/stall give-up after/.test(msg)) next.stallGiveUpCount += 1
  if (/schedule target past delivered end/.test(msg)) next.schedulePastDeliveredCount += 1
  if (/promoted transcode cut short/.test(msg)) next.rejectedTranscodeShort = true
  if (/completed stream scheduled whole/.test(msg)) next.completedWhole = true
  if (/writer failed/.test(msg)) next.writerFailed = true
  if (/clean early close/.test(msg)) next.cleanEarlyClose = true

  const gated = /promoted \S+ \(\d+B, announced (\d+) — decodability\+duration-gated\)/.exec(msg)
  if (gated) {
    next.promoted = true
    next.promotedDurationGated = true
    next.promotedAnnouncedBytes = Number(gated[1])
  }
  if (/cache entry complete/.test(msg)) next.promoted = true

  return next
}

export function parseNativeStreamTranscript(events: NativeEventLike[]): NativeStreamFacts {
  return events.reduce(foldStreamEvent, emptyNativeStreamFacts())
}

/** A native ring entry with its timestamp. `t` is MONOTONIC SECONDS since
 *  process start (see `EventLog.swift`), NOT epoch milliseconds. */
export interface TimedEventLike extends NativeEventLike {
  seq?: number
  t?: number
}

/**
 * Choose the ring events that belong to the CURRENT stream session.
 *
 * WHY this is not a wall-clock window: native event `t` is monotonic seconds
 * since process start, so the natural-looking `Date.now() - lookbackMs` cut
 * compared ~1.7e12 to ~1e3 and matched NOTHING — the 1.2.48 field report's
 * "RAW EVENTS (0)" and all-UNKNOWN verdicts. Selection therefore never reads
 * a wall clock:
 *
 *  1. Prefer the last `staged load start` for the current track ANYWHERE in
 *     the ring — a stream already running (or one that finished moments
 *     earlier) is captured WHOLE, regardless of how long ago it began.
 *  2. Otherwise fall back to the monotonic window `[now - lookback, now]`,
 *     where `now` is the caller's fresh native uptime (or, absent that, the
 *     newest event's own `t` — conservative, never the wrong timebase).
 */
export function selectStreamWindow(
  events: TimedEventLike[],
  opts: { trackId?: string; nowSeconds?: number | null; lookbackSeconds?: number } = {},
): TimedEventLike[] {
  const trackId = opts.trackId ?? ''
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    const msg = ev.msg ?? ''
    if (ev.domain === 'stream' && /staged load start row/.test(msg) && (trackId === '' || msg.includes(trackId))) {
      return events.slice(i)
    }
  }
  const lookback = opts.lookbackSeconds ?? 20
  const now =
    opts.nowSeconds && opts.nowSeconds > 0
      ? opts.nowSeconds
      : events.reduce((m, e) => (typeof e.t === 'number' && e.t > m ? e.t : m), 0)
  if (!(now > 0)) return events
  const from = now - lookback
  // An event with no timestamp is kept: it cannot be placed, and dropping it
  // would hide evidence on a malformed ring rather than at worst add noise.
  return events.filter((e) => typeof e.t !== 'number' || e.t >= from)
}

/**
 * Sniff the container from the first bytes of the body. Only the front-of-file
 * magic is needed: a progressive container has its header at byte 0, which is
 * exactly the property transcode streaming depends on.
 */
export function sniffContainer(head: Uint8Array | ArrayLike<number>): ContainerSniff {
  const b = head as Uint8Array
  const at = (i: number) => (b.length > i ? b[i] : -1)
  const ascii = (i: number, s: string) => {
    for (let k = 0; k < s.length; k++) if (at(i + k) !== s.charCodeAt(k)) return false
    return true
  }
  if (b.length >= 4 && ascii(0, 'OggS')) {
    // OpusHead / vorbis live within the first pages' headers. Bound by the
    // buffer (not a magic length) — `ascii` reads out-of-range as -1 and
    // returns false, so a short magic near the tail is still discoverable.
    for (let i = 0; i < Math.min(b.length, 128); i++) {
      if (ascii(i, 'OpusHead')) return 'ogg-opus'
      if (ascii(i, 'vorbis')) return 'ogg-vorbis'
    }
    return 'ogg'
  }
  if (b.length >= 4 && ascii(0, 'fLaC')) return 'flac'
  if (b.length >= 8 && ascii(4, 'ftyp')) return 'mp4'
  if (b.length >= 3 && ascii(0, 'ID3')) return 'mp3'
  if (b.length >= 2 && (at(0) & 0xff) === 0xff && (at(1) & 0xf6) === 0xf0) return 'aac-adts'
  if (b.length >= 2 && (at(0) & 0xff) === 0xff && (at(1) & 0xe0) === 0xe0) return 'mp3'
  return 'other'
}

/** True when the sniffed container carries its header at the front, so a
 *  partial file can be opened by the decoder (the streaming precondition). */
export function isProgressiveContainer(sniffed: ContainerSniff): boolean | null {
  if (sniffed === 'mp4') return false
  if (sniffed === 'other') return null
  return true
}

export type ContainerShape = 'honest' | 'lying' | 'unknown'

/**
 * Classify a partial container as HONEST (its reported length is the delivered
 * duration — Ogg/Opus, so the byte-ratio estimate must NOT be applied to it a
 * second time) or LYING (it reports the full track from a partial file — FLAC
 * STREAMINFO / MP4 — where the ratio discount is required).
 *
 * The discriminator: at a known delivered byte fraction, an honest container's
 * claim is ~that fraction of the metadata duration; a lying one claims ~all of
 * it. Requires the first-schedule numbers plus the byte fraction at that moment.
 */
export function classifyContainerShape(input: {
  headerClaimFrames: number | null
  metadataFrames: number | null
  deliveredBytes: number | null
  announcedBytes: number | null
}): ContainerShape {
  const { headerClaimFrames, metadataFrames, deliveredBytes, announcedBytes } = input
  if (!headerClaimFrames || headerClaimFrames <= 0) return 'unknown'
  if (!metadataFrames || metadataFrames <= 0) return 'unknown'
  if (!deliveredBytes || deliveredBytes <= 0) return 'unknown'
  if (!announcedBytes || announcedBytes <= 0) return 'unknown'
  const ratio = Math.min(1, deliveredBytes / announcedBytes)
  const claimRatio = headerClaimFrames / metadataFrames
  // A claim within slack of the DELIVERED fraction is honest; a claim near the
  // FULL metadata duration while far less than all bytes landed is lying.
  // Thresholds are deliberately wide (container overhead, VBR, rounding).
  if (claimRatio <= ratio * 1.5 + 0.05) return 'honest'
  if (claimRatio >= 0.8 && ratio <= 0.7) return 'lying'
  return 'unknown'
}

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown'

export interface VerifyCheck {
  id: string
  label: string
  status: CheckStatus
  evidence: string
}

export interface StreamVerifyReport {
  at: string
  trackId: string
  variant: string
  isTranscode: boolean
  containerShape: ContainerShape
  checks: VerifyCheck[]
  summary: string
}

export interface StreamVerifyInput {
  trackId: string
  /** e.g. 'opus@128' or 'raw'. */
  variant: string
  isTranscode: boolean
  metadataDuration: number
  snapshotSize: number
  /** Parsed HTTP probe facts, or null when the probe could not run. */
  http: HttpProbeFacts | null
  /** Parsed native transcript, or null on web / when no capture ran. */
  native: NativeStreamFacts | null
  /** A live getDebugState() sample taken during the capture, used to classify
   *  the container shape (needs the delivered/announced fraction plus the
   *  engine's own metadata-frames figure — the JS side cannot derive it). */
  stateSample?: {
    deliveredBytes: number
    announcedBytes: number
    headerClaimFrames: number
    metadataFrames: number
  } | null
}

function countStatus(checks: VerifyCheck[]): string {
  const pass = checks.filter((c) => c.status === 'pass').length
  const fail = checks.filter((c) => c.status === 'fail').length
  const warn = checks.filter((c) => c.status === 'warn').length
  const unknown = checks.filter((c) => c.status === 'unknown').length
  return `${pass} pass · ${warn} warn · ${fail} fail · ${unknown} unknown`
}

/**
 * The judgment table. Every check names the assumption it verifies and cites
 * the evidence, so a report pasted into an issue is self-describing.
 */
export function evaluateStreamVerification(input: StreamVerifyInput): StreamVerifyReport {
  const { http, native, isTranscode } = input
  const checks: VerifyCheck[] = []

  // --- HTTP-side (server + container) ------------------------------------
  if (!http) {
    checks.push({
      id: 'server-total',
      label: 'Server announces a total (Content-Length)',
      status: 'unknown',
      evidence: 'HTTP probe did not run (offline / native fetch failed)',
    })
  } else {
    checks.push({
      id: 'server-total',
      label: 'Server announces a total (Content-Length)',
      status: http.contentLength && http.contentLength > 0 ? 'pass' : 'warn',
      evidence: http.contentLength && http.contentLength > 0
        ? `content-length=${http.contentLength}, content-type=${http.contentType ?? '?'}`
        : 'chunked / no Content-Length — transcode streaming stays on the full-download fallback (no regression)',
    })
    const rangesOk = (http.acceptRanges ?? '').toLowerCase().includes('bytes')
    checks.push({
      id: 'range-support',
      label: 'Server supports Range (stream recovery can resume)',
      status: rangesOk ? 'pass' : 'warn',
      evidence: `accept-ranges=${http.acceptRanges ?? 'absent'}`,
    })
    const progressive = isProgressiveContainer(http.sniffed)
    checks.push({
      id: 'progressive-container',
      label: 'Container header is at the front (openable from a partial file)',
      status: progressive === true ? 'pass' : progressive === false ? 'fail' : 'unknown',
      evidence: `first bytes sniffed as ${http.sniffed} (${http.bytesRead} B read)`,
    })
  }

  // --- Native-side (runtime) ---------------------------------------------
  if (!native) {
    checks.push({
      id: 'streaming-engaged',
      label: 'Native staged stream engaged',
      status: 'unknown',
      evidence: 'no native capture (web, or capture not armed/finished)',
    })
    checks.push({
      id: 'completion-verdict',
      label: 'Completion judged by duration, not an estimate',
      status: 'unknown',
      evidence: 'no native capture',
    })
  } else {
    checks.push({
      id: 'streaming-engaged',
      label: 'Native staged stream engaged',
      status: native.sawFirstStagedSchedule ? 'pass' : native.deferredFirstScheduleCount > 0 ? 'warn' : 'unknown',
      evidence: native.sawFirstStagedSchedule
        ? `first schedule endable=${native.firstScheduleEndableFrames} frames (${native.firstScheduleSeconds}s), header claim=${native.firstScheduleHeaderClaimFrames}`
        : `${native.deferredFirstScheduleCount} deferred first-schedule attempts — container not openable at the lead`,
    })

    if (isTranscode && !native.sawFirstStagedSchedule && native.completedWhole) {
      checks.push({
        id: 'deferred-plays',
        label: 'Deferred / chunked stream still plays (dead-air fix)',
        status: native.promoted ? 'pass' : 'warn',
        evidence: 'completed stream scheduled whole (no staged schedule had formed)',
      })
    }

    checks.push({
      id: 'estimate-health',
      label: 'Estimate neither starves nor over-promises',
      status: native.stallGiveUpCount > 0 ? 'fail' : native.stallResumeCount <= 1 ? 'pass' : 'warn',
      evidence: `stallResume=${native.stallResumeCount}, giveUp=${native.stallGiveUpCount}, pastDelivered=${native.schedulePastDeliveredCount}`,
    })

    checks.push({
      id: 'completion-verdict',
      label: 'Completion judged by duration, not an estimate',
      status: native.rejectedTranscodeShort
        ? 'fail'
        : native.promoted
          ? 'pass'
          : native.writerFailed || native.cleanEarlyClose
            ? 'warn'
            : 'unknown',
      evidence: native.promoted
        ? `promoted (announced=${native.promotedAnnouncedBytes ?? '?'}${native.promotedDurationGated ? ', duration-gated' : ''})`
        : native.rejectedTranscodeShort
          ? 'a short transcode was rejected (poison gate fired)'
          : native.writerFailed || native.cleanEarlyClose
            ? 'writer failed / early close'
            : 'no terminal verdict captured',
    })
  }

  // --- Container-shape classification (the core assumption) --------------
  const sample = input.stateSample ?? null
  const metadataFrames = sample && sample.metadataFrames > 0 ? sample.metadataFrames : null
  const shape = native && native.sawFirstStagedSchedule && sample
    ? classifyContainerShape({
        headerClaimFrames: sample.headerClaimFrames || native.firstScheduleHeaderClaimFrames,
        metadataFrames,
        deliveredBytes: sample.deliveredBytes,
        announcedBytes: sample.announcedBytes,
      })
    : 'unknown'
  checks.push({
    id: 'container-shape',
    label: 'Container length is honest (delivered duration) vs lying (full track)',
    status: shape === 'unknown' ? 'unknown' : 'pass',
    evidence: shape === 'unknown'
      ? 'needs a mid-stream state sample (delivered/announced/header-claim)'
      : `classified ${shape} — header claim ${sample?.headerClaimFrames ?? '?'} of ~${metadataFrames ?? '?'} frames at ${sample?.deliveredBytes ?? '?'}/${sample?.announcedBytes ?? '?'} B`,
  })

  const summary = countStatus(checks)
  return {
    at: new Date().toISOString(),
    trackId: input.trackId,
    variant: input.variant,
    isTranscode,
    containerShape: shape,
    checks,
    summary,
  }
}

export function formatStreamVerifyReport(report: StreamVerifyReport): string {
  const lines = report.checks.map((c) => `  [${c.status.toUpperCase().padEnd(7)}] ${c.label} — ${c.evidence}`)
  return [
    `stream self-test @ ${report.at}  track=${report.trackId}  variant=${report.variant}  (${report.summary})`,
    ...lines,
  ].join('\n')
}

// MARK: - The paste-ready bundle

export interface StreamVerifyContext {
  platform: string
  appVersion: string
  trackTitle: string
  lowData: string
  network: string
}

export interface StreamVerifyBundleInput {
  report: StreamVerifyReport
  context: StreamVerifyContext
  http: HttpProbeFacts | null
  native: NativeStreamFacts | null
  stateSample?: {
    deliveredBytes: number
    announcedBytes: number
    headerClaimFrames: number
    metadataFrames: number
    scheduledEndFrames?: number
    stalled?: boolean
    recentRate?: number
  } | null
  /** Raw engine event lines captured in the window, oldest first. */
  rawLines: string[]
}

/**
 * One self-contained text block for a paste — header, HTTP facts, the state
 * sample, the verdict table, then the raw events they were derived from. The
 * raw tail matters: a verdict can be wrong, and the lines let a reader
 * re-adjudicate rather than trust the summary.
 */
export function formatStreamVerifyBundle(input: StreamVerifyBundleInput): string {
  const { report, context, http, native, stateSample, rawLines } = input
  const rows: string[] = []
  rows.push('=== MMDROME STREAM SELF-TEST ========================================')
  rows.push(`when: ${report.at}   platform: ${context.platform}   app: ${context.appVersion}`)
  rows.push(`track: ${report.trackId} "${context.trackTitle}"   variant: ${report.variant}${report.isTranscode ? ' (transcode)' : ' (raw)'}`)
  rows.push(`ldm: ${context.lowData}   network: ${context.network}`)
  rows.push('--- HTTP PROBE ------------------------------------------------------')
  if (http) {
    rows.push(`  status: ${http.status}  content-length: ${http.contentLength ?? 'absent'}  accept-ranges: ${http.acceptRanges ?? 'absent'}`)
    rows.push(`  content-type: ${http.contentType ?? '?'}  content-range: ${http.contentRange ?? 'absent'}`)
    rows.push(`  read: ${http.bytesRead} B   container magic: ${http.sniffed}${http.note ? `   note: ${http.note}` : ''}`)
  } else {
    rows.push('  (probe did not run)')
  }
  rows.push('--- STATE SAMPLE (mid-stream) --------------------------------------')
  if (stateSample) {
    rows.push(`  delivered: ${stateSample.deliveredBytes} / announced: ${stateSample.announcedBytes}`)
    rows.push(`  headerClaimFrames: ${stateSample.headerClaimFrames}  metadataFrames: ${stateSample.metadataFrames}  scheduledEndFrames: ${stateSample.scheduledEndFrames ?? '?'}`)
    rows.push(`  stalled: ${stateSample.stalled ?? '?'}  recentRate: ${stateSample.recentRate ?? '?'}`)
  } else {
    rows.push('  (no sample taken — no staged stream was active)')
  }
  rows.push(`--- VERDICTS (${report.summary}) ---`)
  for (const c of report.checks) rows.push(`  [${c.status.toUpperCase().padEnd(7)}] ${c.label} — ${c.evidence}`)
  rows.push('--- PARSED FACTS ---------------------------------------------------')
  rows.push(`  ${JSON.stringify(native ?? {}, null, 0)}`)
  rows.push(`--- RAW EVENTS (${rawLines.length}) ----------------------------------------`)
  rows.push(...rawLines.map((l) => `  ${l}`))
  rows.push('====================================================================')
  return rows.join('\n')
}
