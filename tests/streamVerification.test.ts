// Pins the pure streaming self-test evaluator (2026-10-02). The harness that
// verifies transcode streaming must not itself be an unverified layer: every
// judgment (container sniff, transcript parsing, container-shape
// classification, the per-assumption verdict table) is pure and pinned here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sniffContainer,
  isProgressiveContainer,
  classifyContainerShape,
  parseNativeStreamTranscript,
  selectStreamWindow,
  evaluateStreamVerification,
  formatStreamVerifyReport,
  formatStreamVerifyBundle,
  emptyNativeStreamFacts,
  type HttpProbeFacts,
} from '../src/lib/streamVerification'

const b = (...bytes: number[]) => Uint8Array.from(bytes)
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)))

function httpProbe(over: Partial<HttpProbeFacts> = {}): HttpProbeFacts {
  return {
    status: 206,
    contentLength: 3_000_000,
    acceptRanges: 'bytes',
    contentType: 'audio/ogg',
    contentRange: 'bytes 0-262143/3000000',
    bytesRead: 262_144,
    sniffed: 'ogg-opus',
    ...over,
  }
}

test('sniffContainer reads front-of-file magic for every transcode output', () => {
  assert.equal(sniffContainer(ascii('OggS')), 'ogg')
  assert.equal(sniffContainer(Uint8Array.from([...ascii('OggS'), 0, 0, 0, 0, ...ascii('OpusHead')])), 'ogg-opus')
  assert.equal(sniffContainer(Uint8Array.from([...ascii('OggS'), 0, 0, 0, 0, ...ascii('vorbis')])), 'ogg-vorbis')
  assert.equal(sniffContainer(ascii('fLaC')), 'flac')
  assert.equal(sniffContainer(Uint8Array.from([0, 0, 0, 0, ...ascii('ftyp'), ...ascii('M4A ')])) , 'mp4')
  assert.equal(sniffContainer(ascii('ID3')), 'mp3')
  assert.equal(sniffContainer(b(0xff, 0xfb, 0x90)), 'mp3')
  assert.equal(sniffContainer(b(0xff, 0xf1, 0x50)), 'aac-adts')
  assert.equal(sniffContainer(b(1, 2, 3, 4)), 'other')
})

test('isProgressiveContainer: mp4 is the non-progressive FAIL signal', () => {
  assert.equal(isProgressiveContainer('ogg-opus'), true)
  assert.equal(isProgressiveContainer('mp3'), true)
  assert.equal(isProgressiveContainer('aac-adts'), true)
  assert.equal(isProgressiveContainer('flac'), true)
  assert.equal(isProgressiveContainer('mp4'), false, 'moov-at-end cannot open from a partial file')
  assert.equal(isProgressiveContainer('other'), null, 'unknown, not a claim')
})

test('parseNativeStreamTranscript folds the real engine lines', () => {
  const facts = parseNativeStreamTranscript([
    { domain: 'stream', level: 'info', msg: 'staged load start row 4 id=abc autoplay=true' },
    { domain: 'stream', level: 'info', msg: 'partial not openable yet id=abc delivered=131072B — deferring first schedule' },
    { domain: 'stream', level: 'info', msg: 'first staged schedule id=abc endable=3969000 frames (90.0s of header claim 3969000)' },
    { domain: 'stream', level: 'info', msg: 'stall resume at 62.5s — re-scheduling from the delivered end (autoPlay=true)' },
    { domain: 'stream', level: 'info', msg: 'schedule target past delivered end id=abc (seek 91.0s vs endable 90.0s) — buffering' },
    { domain: 'stream', level: 'info', msg: 'promoted abc (3000000B, announced 3000000 — decodability+duration-gated)' },
    { domain: 'loader', level: 'info', msg: 'stream: promoted abc (3000000B, 3969000 frames) — cache entry complete' },
  ])
  assert.equal(facts.sawStagedLoadStart, true)
  assert.equal(facts.deferredFirstScheduleCount, 1)
  assert.equal(facts.sawFirstStagedSchedule, true)
  assert.equal(facts.firstScheduleEndableFrames, 3_969_000)
  assert.equal(facts.firstScheduleSeconds, 90)
  assert.equal(facts.firstScheduleHeaderClaimFrames, 3_969_000)
  assert.equal(facts.stallResumeCount, 1)
  assert.equal(facts.schedulePastDeliveredCount, 1)
  assert.equal(facts.promoted, true)
  assert.equal(facts.promotedDurationGated, true)
  assert.equal(facts.promotedAnnouncedBytes, 3_000_000)
})

