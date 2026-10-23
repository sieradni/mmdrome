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
 * play/pause report. Its verdicts are only worth trusting if they fail on the
 * shapes they claim to catch, so every case below is a transcript a reviewer
 * could get off a phone — built in the native emit order (publication FIRST,
 * command SECOND, shared `commandId`). Fixtures in a shape the recorder cannot
 * produce are how wrong verdicts shipped twice.
 */

function command(o: {
  id: number
  semantic: string
  origin: string
  t?: number
  before?: Record<string, unknown>
  after?: Record<string, unknown>
}): TranscriptEntry {
  return {
    kind: 'command',
    commandId: o.id,
    semantic: o.semantic,
    origin: o.origin,
    t: o.t ?? o.id,
    before: { desiredPlaying: true, isPlaying: true, isRunning: true, ...o.before },
    after: { desiredPlaying: false, isPlaying: false, isRunning: false, ...o.after },
  }
}

/**
 * `engineRunning` is the graph state in the publication's own engine snapshot —
 * what the system was actually shown. Omit it to exercise the `after` fallback.
 */
function publication(o: {
  id: number
  t?: number
  assignedRate: number
  readableRate?: number
  publisher?: string
  engineRunning?: boolean
}): TranscriptEntry {
  return {
    kind: 'publication',
    commandId: o.id,
    t: o.t ?? o.id,
    ...(o.engineRunning === undefined ? {} : { engine: { isRunning: o.engineRunning } }),
    snapshot: {
      assignedRate: o.assignedRate,
      readableRate: o.readableRate ?? o.assignedRate,
      publisher: o.publisher ?? 'command:app-bridge',
    },
  }
}

/** A Pause plus the publication the system was shown, in emit order. */
function pause(o: {
  id: number
  rate?: number
  readableRate?: number
  graphRunning?: boolean
  origin?: string
  stale?: boolean
  t?: number
  noPublication?: boolean
}): TranscriptEntry[] {
  const running = o.graphRunning ?? false
  return [
    ...(o.noPublication
      ? []
      : [
          publication({
            id: o.id,
            assignedRate: o.rate ?? 0,
            readableRate: o.readableRate,
            engineRunning: running,
            publisher: `command:${o.origin ?? 'app-bridge'}`,
          }),
        ]),
    command({
      id: o.id,
      semantic: 'pause',
      origin: o.origin ?? 'app-bridge',
      t: o.t,
      before: { desiredPlaying: !o.stale },
      after: { isRunning: running },
    }),
  ]
}

/** A Play plus its publication. `afterRunning` models a command snapshot that lagged. */
function play(o: { id: number; origin?: string; t?: number; graphRunning?: boolean; afterRunning?: boolean }): TranscriptEntry[] {
  const origin = o.origin ?? 'app-bridge'
  const running = o.graphRunning ?? true
  const afterRunning = o.afterRunning ?? running
  return [
    publication({ id: o.id, assignedRate: 1, engineRunning: running, publisher: `command:${origin}` }),
    command({
      id: o.id,
      semantic: 'play',
      origin,
      t: o.t,
      before: { desiredPlaying: false, isPlaying: false, isRunning: false },
      after: { desiredPlaying: true, isPlaying: true, isRunning: afterRunning },
    }),
  ]
}

const row = (rows: CheckRow[], id: string): CheckRow => {
  const found = rows.find((r) => r.id === id)
  assert.ok(found, `missing check row: ${id}`)
  return found
}

const healthyRun = (): TranscriptEntry[] => [
  ...pause({ id: 1 }),
  ...play({ id: 2, origin: 'remote-command' }),
  ...pause({ id: 3, origin: 'remote-command' }),
  ...play({ id: 4 }),
]

