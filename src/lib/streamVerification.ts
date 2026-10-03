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

/** One labeled probe in the SERVER-CAPABILITY MATRIX: a request for a
 *  DIFFERENT, unloaded library track (so it can never attach to the live
 *  transcode job of the track under test), used to gather the server facts
 *  that do not depend on which track is playing. */
export interface LabeledHttpProbe {
  origin: 'matrix' | 'current-stream'
  /** The transcode format the probe URL requested ('raw' = no transcode). */
  format: string
  trackId: string
  title: string
  facts: HttpProbeFacts
}

/** A track+format pair the matrix should probe. */
export interface ProbeTarget {
  trackId: string
  title: string
  /** 'raw' means build the plain (non-transcode) stream URL. */
  format: string
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
  /** The promote RECOVERED a writer error: the transfer failed, but the
   *  delivered body already carried the track (2026-10-02d). */
  promotedAfterWriterError: boolean
  /** A short transcode was rejected rather than poisoned into the cache. */
  rejectedTranscodeShort: boolean
  /** A completion with no staged schedule scheduled the file whole (fallback). */
  completedWhole: boolean
  writerFailed: boolean
  cleanEarlyClose: boolean
  /** In-loader Range continuations started for this stream (the writer
   *  continuation recovery — a mid-body cut that kept playing instead of
   *  restarting from 0:00). */
  writerContinuationCount: number
  /** Continuation answers that were NOT appendable (a non-206, or a 206 whose
   *  Content-Range start mismatched / was missing) — each CORRECTLY rejected to
   *  a fresh download instead of spliced into the retained prefix
   *  (2026-10-03). */
  continuationNotAppendableCount: number
  /** Continuations that aborted before starting — the scratch could not
   *  support the offset (purge/truncation), so the prefix was destroyed. */
  continuationAbortedCount: number
  /** Continuations whose scratch could not be reopened — handed to the JS
   *  retry. */
  continuationReopenFailedCount: number
  /** Continuations refused by the eligibility predicate (range-unsupported,
   *  loop cap, or no scratch) — handed to the JS retry. */
  continuationCapYieldCount: number
  /** The failure IDENTITY + churn-vs-stable-path attribution bracketed onto
   *  the last `writer failed` line (2026-10-02e): `err=… kind=… cut=…`.
   *  Null when no writer failure was seen, or the line predates the taxonomy
   *  (an older native build). The self-test reports it verbatim; the LABEL is
   *  a convenience, the numbers are the evidence. */
  writerFailureEvidence: string | null
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
    promotedAfterWriterError: false,
    rejectedTranscodeShort: false,
    completedWhole: false,
    writerFailed: false,
    cleanEarlyClose: false,
    writerContinuationCount: 0,
    continuationNotAppendableCount: 0,
    continuationAbortedCount: 0,
    continuationReopenFailedCount: 0,
    continuationCapYieldCount: 0,
    writerFailureEvidence: null,
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
  // The staged-flow lines ride the `stream` domain; the writer's VERDICT lines
  // (promoted / cut short / writer failed) go through the loader's own
  // `event()` helper, which logs on the `loader` domain with a `stream: `
  // prefix. Both describe the same stream — fold both, or the promote verdict
  // is never seen and `completion-verdict` reads UNKNOWN forever (the 1.2.49
  // field report: `stream: promoted … — cache entry complete` arrived on
  // `loader` and the domain guard dropped it).
  const isStreamLine = domain === 'stream' || (domain === 'loader' && msg.startsWith('stream:'))
  if (!isStreamLine) return facts
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
  if (/writer failed/.test(msg)) {
    next.writerFailed = true
    // (2026-10-02e) Capture the taxonomy + correlation bracket the native
    // writer-failure line now carries: `[err=… kind=… cut=…]`. Last one wins.
    const ev = /\[(err=\S+ kind=\S+(?: under=\S+)? cut=[^\]]+)\]/.exec(msg)
    if (ev) next.writerFailureEvidence = ev[1]
  }
  if (/clean early close/.test(msg)) next.cleanEarlyClose = true
  // IN-LOADER CONTINUATION (2026-10-03): the cut recovery. These lines are the
  // device-side proof that a mid-body cut continued in place (and that a
  // non-appendable/misaligned answer was rejected rather than spliced).
  if (/writer continuation for/.test(msg)) next.writerContinuationCount += 1
  if (/continuation aborted/.test(msg)) next.continuationAbortedCount += 1
  if (/continuation reopen failed/.test(msg)) next.continuationReopenFailedCount += 1
  if (/continuation answered .*not appendable/.test(msg)) next.continuationNotAppendableCount += 1
  if (/continuation unavailable/.test(msg)) next.continuationCapYieldCount += 1

  const gated = /promoted \S+ \(\d+B, announced (\d+) — decodability\+duration-gated\)/.exec(msg)
  if (gated) {
    next.promoted = true
    next.promotedDurationGated = true
    next.promotedAnnouncedBytes = Number(gated[1])
  }
  if (/cache entry complete/.test(msg)) next.promoted = true
  // The writer-ERROR recovery (2026-10-02d): the transfer failed late, but the
  // delivered body already carried the track and promoted. Without this fold
  // the recovery would still read `writerFailed: false` + `promoted: false`,
  // i.e. completion-verdict UNKNOWN, on a stream that plainly completed.
  if (/promoted \S+ \(\d+B\) despite writer error/.test(msg)) {
    next.promoted = true
    next.promotedDurationGated = true
    next.promotedAfterWriterError = true
  }

  return next
}