test('foldStreamEvent ignores non-stream domains and detects rejects/dead-air fixes', () => {
  const facts = parseNativeStreamTranscript([
    { domain: 'loader', msg: 'first staged schedule id=x endable=1 frames (0.0s of header claim 1)' }, // wrong domain — ignored
    { domain: 'stream', msg: 'promoted transcode cut short (container claim 12.0s of metadata 240.0s) for x — rejecting, scratch retained' },
    { domain: 'stream', msg: 'completed stream scheduled whole id=x frames=1000 (no staged schedule had formed)' },
    { domain: 'stream', msg: 'writer failed for x: bad bytes — scratch retained (1024B)' },
  ])
  assert.equal(facts.sawFirstStagedSchedule, false, 'the loader line must not count')
  assert.equal(facts.rejectedTranscodeShort, true)
  assert.equal(facts.completedWhole, true)
  assert.equal(facts.writerFailed, true)
})

test('classifyContainerShape: honest when the claim tracks the delivered fraction', () => {
  // Ogg/Opus partial: 5M frames claimed of a 10M-frame track at 50 % bytes.
  assert.equal(
    classifyContainerShape({ headerClaimFrames: 5_000_000, metadataFrames: 10_000_000, deliveredBytes: 5_000_000, announcedBytes: 10_000_000 }),
    'honest',
  )
})

test('classifyContainerShape: lying when a partial file claims the full track', () => {
  // FLAC STREAMINFO shape: full 10M-frame claim while only 20 % of bytes exist.
  assert.equal(
    classifyContainerShape({ headerClaimFrames: 10_000_000, metadataFrames: 10_000_000, deliveredBytes: 2_000_000, announcedBytes: 10_000_000 }),
    'lying',
  )
})

test('classifyContainerShape: unknown without enough evidence', () => {
  assert.equal(classifyContainerShape({ headerClaimFrames: null, metadataFrames: 10_000_000, deliveredBytes: 5, announcedBytes: 10 }), 'unknown')
  assert.equal(classifyContainerShape({ headerClaimFrames: 100, metadataFrames: null, deliveredBytes: 5, announcedBytes: 10 }), 'unknown')
  assert.equal(classifyContainerShape({ headerClaimFrames: 100, metadataFrames: 200, deliveredBytes: 0, announcedBytes: 10 }), 'unknown')
})

test('foldStreamEvent folds the loader-domain `stream: promoted` verdict (the 1.2.49 field report)', () => {
  // The raw-path promote rides the LOADER domain with a `stream: ` prefix; the
  // old domain guard dropped it, so `promoted` stayed false and the completion
  // verdict read UNKNOWN even though the stream had plainly completed.
  const rawPath = parseNativeStreamTranscript([
    { domain: 'stream', msg: 'first staged schedule id=abc endable=2015688 frames (42.0s of header claim 2015688)' },
    { domain: 'loader', msg: 'stream: promoted abc (2260641B, 8373220 frames) — cache entry complete' },
  ])
  assert.equal(rawPath.promoted, true)
  const transcode = parseNativeStreamTranscript([
    { domain: 'loader', msg: 'stream: promoted abc (3000000B, announced 3000000 — decodability+duration-gated)' },
  ])
  assert.equal(transcode.promoted, true)
  assert.equal(transcode.promotedDurationGated, true)
  assert.equal(transcode.promotedAnnouncedBytes, 3_000_000)
  // A loader line that is NOT a stream verdict is still ignored.
  assert.equal(parseNativeStreamTranscript([{ domain: 'loader', msg: 'active-load retry attempt 1 for abc' }]).promoted, false)
})

test('selectStreamWindow: the monotonic window never uses a wall clock (the 1.2.48 regression)', () => {
  // Native `t` is SECONDS since process start (~1e3), never epoch ms (~1.7e12).
  // An epoch-based cut matched nothing; a monotonic window keeps every recent
  // event. This is the exact shape of the field report's "RAW EVENTS (0)".
  const events = [
    { domain: 'stream', msg: 'old', t: 3_580 },
    { domain: 'stream', msg: 'recent', t: 3_604 },
    { domain: 'stream', msg: 'now', t: 3_605 },
  ]
  const kept = selectStreamWindow(events, { trackId: 'never-matches', nowSeconds: 3_605, lookbackSeconds: 20 })
  assert.deepEqual(kept.map((e) => e.msg), ['recent', 'now'])
  // With no explicit now, the newest event's own `t` is the base — still correct.
  const kept2 = selectStreamWindow(events, { trackId: 'never-matches', lookbackSeconds: 20 })
  assert.deepEqual(kept2.map((e) => e.msg), ['recent', 'now'])
})