test('a healthy run passes every check', () => {
  const analysis = analyzeTransportTranscript(healthyRun())
  assert.deepEqual(
    analysis.rows.map((r) => r.status),
    ['pass', 'pass', 'pass', 'pass', 'pass'],
  )
  assert.equal(overallVerdict(analysis), 'pass')
  assert.equal(analysis.pauses.length, 2)
})

test('a Pause that leaves the output graph running fails, naming the command', () => {
  // The shipped bug: rate 0 assigned and read back, engine still rendering.
  const analysis = analyzeTransportTranscript(pause({ id: 7, graphRunning: true }))
  const graph = row(analysis.rows, 'graph-after-pause')
  assert.equal(graph.status, 'fail')
  assert.match(graph.detail, /1\/1 Pause\(s\) left the output graph RUNNING \(commandIds 7\)/)
  // The dictionary itself was correct — that distinction is the whole point.
  assert.equal(row(analysis.rows, 'app-pause-published').status, 'pass')
  assert.equal(overallVerdict(analysis), 'fail')
})

test('a Pause whose dictionary did not read back 0 fails', () => {
  const analysis = analyzeTransportTranscript(pause({ id: 1, rate: 0, readableRate: 1 }))
  assert.equal(row(analysis.rows, 'app-pause-published').status, 'fail')
  assert.match(row(analysis.rows, 'app-pause-published').detail, /did not publish\/read back rate 0/)
})

test('a Pause with no publication at all is NOT a pass (previously a false PASS)', () => {
  const analysis = analyzeTransportTranscript([...pause({ id: 1 }), ...pause({ id: 2, noPublication: true })])
  const published = row(analysis.rows, 'app-pause-published')
  assert.equal(published.status, 'unknown')
  assert.match(published.detail, /no publication recorded for app Pause\(s\) 2/)
  assert.equal(overallVerdict(analysis), 'unknown')
})

test('a proven wrong dictionary still fails when another Pause has no publication', () => {
  const analysis = analyzeTransportTranscript([
    ...pause({ id: 1, rate: 1 }),
    ...pause({ id: 2, noPublication: true }),
  ])
  assert.equal(row(analysis.rows, 'app-pause-published').status, 'fail')
})

test('a publication is attributed by commandId, never by adjacency (previously a false FAIL)', () => {
  // Pause #1's rows are rate 0; #2's publication is rate 1 and must not leak in.
  const analysis = analyzeTransportTranscript([
    publication({ id: 1, assignedRate: 0, publisher: 'state' }),
    ...pause({ id: 1 }),
    publication({ id: 2, assignedRate: 1 }),
    ...play({ id: 2, origin: 'remote-command' }),
  ])
  assert.equal(analysis.pauses[0].assignedRate, 0)
  assert.equal(analysis.pauses[0].readableRate, 0)
  assert.equal(row(analysis.rows, 'app-pause-published').status, 'pass')
})

test('the last command in the ring still finds its own publication', () => {
  // Publication after the command record: no forward row to borrow, none needed.
  const analysis = analyzeTransportTranscript([
    publication({ id: 5, assignedRate: 0, publisher: 'state' }),
    command({ id: 5, semantic: 'pause', origin: 'app-bridge' }),
    publication({ id: 5, assignedRate: 0 }),
  ])
  assert.equal(analysis.pauses[0].assignedRate, 0)
  assert.equal(row(analysis.rows, 'app-pause-published').status, 'pass')
})

test('a system Pause delivered while already paused is a stale state plus an extra tap', () => {
  const analysis = analyzeTransportTranscript([
    ...pause({ id: 1 }),
    ...pause({ id: 2, origin: 'remote-command', stale: true, t: 20 }),
    ...play({ id: 3, origin: 'remote-command', t: 20.6 }),
  ])
  assert.equal(row(analysis.rows, 'stale-remote-pause').status, 'fail')
  assert.match(row(analysis.rows, 'stale-remote-pause').detail, /the system believed playback continued/)
  assert.deepEqual(
    [analysis.extraTaps[0].stalePauseCommandId, analysis.extraTaps[0].playCommandId, analysis.extraTaps[0].gapMs],
    [2, 3, 600],
  )
  assert.equal(row(analysis.rows, 'extra-tap').status, 'fail')
})

