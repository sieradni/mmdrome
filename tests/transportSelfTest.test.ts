import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeTransportTranscript,
  formatTransportSelfTestBundle,
  overallVerdict,
  EXTRA_TAP_WINDOW_MS,
  type CheckRow,
  type TranscriptEntry,
} from '../src/lib/transportSelfTest'

/**
 * The transport self-test is the field instrument for the lock-screen
 * play/pause report (2026-10-22e). Its verdicts are only worth trusting if they
 * fail on the shapes they claim to catch, so each case below is a transcript a
 * reviewer could actually get off a phone.
 */

function cmd(o: {
  id: number
  semantic: string
  origin: string
  t: number
  before?: Record<string, unknown>
  after?: Record<string, unknown>
}): TranscriptEntry {
  return {
    kind: 'command',
    commandId: o.id,
    semantic: o.semantic,
    origin: o.origin,
    t: o.t,
    before: { desiredPlaying: true, isPlaying: true, isRunning: true, ...o.before },
    after: { desiredPlaying: false, isPlaying: false, isRunning: false, ...o.after },
  }
}

function pub(o: { t: number; assignedRate: number; readableRate?: number }): TranscriptEntry {
  return {
    kind: 'publication',
    t: o.t,
    snapshot: {
      assignedRate: o.assignedRate,
      readableRate: o.readableRate ?? o.assignedRate,
      assignedElapsed: 12.5,
    },
  }
}

const row = (rows: CheckRow[], id: string): CheckRow => {
  const found = rows.find((r) => r.id === id)
  assert.ok(found, `missing check row: ${id}`)
  return found
}

test('app Pause that published rate 0 and stopped the graph passes the L1 checks', () => {
  const transcript = [
    cmd({ id: 1, semantic: 'pause', origin: 'app-bridge', t: 10, after: { isRunning: false } }),
    pub({ t: 10.001, assignedRate: 0 }),
  ]
  const analysis = analyzeTransportTranscript(transcript, { graphPauseOnUserPause: true })
  assert.equal(row(analysis.rows, 'app-pause-published').status, 'pass')
  assert.equal(row(analysis.rows, 'graph-after-pause').status, 'pass')
  assert.equal(analysis.pauses.length, 1)
  assert.equal(analysis.pauses[0].graphRunningAfter, false)
  assert.equal(analysis.pauses[0].readableRate, 0)
})

test('a graph that kept running while the experiment was ON fails the L1 check', () => {
  // The pre-fix signature: rate 0 assigned and read back, graph still running.
  const transcript = [
    cmd({ id: 1, semantic: 'pause', origin: 'app-bridge', t: 10, after: { isRunning: true } }),
    pub({ t: 10.001, assignedRate: 0 }),
  ]
  const analysis = analyzeTransportTranscript(transcript, { graphPauseOnUserPause: true })
  const graph = row(analysis.rows, 'graph-after-pause')
  assert.equal(graph.status, 'fail')
  assert.match(graph.detail, /graph kept running although the experiment was on/)
  // The metadata path itself was correct — that distinction is the whole point.
  assert.equal(row(analysis.rows, 'app-pause-published').status, 'pass')
  assert.equal(overallVerdict(analysis), 'fail')
})

test('a graph that stopped while the experiment was OFF also fails (toggle did not reach the engine)', () => {
  const transcript = [
    cmd({ id: 1, semantic: 'pause', origin: 'app-bridge', t: 10, after: { isRunning: false } }),
    pub({ t: 10.001, assignedRate: 0 }),
  ]
  const analysis = analyzeTransportTranscript(transcript, { graphPauseOnUserPause: false })
  assert.equal(row(analysis.rows, 'graph-after-pause').status, 'fail')
  assert.match(row(analysis.rows, 'graph-after-pause').detail, /graph stopped although the experiment was off/)
})

test('an app Pause whose dictionary did not read back 0 fails the publication check', () => {
  const transcript = [
    cmd({ id: 1, semantic: 'pause', origin: 'app-bridge', t: 10, after: { isRunning: false } }),
    pub({ t: 10.001, assignedRate: 0, readableRate: 1 }),
  ]
  const analysis = analyzeTransportTranscript(transcript, { graphPauseOnUserPause: true })
  assert.equal(row(analysis.rows, 'app-pause-published').status, 'fail')
  assert.match(row(analysis.rows, 'app-pause-published').detail, /did not read back rate 0/)
})

test('a system Pause delivered while the app was already paused is reported as a stale system state', () => {
  const transcript = [
    cmd({ id: 1, semantic: 'pause', origin: 'app-bridge', t: 10, after: { isRunning: false } }),
    pub({ t: 10.001, assignedRate: 0 }),
    // The lock-screen press: intent already read paused when it arrived.
    cmd({
      id: 2,
      semantic: 'pause',
      origin: 'remote-command',
      t: 20,
      before: { desiredPlaying: false, isPlaying: false, isRunning: false },
      after: { desiredPlaying: false, isPlaying: false, isRunning: false },
    }),
    pub({ t: 20.001, assignedRate: 0 }),
    // The corrective second press.
    cmd({
      id: 3,
      semantic: 'play',
      origin: 'remote-command',
      t: 20.6,
      before: { desiredPlaying: false, isPlaying: false, isRunning: false },
      after: { desiredPlaying: true, isPlaying: true, isRunning: true },
    }),
    pub({ t: 20.601, assignedRate: 1 }),
  ]
  const analysis = analyzeTransportTranscript(transcript, { graphPauseOnUserPause: true })
  assert.equal(row(analysis.rows, 'stale-remote-pause').status, 'fail')
  assert.match(row(analysis.rows, 'stale-remote-pause').detail, /the system believed playback continued/)
  assert.equal(analysis.extraTaps.length, 1)
  assert.equal(analysis.extraTaps[0].stalePauseCommandId, 2)
  assert.equal(analysis.extraTaps[0].playCommandId, 3)
  assert.equal(analysis.extraTaps[0].gapMs, 600)
  assert.equal(row(analysis.rows, 'extra-tap').status, 'fail')
})