test('selectStreamWindow: the current track\'s stream session wins even if older than the window', () => {
  const events = [
    { domain: 'stream', msg: 'staged load start row 1 id=OTHER autoplay=true', t: 100 },
    { domain: 'loader', msg: 'noise', t: 101 },
    { domain: 'stream', msg: 'staged load start row 7 id=abc autoplay=true', t: 200 },
    { domain: 'stream', msg: 'first staged schedule id=abc endable=3969000 frames (90.0s of header claim 3969000)', t: 260 },
  ]
  const kept = selectStreamWindow(events, { trackId: 'abc', nowSeconds: 500, lookbackSeconds: 20 })
  assert.equal(kept.length, 2, 'from the current track\'s start marker onward')
  assert.match(kept[0].msg, /staged load start row 7 id=abc/)
  const facts = parseNativeStreamTranscript(kept)
  assert.equal(facts.sawStagedLoadStart, true)
  assert.equal(facts.sawFirstStagedSchedule, true)
})

test('selectStreamWindow: another track\'s marker does not masquerade as the current session', () => {
  const events = [
    { domain: 'stream', msg: 'staged load start row 1 id=OTHER autoplay=true', t: 100 },
    { domain: 'stream', msg: 'first staged schedule id=OTHER endable=100 frames (1.0s of header claim 100)', t: 160 },
  ]
  // Current track is cached (no stream events of its own): the window applies,
  // and the OLD other-track session is excluded.
  const kept = selectStreamWindow(events, { trackId: 'abc', nowSeconds: 500, lookbackSeconds: 20 })
  assert.equal(kept.length, 0)
})

test('selectStreamWindow: timestamp-less events are kept, never silently dropped', () => {
  const kept = selectStreamWindow([{ domain: 'stream', msg: 'no stamp' }], { trackId: 'abc', nowSeconds: 500 })
  assert.equal(kept.length, 1)
})

test('evaluate: a healthy transcode streams, classifies honest and promotes', () => {
  const native = parseNativeStreamTranscript([
    { domain: 'stream', msg: 'staged load start row 2 id=abc autoplay=true' },
    { domain: 'stream', msg: 'first staged schedule id=abc endable=2205000 frames (50.0s of header claim 2205000)' },
    { domain: 'stream', msg: 'promoted abc (3000000B, announced 3000000 — decodability+duration-gated)' },
  ])
  const report = evaluateStreamVerification({
    trackId: 'abc',
    variant: 'opus@128',
    isTranscode: true,
    metadataDuration: 100,
    snapshotSize: 40_000_000,
    http: httpProbe(),
    native,
    stateSample: { deliveredBytes: 1_500_000, announcedBytes: 3_000_000, headerClaimFrames: 2_205_000, metadataFrames: 4_410_000 },
  })
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.status]))
  assert.equal(byId['server-total'], 'pass')
  assert.equal(byId['range-support'], 'pass')
  assert.equal(byId['progressive-container'], 'pass')
  assert.equal(byId['streaming-engaged'], 'pass')
  assert.equal(byId['estimate-health'], 'pass')
  assert.equal(byId['completion-verdict'], 'pass')
  // 2.205M claimed of a 4.41M-frame track at 50 % bytes → honest.
  assert.equal(report.containerShape, 'honest')
})

test('evaluate: chunked server is a WARN fallback, and a deferred stream that plays passes', () => {
  const native = parseNativeStreamTranscript([
    { domain: 'stream', msg: 'staged load start row 1 id=abc autoplay=true' },
    { domain: 'stream', msg: 'completed stream scheduled whole id=abc frames=4410000 (no staged schedule had formed)' },
    { domain: 'stream', msg: 'promoted abc (3000000B, announced 0 — decodability+duration-gated)' },
  ])
  const report = evaluateStreamVerification({
    trackId: 'abc',
    variant: 'opus@128',
    isTranscode: true,
    metadataDuration: 100,
    snapshotSize: 40_000_000,
    http: httpProbe({ contentLength: null, acceptRanges: null, sniffed: 'ogg-opus' }),
    native,
  })
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.status]))
  assert.equal(byId['server-total'], 'warn')
  assert.equal(byId['deferred-plays'], 'pass')
  assert.equal(report.containerShape, 'unknown', 'no state sample')
})

