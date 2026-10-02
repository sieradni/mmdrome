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
  evaluateStreamVerification,
  formatStreamVerifyReport,
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
    { domain: 'engine', level: 'info', msg: 'promoted abc (3000000B, 3969000 frames) — cache entry complete' },
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
