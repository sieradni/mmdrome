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
  /** The Range length this probe asked for, or `null` when no Range header
   *  went out (the plain-GET fallback). `undefined` = a capture predating the
   *  field, when every probe sent the Range GET (2026-10-09). */
  requestedRangeBytes?: number | null
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
  /** The first staged schedule's timeline base in seconds (Phase 2): 0 is an
   *  ordinary head-first transfer, > 0 an epoch file scheduled at that base. */
  firstScheduleBaseSeconds: number | null
  /** Seek epochs opened in the capture window (Phase 2, 2026-10-07). */
  epochOpenCount: number
  /** The last epoch's container verdict: 'honored' | 'ignored' | 'unknown' | ''.
   *  '' means no verdict line was seen — an epoch that started but never
   *  demoted itself, the one shape the design forbids. */
  epochVerdict: string
  /** The last epoch's base offset in seconds. */
  epochBaseSeconds: number | null
  /** An offset-ignored epoch was rebased to base 0 with the intent kept. */
  epochRebased: boolean
  /** Transfer ladder (2026-10-07): the speculative prefetch walk was held
   *  because a user-initiated transfer owned the link (staged stream, seek
   *  epoch, or the active row's own download). */
  prefetchHoldCount: number
  /** Distinct hold reasons seen, oldest first (deduped) — the label the engine
   *  logged at each hold transition. */
  prefetchHoldReasons: string[]
  /** The walk resumed after a hold (the settle edge fired) — the proof a hold
   *  is not a permanent stop. */
  prefetchResumeCount: number
  /** Seek latency (plan Phase 4 item 3, 2026-10-07): COMPLETE four-leg reports
   *  in the window — the number the seek work is judged by. A launch with no
   *  user seek reports zero, which the check reads as UNKNOWN, never a pass. */
  seekLatencyCount: number
  /** The LAST complete report's legs (ms from the seek request), or null. */
  lastSeekLatency: SeekLatencyReport | null
  /** Probes that never reached playback: a paused seek (legitimately no total),
   *  or a stranded probe. Counted so "no number" is never read as "fast". */
  seekLatencyIncompleteCount: number
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

/**
 * Whether a staged stream still needs bytes — the SETTLE predicate for the
 * same-stream probe (2026-10-09 field fix). `streamActive` alone is not
 * enough: a COMPLETED schedule stays non-nil for the life of the current
 * track, so the old predicate never settled and the probe was skipped in every
 * field bundle. A completed (or absent) schedule is settled — the
 * completed/cached server job is exactly the state the probe wants to measure.
 */
export function stagedStreamInFlight(
  state: { streamActive?: unknown; streamComplete?: unknown } | null | undefined,
): boolean {
  return state?.streamActive === true && state?.streamComplete !== true
}