test('range-support: a 206 proves range support even when the headers are CORS-hidden', () => {
  // Accept-Ranges/Content-Range are not CORS-safelisted, so a webview fetch
  // cannot read them — the 1.2.49 report showed content-length present with
  // accept-ranges absent. The 206 status to a Range GET is the real evidence.
  const covered = evaluateStreamVerification({
    trackId: 'abc', variant: 'raw', isTranscode: false, metadataDuration: 100, snapshotSize: 1,
    http: httpProbe({ status: 206, acceptRanges: null, contentRange: null }), native: null,
  })
  assert.equal(covered.checks.find((c) => c.id === 'range-support')?.status, 'pass')
  // A 200 to the same request means the range was ignored — a genuine warn.
  const ignored = evaluateStreamVerification({
    trackId: 'abc', variant: 'raw', isTranscode: false, metadataDuration: 100, snapshotSize: 1,
    http: httpProbe({ status: 200, acceptRanges: null, contentRange: null }), native: null,
  })
  assert.equal(ignored.checks.find((c) => c.id === 'range-support')?.status, 'warn')
})

test('evaluate: a rejected short transcode FAILS the completion check', () => {
  const native = parseNativeStreamTranscript([
    { domain: 'stream', msg: 'first staged schedule id=abc endable=100 frames (0.0s of header claim 100)' },
    { domain: 'stream', msg: 'promoted transcode cut short (container claim 4.0s of metadata 240.0s) for abc — rejecting, scratch retained' },
  ])
  const report = evaluateStreamVerification({
    trackId: 'abc', variant: 'opus@128', isTranscode: true, metadataDuration: 240, snapshotSize: 40_000_000,
    http: httpProbe(), native,
  })
  const completion = report.checks.find((c) => c.id === 'completion-verdict')
  assert.equal(completion?.status, 'fail')
})

test('evaluate: no native capture (web / HTTP-only) leaves runtime checks unknown', () => {
  const report = evaluateStreamVerification({
    trackId: 'abc', variant: 'opus@128', isTranscode: true, metadataDuration: 100, snapshotSize: 40_000_000,
    http: httpProbe(), native: null,
  })
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.status]))
  assert.equal(byId['server-total'], 'pass')
  assert.equal(byId['streaming-engaged'], 'unknown')
  assert.equal(byId['completion-verdict'], 'unknown')
})

test('evaluate: a probe that could not run is unknown, never a false pass', () => {
  const report = evaluateStreamVerification({
    trackId: 'abc', variant: 'raw', isTranscode: false, metadataDuration: 100, snapshotSize: 1,
    http: null, native: emptyNativeStreamFacts(),
  })
  assert.equal(report.checks.find((c) => c.id === 'server-total')?.status, 'unknown')
})

test('formatStreamVerifyBundle is a paste-ready block carrying the raw evidence', () => {
  const report = evaluateStreamVerification({
    trackId: 'abc', variant: 'opus@128', isTranscode: true, metadataDuration: 100, snapshotSize: 40_000_000,
    http: httpProbe(), native: null,
  })
  const text = formatStreamVerifyBundle({
    report,
    context: { platform: 'ios-native', appVersion: '1.2.47', trackTitle: 'A Song', lowData: 'on', network: 'native metered=false' },
    http: httpProbe(),
    native: null,
    stateSample: null,
    rawLines: ['+0.000s info    stream  staged load start row 4 id=abc'],
  })
  assert.match(text, /MMDROME STREAM SELF-TEST/)
  assert.match(text, /HTTP PROBE/)
  assert.match(text, /STATE SAMPLE/)
  assert.match(text, /VERDICTS \(/)
  assert.match(text, /RAW EVENTS \(1\)/)
  assert.match(text, /staged load start row 4/)
  assert.ok(text.length > 300, 'a usable bundle is substantial')
})

test('formatStreamVerifyReport renders one line per check with its status', () => {
  const report = evaluateStreamVerification({
    trackId: 'abc', variant: 'opus@128', isTranscode: true, metadataDuration: 100, snapshotSize: 1,
    http: httpProbe(), native: null,
  })
  const text = formatStreamVerifyReport(report)
  assert.match(text, /stream self-test @/)
  assert.match(text, /\[PASS\s*\] Server announces a total/)
  assert.match(text, /\[UNKNOWN\] Native staged stream engaged/)
})