export function parseNativeStreamTranscript(events: NativeEventLike[]): NativeStreamFacts {
  return events.reduce(foldStreamEvent, emptyNativeStreamFacts())
}

/** Deterministic 32-bit PRNG (mulberry32). The matrix sample must be
 *  reproducible so a run can be re-adjudicated; a real `Math.random` would
 *  make the chosen targets unrepeatable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Choose the matrix's probe targets: a deterministic sample of library tracks
 * that are NOT currently loaded, one (or `perFormat`) per format.
 *
 * The exclusion set is the caller's job (it knows the playing track and the
 * queue the preloader may be touching); this pure core only samples. The same
 * track is never reused across formats while the pool can supply distinct
 * rows — a probe that attached to another probe's job would defeat the
 * decoupling the matrix exists for. A pool smaller than the requested sample
 * yields fewer targets rather than duplicate ones.
 */
export function selectProbeTargets(
  tracks: ReadonlyArray<{ trackId: string; title?: string }>,
  opts: { formats: string[]; excludeIds?: Iterable<string>; perFormat?: number; seed?: number },
): ProbeTarget[] {
  const exclude = new Set(opts.excludeIds ?? [])
  const pool = tracks.filter((t) => t.trackId && !exclude.has(t.trackId))
  const rng = mulberry32(opts.seed ?? 0x5eed)
  const shuffled = pool.slice()
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = shuffled[i]
    shuffled[i] = shuffled[j]
    shuffled[j] = tmp
  }
  const perFormat = Math.max(1, opts.perFormat ?? 1)
  const out: ProbeTarget[] = []
  let cursor = 0
  for (const format of opts.formats) {
    for (let k = 0; k < perFormat; k++) {
      if (cursor >= shuffled.length) return out
      const t = shuffled[cursor++]
      out.push({ trackId: t.trackId, title: t.title ?? '', format })
    }
  }
  return out
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
  /** Parsed HTTP probe facts for the CURRENT track's stream, or null when that
   *  probe could not run. */
  http: HttpProbeFacts | null
  /** The SERVER-CAPABILITY MATRIX: labeled probes of OTHER, unloaded library
   *  tracks across the transcode formats in use. Server facts (Content-Length /
   *  Range / container-at-front) are server+format properties, so these feed
   *  the SAME three server checks as `http` — the report no longer needs
   *  playback stopped to gather them. */
  httpProbes?: LabeledHttpProbe[]
  /** Why no usable probe ran, when that is the case — e.g. a staged stream was
   *  still live after the settle wait, so the same-stream probe was skipped
   *  (a same-track/same-format GET attaches to Navidrome's in-progress
   *  transcode job and reads a misleading whole body). Surfaces in the
   *  HTTP-side evidence instead of the misleading generic "did not run" text. */
  probeNote?: string | null
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

/** Per-probe verdicts for the three server-side assumptions, keyed by the
 *  SAME check ids the report has always used. */
type ProbeVerdict = { 'server-total': CheckStatus; 'range-support': CheckStatus; 'progressive-container': CheckStatus }