export function emptyNativeStreamFacts(): NativeStreamFacts {
  return {
    sawStagedLoadStart: false,
    sawFirstStagedSchedule: false,
    firstScheduleEndableFrames: null,
    firstScheduleHeaderClaimFrames: null,
    firstScheduleSeconds: null,
    firstScheduleBaseSeconds: null,
    epochOpenCount: 0,
    epochVerdict: '',
    epochBaseSeconds: null,
    epochRebased: false,
    prefetchHoldCount: 0,
    prefetchHoldReasons: [],
    prefetchResumeCount: 0,
    seekLatencyCount: 0,
    lastSeekLatency: null,
    seekLatencyIncompleteCount: 0,
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

export interface SeekLatencyReport {
  trackId: string
  targetSeconds: number
  strategy: string
  decisionMs: number | null
  firstByteMs: number | null
  /** The byte leg was inferred from the schedule leg (the downloadTask lane has
   *  no progress callback) — printed with a `*` by the native core. */
  firstByteInferred: boolean
  firstScheduleMs: number | null
  firstPlaybackMs: number | null
  /** request → playback: the number the user actually waits for. */
  totalMs: number | null
  complete: boolean
}

/**
 * Parse the native engine's ONE seek-latency line (`SeekLatency.line` in
 * BackgroundAudioCore). Pure so the fold's arithmetic is unit-testable; a
 * missing leg is `-`, and an inferred byte leg carries a trailing `*`.
 */
export function parseSeekLatencyLine(msg: string): SeekLatencyReport | null {
  const m =
    /^seek latency id=(\S+) target=([\d.]+)s strategy=(\S+) decision=(\S+?)ms firstByte=(\S+?)ms(\*?) firstSchedule=(\S+?)ms firstPlayback=(\S+?)ms total=(\S+?)ms/.exec(
      msg,
    )
  if (!m) return null
  // A non-finite parse (e.g. a `*` sitting INSIDE the token, the wrong shape the
  // native emitter shipped once — CI 2026-10-07) must degrade to a MISSING leg:
  // `NaN` in the facts JSON reads as a number to every downstream consumer.
  const num = (raw: string): number | null => {
    if (raw === '-') return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }
  const decisionMs = num(m[4])
  const firstByteMs = num(m[5])
  const firstScheduleMs = num(m[7])
  const firstPlaybackMs = num(m[8])
  return {
    trackId: m[1],
    targetSeconds: Number(m[2]),
    strategy: m[3],
    decisionMs,
    firstByteMs,
    firstByteInferred: m[6] === '*',
    firstScheduleMs,
    firstPlaybackMs,
    totalMs: num(m[9]),
    complete:
      decisionMs !== null && firstByteMs !== null && firstScheduleMs !== null && firstPlaybackMs !== null,
  }
}

/** One-decimal millisecond leg for the check's evidence; `-` when a leg never
 *  landed (the check's status already says whether that is a problem). */
function fmtMs(value: number | null): string {
  return value === null ? '-' : value.toFixed(1)
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
  // The `preload` domain joins the fold for the TRANSFER LADDER's evidence
  // (2026-10-07): the walk's hold/resume lines are recorded there — they are
  // the only device-side proof that speculative bytes yielded to the user's
  // own transfer and came back. No pre-existing preload line matches a fold
  // pattern, so widening the filter changes nothing else.
  const isStreamLine = domain === 'stream'
    || domain === 'preload'
    || (domain === 'loader' && msg.startsWith('stream:'))
  if (!isStreamLine) return facts
  const next = { ...facts }

  if (/staged load start row/.test(msg)) next.sawStagedLoadStart = true
  if (/partial not openable yet/.test(msg) || /no schedulable evidence yet/.test(msg)) {
    next.deferredFirstScheduleCount += 1
  }
  // `.*?` absorbs the Phase-2 `start=…s base=…s` tokens between the id and
  // `endable=` (2026-10-09 field fix: the old exact `id=\S+ endable=` form
  // stopped matching when Phase 2 inserted them, so every live bundle folded
  // `sawFirstStagedSchedule: false` — misreporting the staged-stream check and
  // permanently starving the container-shape classifier of its schedule
  // evidence). Legacy lines without the extra tokens still match.
  const first = /first staged schedule id=\S+ .*?endable=(\d+) frames \(([\d.]+)s of header claim (\d+)\)/.exec(msg)
  if (first) {
    next.sawFirstStagedSchedule = true
    next.firstScheduleEndableFrames = Number(first[1])
    next.firstScheduleSeconds = Number(first[2])
    next.firstScheduleHeaderClaimFrames = Number(first[3])
  }
  // The base rides the same line since Phase 2; captured separately so a
  // pre-Phase-2 transcript (no `base=`) still folds every other field.
  const firstBase = /first staged schedule id=\S+ .*?base=([\d.]+)s/.exec(msg)
  if (firstBase && next.firstScheduleBaseSeconds == null) {
    next.firstScheduleBaseSeconds = Number(firstBase[1])
  }
  // SEEK EPOCHS (Phase 2, 2026-10-07). The verdict line is what proves an
  // epoch's timeline base was decided BEFORE it entered the graph; an epoch
  // scheduled at a base > 0 with no honored verdict is exactly the shape the
  // design forbids (see the `epoch` check).
  if (/^epoch open /.test(msg)) {
    next.epochOpenCount += 1
    const base = /base=(\d+)s/.exec(msg)
    if (base) next.epochBaseSeconds = Number(base[1])
  }
  const verdict = /^epoch verdict (\w+)/.exec(msg)
  if (verdict) {
    next.epochVerdict = verdict[1]
    if (verdict[1] === 'ignored') next.epochRebased = true
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
  // TRANSFER LADDER (2026-10-07): held ⟺ a user transfer owned the link;
  // resumed ⟺ the settle edge released the walk. A hold with no resume is the
  // starvation shape the check below warns about.
  const held = /^transfer ladder: prefetch walk held \((\w+)\)/.exec(msg)
  if (held) {
    next.prefetchHoldCount += 1
    const reason = held[1]
    // Replace, never mutate: `{ ...facts }` copies the array REFERENCE, so an
    // in-place push would rewrite an earlier fold's snapshot too.
    if (!next.prefetchHoldReasons.includes(reason)) {
      next.prefetchHoldReasons = [...next.prefetchHoldReasons, reason]
    }
  }
  if (/^transfer ladder: prefetch walk resumed/.test(msg)) next.prefetchResumeCount += 1
  // SEEK LATENCY (plan Phase 4 item 3, 2026-10-07): one line per seek that
  // reached playback. Only a COMPLETE report becomes "the number"; an
  // incomplete probe is counted separately (a paused seek is legitimate).
  const latency = parseSeekLatencyLine(msg)
  if (latency) {
    if (latency.complete) {
      next.seekLatencyCount += 1
      next.lastSeekLatency = latency
    } else {
      next.seekLatencyIncompleteCount += 1
    }
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

/** Per-probe verdicts for the server-side assumptions that ARE a yes/no per
 *  probe, keyed by the SAME check ids the report has always used. Range is NOT
 *  here: it is a four-way outcome (`RangeOutcome`) rolled up separately, so a
 *  fresh/uncached probe can be a data gap rather than a verdict. */
type ProbeVerdict = { 'server-total': CheckStatus; 'progressive-container': CheckStatus }

/**
 * What a Range GET actually told us. Only two of the four outcomes are
 * evidence, and collapsing them cost a recurring false alarm (2026-10-09
 * field report): a cold app — every transcode uncached — read
 * `1/3 probes honored a Range request`, which looks like a server defect but is
 * Navidrome's normal in-progress behavior.
 *
 *  - `honored` — `206` / `Content-Range` / `Accept-Ranges: bytes`: recovery
 *    can resume. (Accept-Ranges/Content-Range are NOT CORS-safelisted, so a
 *    webview fetch cannot read them; the `206` status is the proof that
 *    survives, and it is trusted first.)
 *  - `fresh-transcode` — a TRANSCODE URL answered a WHOLE BODY with `200`:
 *    Navidrome serves an in-progress job whole (2026-10-02b), so this says the
 *    job was not ready yet, NOT that Range is unsupported. Excluded from the
 *    verdict and named in the evidence.
 *  - `ignored` — a Range GET answered `200` with no whole-body explanation (a
 *    raw/static URL, or a body no larger than the range we asked for): the
 *    server really did not honor it — a genuine warn.
 *  - `not-sent` — the Range request never went out (plain-GET fallback), so
 *    there is no Range evidence either way.
 */
export type RangeOutcome = 'honored' | 'fresh-transcode' | 'ignored' | 'not-sent'

/** The byte count the probe's Range GET asks for — exported so the adapter and
 *  this classifier can never disagree about what "whole body" means. */
export const PROBE_RANGE_BYTES = 262_144

export function classifyRangeOutcome(f: HttpProbeFacts, isRaw: boolean): RangeOutcome {
  if ((f.acceptRanges ?? '').toLowerCase().includes('bytes') || f.status === 206 || !!f.contentRange) {
    return 'honored'
  }
  // `null` = the Range GET never happened, so there is nothing to judge.
  // `undefined` = a capture predating the field; every probe back then sent the
  // Range GET, so treat it as sent rather than inventing a `not-sent`.
  if (f.requestedRangeBytes === null) return 'not-sent'
  if (f.status !== 200) return 'ignored'
  const asked = f.requestedRangeBytes ?? PROBE_RANGE_BYTES
  const wholeBody = f.contentLength == null || f.contentLength > asked
  // A whole-body 200 on a transcode URL is Navidrome serving an unready job;
  // on a raw/static URL the same answer is a genuine "Range not honored".
  // LIMIT: on a transcode URL an unready job and a server that ignores Range
  // are indistinguishable from one answer — the evidence says so out loud.
  if (!isRaw && wholeBody) return 'fresh-transcode'
  return 'ignored'
}

function probeVerdict(f: HttpProbeFacts): ProbeVerdict {
  const progressive = isProgressiveContainer(f.sniffed)
  return {
    'server-total': f.contentLength && f.contentLength > 0 ? 'pass' : 'warn',
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
      return `${p.format}:${p.facts.sniffed}`
    })
    .join(', ')
  if (id === 'server-total') return `${passed}/${n} probes announce a total — ${detail}`
  return `first bytes sniffed — ${detail}`
}

function rangeOutcomeLabel(o: RangeOutcome): string {
  switch (o) {
    case 'honored': return '206 honored'
    case 'fresh-transcode': return 'status 200 whole body (fresh/uncached transcode)'
    case 'ignored': return 'status 200, Range ignored'
    case 'not-sent': return 'no Range sent'
  }
}

/**
 * The Range evidence names every probe's OUTCOME and keeps the two
 * non-evidence shapes (a fresh/uncached whole-body 200, a probe that sent no
 * Range GET) out of the ratio — so a cold-cache run can no longer read as a
 * server defect (2026-10-09).
 */
function rangeEvidence(probes: LabeledHttpProbe[], outcomes: RangeOutcome[]): string {
  const detail = probes.map((p, i) => `${p.format}:${rangeOutcomeLabel(outcomes[i])}`).join(', ')
  const honored = outcomes.filter((o) => o === 'honored').length
  const ignored = outcomes.filter((o) => o === 'ignored').length
  const fresh = outcomes.filter((o) => o === 'fresh-transcode').length
  const notSent = outcomes.filter((o) => o === 'not-sent').length
  const judged = honored + ignored
  const head = judged === 0
    ? `no probe could measure Range — ${detail}`
    : `${honored}/${judged} probes honored a Range request — ${detail} (Accept-Ranges/Content-Range may be CORS-hidden)`
  const tail: string[] = []
  if (fresh > 0) {
    tail.push(
      `${fresh} fresh (uncached) transcode probe${fresh === 1 ? '' : 's'} answered a whole body with 200 — Navidrome serves an in-progress job whole, so this is the cache state, not a Range verdict; expected on a cold cache (re-run with a ready transcode to measure it)`,
    )
  }
  if (notSent > 0) {
    tail.push(`${notSent} probe${notSent === 1 ? '' : 's'} sent no Range header (plain-GET fallback) — no Range evidence`)
  }
  if (ignored > 0) {
    tail.push(`${ignored} probe${ignored === 1 ? '' : 's'} ignored Range on a non-transcode URL — a genuine gap`)
  }
  if (judged === 0 && notSent === 0) {
    tail.push('a whole-body 200 on a transcode cannot distinguish an unready job from a server that ignores Range')
  }
  return tail.length > 0 ? `${head} — ${tail.join('; ')}` : head
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
    const rangeOutcomes = usable.map((p) => classifyRangeOutcome(p.facts, p.format === 'raw'))
    // Only honored/ignored probes vote on Range: a fresh-transcode whole-body
    // 200 and a probe that sent no Range GET are data gaps, not verdicts
    // (2026-10-09) — counting them made a cold cache look like a broken server.
    const rangeJudged = rangeOutcomes.filter((o) => o === 'honored' || o === 'ignored')
    checks.push({
      id: 'server-total',
      label: 'Server announces a total (Content-Length)',
      status: rollUp(verdicts.map((v) => v['server-total'])),
      evidence: matrixEvidence('server-total', usable, verdicts),
    })
    checks.push({
      id: 'range-support',
      label: 'Server supports Range (stream recovery can resume)',
      status: rangeJudged.length === 0
        ? 'unknown'
        : rollUp(rangeJudged.map((o) => (o === 'honored' ? 'pass' : 'warn'))),
      evidence: rangeEvidence(usable, rangeOutcomes),
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

    // --- Seek epochs (Phase 2, 2026-10-07) -------------------------------
    // The load-bearing invariant: an epoch's timeline base is decided from its
    // container's own claim BEFORE any schedule exists, so an epoch can never
    // start without being able to demote itself.
    const epochScheduledAtBase = (native.firstScheduleBaseSeconds ?? 0) > 0
    checks.push({
      id: 'epoch',
      label: 'Seek epoch: verdict before schedule, rebase never snaps to 0',
      status:
        epochScheduledAtBase && native.epochVerdict !== 'honored'
          ? 'fail'
          : native.epochVerdict === 'honored'
            ? 'pass'
            : native.epochRebased || native.epochVerdict === 'unknown'
              ? 'warn'
              : 'unknown',
      evidence:
        epochScheduledAtBase && native.epochVerdict !== 'honored'
          ? `an epoch file was scheduled at base=${native.firstScheduleBaseSeconds}s with NO honored verdict — the unverified-base shape`
          : native.epochVerdict === 'honored'
            ? `epoch honored (base=${native.epochBaseSeconds}s, schedules ${native.epochOpenCount} epoch(s))`
            : native.epochRebased
              ? 'the server ignored the offset — rebased to base 0, intent kept (never a snap to 0)'
              : native.epochVerdict === 'unknown'
                ? 'the container matched neither shape — epoch discarded, Phase-1 wait'
                : native.epochOpenCount > 0
                  ? `${native.epochOpenCount} epoch(s) opened, no verdict in the window`
                  : 'no seek epoch in the capture (seekEpochs off, or no far seek)',
    })

    // --- Transfer ladder (2026-10-07, Phase 2 follow-up) ------------------
    // Speculative bytes never start while a user transfer owns the link, and a
    // hold must END: a held walk that never resumes is the starvation shape
    // (prefetch stopped for the rest of the window, with no field signal).
    checks.push({
      id: 'transfer-priority',
      label: 'Speculative prefetch yields to the user transfer, then resumes',
      status:
        native.prefetchHoldCount === 0
          ? 'unknown'
          : native.prefetchResumeCount > 0
            ? 'pass'
            : 'warn',
      evidence:
        native.prefetchHoldCount === 0
          ? 'no prefetch hold in the window (no user transfer overlapped the walk, or the ladder never saw one)'
          : `holds=${native.prefetchHoldCount} (${native.prefetchHoldReasons.join(', ') || '?'}), resumes=${native.prefetchResumeCount}` +
            (native.prefetchResumeCount > 0 ? '' : ' — a hold with NO resume: prefetch stayed stopped for the window'),
    })

    // --- Seek latency (plan Phase 4 item 3, 2026-10-07) -------------------
    // The measurement that turns "seeking feels better" into a number: four
    // legs from the seek REQUEST (decision → first byte → first schedule →
    // first playback). UNKNOWN when no complete report exists — absence is
    // never a pass, and the strategy label is the epoch-vs-wait comparison.
    const seekLatency = native.lastSeekLatency
    checks.push({
      id: 'seek-latency',
      label: 'Seek latency measured end to end (request → playback)',
      status: seekLatency ? 'pass' : native.seekLatencyIncompleteCount > 0 ? 'warn' : 'unknown',
      evidence: seekLatency
        ? `total=${fmtMs(seekLatency.totalMs)}ms (decision=${fmtMs(seekLatency.decisionMs)}, firstByte=${fmtMs(seekLatency.firstByteMs)}${seekLatency.firstByteInferred ? '*' : ''}, firstSchedule=${fmtMs(seekLatency.firstScheduleMs)}) strategy=${seekLatency.strategy} target=${seekLatency.targetSeconds}s` +
          (native.seekLatencyCount > 1 ? `, ${native.seekLatencyCount} report(s)` : '')
        : native.seekLatencyIncompleteCount > 0
          ? `${native.seekLatencyIncompleteCount} probe(s) never reached playback — a paused seek, or a stranded probe; no total to report`
          : 'no seek latency line in the window (no user seek in the capture)',
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
        `  ${p.format.padEnd(6)} ${p.trackId} "${p.title}"  status=${p.facts.status} cl=${p.facts.contentLength ?? 'absent'} ar=${p.facts.acceptRanges ?? 'absent'} magic=${p.facts.sniffed} range=${classifyRangeOutcome(p.facts, p.format === 'raw')}${p.facts.note ? ` note=${p.facts.note}` : ''}`,
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