test('a system Pause while playing is neither stale nor an extra tap', () => {
  const analysis = analyzeTransportTranscript([
    ...pause({ id: 1, origin: 'remote-command' }),
    ...play({ id: 2, origin: 'remote-command', t: 30 }),
  ])
  assert.equal(row(analysis.rows, 'stale-remote-pause').status, 'pass')
  assert.equal(analysis.extraTaps.length, 0)
  assert.equal(row(analysis.rows, 'extra-tap').status, 'pass')
})

test('a second press outside the extra-tap window is a deliberate retry', () => {
  const analysis = analyzeTransportTranscript([
    ...pause({ id: 1, origin: 'remote-command', stale: true, t: 1 }),
    ...play({ id: 2, origin: 'remote-command', t: 1 + EXTRA_TAP_WINDOW_MS / 1000 + 5 }),
  ])
  assert.equal(analysis.extraTaps.length, 0)
  assert.equal(row(analysis.rows, 'extra-tap').status, 'pass')
})

test('a resume the Play publication proves running passes even if the command snapshot lagged', () => {
  // The false FAIL this instrument shipped: `after.isRunning` false while the
  // publication the system was shown already reports the graph running.
  const analysis = analyzeTransportTranscript([
    ...pause({ id: 1 }),
    ...play({ id: 2, graphRunning: true, afterRunning: false }),
  ])
  assert.equal(row(analysis.rows, 'resume-after-graph-pause').status, 'pass')
})

test('a Play whose publication still shows a stopped graph is reported as stranded', () => {
  const analysis = analyzeTransportTranscript([
    ...pause({ id: 1 }),
    ...play({ id: 2, graphRunning: false }),
  ])
  const resume = row(analysis.rows, 'resume-after-graph-pause')
  assert.equal(resume.status, 'fail')
  assert.match(resume.detail, /stranded \(silence with a playing UI\)/)
})

test('the resume check says WHICH evidence is missing, not just unknown', () => {
  const stopped = analyzeTransportTranscript(pause({ id: 1 }))
  const row1 = row(stopped.rows, 'resume-after-graph-pause')
  assert.equal(row1.status, 'unknown')
  assert.match(row1.detail, /has no following Play yet/)
  assert.equal(overallVerdict(stopped), 'unknown')

  // No Pause at all: nothing was exercised, so the reason differs.
  const noPause = analyzeTransportTranscript(play({ id: 1 }))
  const row2 = row(noPause.rows, 'resume-after-graph-pause')
  assert.equal(row2.status, 'unknown')
  assert.match(row2.detail, /no graph-stopped Pause recorded yet/)
})

test('an empty transcript reports unknown rather than passing', () => {
  const analysis = analyzeTransportTranscript([])
  assert.equal(analysis.rows.length, 1)
  assert.equal(analysis.rows[0].status, 'unknown')
  assert.equal(overallVerdict(analysis), 'unknown')
})

test('the bundle names each pause, keeps the raw tail and states its own limit', () => {
  const transcript = healthyRun()
  const text = formatTransportSelfTestBundle({
    capturedAtMs: 0,
    analysis: analyzeTransportTranscript(transcript),
    transcript,
    context: { jsVersion: '1.2.67' },
  })
  assert.match(text, /verdict: PASS/)
  assert.match(text, /context: jsVersion="1.2.67"/)
  assert.match(text, /#1 origin=app-bridge graphRunningAfter=false assignedRate=0 readableRate=0 stale=false/)
  assert.match(text, /RAW TRANSCRIPT \(last 8 of 8\)/)
  assert.doesNotMatch(text, /experiment:/)
  assert.match(text, /REMINDER: a pass here proves what the APP assigned and did/)
})