function probeRangesOk(f: HttpProbeFacts): boolean {
  // Accept-Ranges/Content-Range are NOT CORS-safelisted, so a webview fetch
  // cannot read them even when present — a 206 to our Range GET is the direct
  // proof and must be trusted first.
  return (f.acceptRanges ?? '').toLowerCase().includes('bytes') || f.status === 206 || !!f.contentRange
}

function probeVerdict(f: HttpProbeFacts): ProbeVerdict {
  const progressive = isProgressiveContainer(f.sniffed)
  return {
    'server-total': f.contentLength && f.contentLength > 0 ? 'pass' : 'warn',
    'range-support': probeRangesOk(f) ? 'pass' : 'warn',
    'progressive-container': progressive === true ? 'pass' : progressive === false ? 'fail' : 'unknown',
  }
}

/** One rolled-up status across the matrix: any fail wins, all-pass passes,
 *  all-unknown is unknown, everything else (mixed / warn) is a warn. */
function rollUp(statuses: CheckStatus[]): CheckStatus {
  if (statuses.some((s) => s === 'fail')) return 'fail'
  if (statuses.every((s) => s === 'pass')) return 'pass'
  if (statuses.every((s) => s === 'unknown')) return 'unknown'
  return 'warn'
}

function matrixEvidence(id: keyof ProbeVerdict, probes: LabeledHttpProbe[], verdicts: ProbeVerdict[]): string {
  const n = probes.length
  const passed = verdicts.filter((v) => v[id] === 'pass').length
  const detail = probes
    .map((p) => {
      if (id === 'server-total') {
        const cl = p.facts.contentLength && p.facts.contentLength > 0 ? String(p.facts.contentLength) : 'chunked'
        return `${p.format}:${cl}`
      }
      if (id === 'range-support') return `${p.format}:${p.facts.status === 206 ? '206' : `status ${p.facts.status}`}`
      return `${p.format}:${p.facts.sniffed}`
    })
    .join(', ')
  if (id === 'server-total') return `${passed}/${n} probes announce a total — ${detail}`
  if (id === 'range-support') return `${passed}/${n} probes honored a Range request — ${detail} (Accept-Ranges/Content-Range may be CORS-hidden)`
  return `first bytes sniffed — ${detail}`
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
  // The facts may come from the SAME-STREAM probe (the current track) and/or
  // the decoupled SERVER-CAPABILITY MATRIX. Both feed the SAME three checks
  // (ids/labels/vocabulary unchanged) so old and new reports stay comparable;
  // the evidence recounts the per-format roll-up. A probe that did not
  // complete (status 0 — offline / fetch failure) is NOT evidence about the
  // server and is excluded from the roll-up.
  const probes: LabeledHttpProbe[] = []
  if (http) probes.push({ origin: 'current-stream', format: input.variant, trackId: input.trackId, title: '', facts: http })
  if (input.httpProbes && input.httpProbes.length > 0) probes.push(...input.httpProbes)
  const usable = probes.filter((p) => p.facts.status > 0)
  if (usable.length === 0) {
    // Every server-side assumption stays visible as UNKNOWN rather than being
    // silently omitted — a skipped/failed probe is a data gap, not a verdict,
    // and the note says WHICH kind of gap it is.
    const failedNote = probes.find((p) => p.facts.note)?.facts.note
    const why =
      input.probeNote ??
      (failedNote ? `HTTP probe failed: ${failedNote}` : 'HTTP probe did not run (offline / native fetch failed)')
    checks.push({
      id: 'server-total',
      label: 'Server announces a total (Content-Length)',
      status: 'unknown',
      evidence: why,
    })
    checks.push({
      id: 'range-support',
      label: 'Server supports Range (stream recovery can resume)',
      status: 'unknown',
      evidence: why,
    })
    checks.push({
      id: 'progressive-container',
      label: 'Container header is at the front (openable from a partial file)',
      status: 'unknown',
      evidence: why,
    })
  } else {
    const verdicts = usable.map((p) => probeVerdict(p.facts))
    checks.push({
      id: 'server-total',
      label: 'Server announces a total (Content-Length)',
      status: rollUp(verdicts.map((v) => v['server-total'])),
      evidence: matrixEvidence('server-total', usable, verdicts),
    })
    checks.push({
      id: 'range-support',
      label: 'Server supports Range (stream recovery can resume)',
      status: rollUp(verdicts.map((v) => v['range-support'])),
      evidence: matrixEvidence('range-support', usable, verdicts),
    })
    checks.push({
      id: 'progressive-container',
      label: 'Container header is at the front (openable from a partial file)',
      status: rollUp(verdicts.map((v) => v['progressive-container'])),
      evidence: matrixEvidence('progressive-container', usable, verdicts),
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
        ? `promoted (announced=${native.promotedAnnouncedBytes ?? '?'}${native.promotedDurationGated ? ', duration-gated' : ''}${native.promotedAfterWriterError ? ', recovered a writer error' : ''})`
        : native.rejectedTranscodeShort
          ? 'a short transcode was rejected (poison gate fired)'
          : native.writerFailed || native.cleanEarlyClose
            ? 'writer failed / early close'
            : 'no terminal verdict captured',
    })

    // --- In-loader continuation (2026-10-03) -----------------------------
    // The 1.2.50 field defect was a mid-body cut handing to the JS retry, whose
    // reload restarted from 0:00. These checks make the recovery — and its
    // Range-answer validation — verifiable from the device transcript alone.
    checks.push({
      id: 'continuation-recovery',
      label: 'In-loader continuation recovered a cut (no restart from 0:00)',
      status:
        native.writerContinuationCount === 0
          ? 'unknown'
          : native.continuationAbortedCount > 0 || native.continuationReopenFailedCount > 0
            ? 'warn'
            : 'pass',
      evidence:
        native.writerContinuationCount === 0
          ? 'no continuation in the capture (no cut, or the recovery was not reached)'
          : `continuations=${native.writerContinuationCount}, aborted=${native.continuationAbortedCount}, reopenFailed=${native.continuationReopenFailedCount}, capYield=${native.continuationCapYieldCount}`,
    })
    checks.push({
      id: 'continuation-alignment',
      label: 'A non-appendable continuation answer was rejected, not appended',
      status: native.continuationNotAppendableCount > 0 ? 'pass' : 'unknown',
      evidence:
        native.continuationNotAppendableCount > 0
          ? `${native.continuationNotAppendableCount} continuation answer(s) were not appendable (non-206 / misaligned or missing Content-Range) — scratch destroyed, fresh download (no in-writer splice)`
          : 'no non-appendable continuation answer in the capture (guard not exercised)',
    })
  }

  // --- Transfer-cut attribution (2026-10-02e) -----------------------------
  // The discriminating evidence for the repeated `cannot parse response`
  // cuts: does a REPORTED network transition explain the cut (local churn),
  // or was the local path stable (a server / reverse-proxy keep-alive lead)?
  // The native failure line now brackets `err=… kind=… cut=…`; report it
  // verbatim so the label can never disagree with the numbers.
  if (native) {
    const evidence = native.writerFailureEvidence
    const churnSuspected = evidence ? /cut=churnSuspected/.test(evidence) : false
    const churnUnlikely = evidence ? /cut=churnUnlikely/.test(evidence) : false
    checks.push({
      id: 'cut-attribution',
      label: 'Transfer cut attributed (interface churn vs stable path)',
      status: evidence ? 'warn' : 'unknown',
      evidence: evidence
        ? `${evidence}${churnSuspected ? ' — a reported network transition is the likely cause (local churn, not the server)' : churnUnlikely ? ' — no reported transition: a stable local path points at the server / reverse-proxy keep-alive lead' : ''}`
        : 'no writer failure carried an attribution bracket (no failure, or a pre-2026-10-02e native build)',
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
  /** The decoupled server-capability matrix (see `LabeledHttpProbe`). */
  httpProbes?: LabeledHttpProbe[]
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
  /** Same note `evaluateStreamVerification` received when the probe was
   *  deliberately skipped (deferred behind a live staged stream). */
  probeNote?: string | null
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
    rows.push(`  (probe did not run${input.probeNote ? ` — ${input.probeNote}` : ''})`)
  }
  const matrix = input.httpProbes ?? []
  if (matrix.length > 0) {
    rows.push(`--- SERVER PROBE MATRIX (${matrix.length}) ------------------------------------------`)
    for (const p of matrix) {
      rows.push(
        `  ${p.format.padEnd(6)} ${p.trackId} "${p.title}"  status=${p.facts.status} cl=${p.facts.contentLength ?? 'absent'} ar=${p.facts.acceptRanges ?? 'absent'} magic=${p.facts.sniffed}${p.facts.note ? ` note=${p.facts.note}` : ''}`,
      )
    }
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