test('a system Pause that arrives while playing is not called stale and is not an extra tap', () => {
  const transcript = [
    cmd({ id: 1, semantic: 'pause', origin: 'remote-command', t: 10 }),
    pub({ t: 10.001, assignedRate: 0 }),
    cmd({ id: 2, semantic: 'play', origin: 'remote-command', t: 30, before: { desiredPlaying: false, isPlaying: false } }),
    pub({ t: 30.001, assignedRate: 1 }),
  ]
  const analysis = analyzeTransportTranscript(transcript, { graphPauseOnUserPause: true })
  assert.equal(row(analysis.rows, 'stale-remote-pause').status, 'pass')
  assert.equal(analysis.extraTaps.length, 0)
  assert.equal(row(analysis.rows, 'extra-tap').status, 'pass')
})

test('a second press outside the extra-tap window is a deliberate retry, not a corrective tap', () => {
  const transcript = [
    cmd({ id: 1, semantic: 'pause', origin: 'app-bridge', t: 10, after: { isRunning: false } }),
    pub({ t: 10.001, assignedRate: 0 }),
    cmd({ id: 2, semantic: 'pause', origin: 'remote-command', t: 20, before: { desiredPlaying: false, isPlaying: false } }),
    pub({ t: 20.001, assignedRate: 0 }),
    cmd({
      id: 3,
      semantic: 'play',
      origin: 'remote-command',
      t: 20 + EXTRA_TAP_WINDOW_MS / 1000 + 5,
      before: { desiredPlaying: false, isPlaying: false },
    }),
    pub({ t: 40, assignedRate: 1 }),
  ]
  const analysis = analyzeTransportTranscript(transcript, { graphPauseOnUserPause: true })
  assert.equal(analysis.extraTaps.length, 0)
  assert.equal(row(analysis.rows, 'extra-tap').status, 'pass')
})

test('a Play whose graph never restarted after a graph-paused Pause is reported as stranded', () => {
  const transcript = [
    cmd({ id: 1, semantic: 'pause', origin: 'app-bridge', t: 10, after: { isRunning: false } }),
    pub({ t: 10.001, assignedRate: 0 }),
    // Play accepted, node claims playing, but the engine never came back.
    cmd({
      id: 2,
      semantic: 'play',
      origin: 'app-bridge',
      t: 20,
      before: { desiredPlaying: false, isPlaying: false, isRunning: false },
      after: { desiredPlaying: true, isPlaying: true, isRunning: false },
    }),
    pub({ t: 20.001, assignedRate: 1 }),
  ]
  const analysis = analyzeTransportTranscript(transcript, { graphPauseOnUserPause: true })
  const resume = row(analysis.rows, 'resume-after-graph-pause')
  assert.equal(resume.status, 'fail')
  assert.match(resume.detail, /stranded \(silence with a playing UI\)/)
})

test('the resume check passes when the graph restarted', () => {
  const transcript = [
    cmd({ id: 1, semantic: 'pause', origin: 'app-bridge', t: 10, after: { isRunning: false } }),
    pub({ t: 10.001, assignedRate: 0 }),
    cmd({
      id: 2,
      semantic: 'play',
      origin: 'app-bridge',
      t: 20,
      before: { desiredPlaying: false, isPlaying: false, isRunning: false },
      after: { desiredPlaying: true, isPlaying: true, isRunning: true },
    }),
    pub({ t: 20.001, assignedRate: 1 }),
  ]
  const analysis = analyzeTransportTranscript(transcript, { graphPauseOnUserPause: true })
  assert.equal(row(analysis.rows, 'resume-after-graph-pause').status, 'pass')
})

test('the resume check is unknown, not passing, before any Play follows', () => {
  const transcript = [
    cmd({ id: 1, semantic: 'pause', origin: 'app-bridge', t: 10, after: { isRunning: false } }),
    pub({ t: 10.001, assignedRate: 0 }),
  ]
  const analysis = analyzeTransportTranscript(transcript, { graphPauseOnUserPause: true })
  assert.equal(row(analysis.rows, 'resume-after-graph-pause').status, 'unknown')
  assert.equal(overallVerdict(analysis), 'unknown')
})

test('an empty transcript reports unknown rather than passing', () => {
  const analysis = analyzeTransportTranscript([], { graphPauseOnUserPause: true })
  assert.equal(analysis.rows.length, 1)
  assert.equal(analysis.rows[0].status, 'unknown')
  assert.equal(overallVerdict(analysis), 'unknown')
  const text = formatTransportSelfTestBundle({
    capturedAtMs: 0,
    analysis,
    transcript: [],
    context: {},
  })
  assert.match(text, /verdict: UNKNOWN/)
  assert.match(text, /REMINDER: a pass here proves what the APP assigned and did/)
})
