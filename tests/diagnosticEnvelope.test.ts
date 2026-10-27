import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDiagnosticEnvelope,
  buildDiagnosticErrorSummary,
} from '../src/lib/diagnosticEnvelope'
import {
  dbg,
  dbgAlways,
  dbgDanger,
  clearJsDebugEvents,
  jsDebugEventsSnapshot,
  jsDebugDroppedCount,
  jsDebugSessionId,
  setEnabledDomains,
} from '../src/lib/debugLog'
import { summarizePushOutcomes, type PushRunReport } from '../src/lib/pushOutcome'

test('D-01: buildDiagnosticEnvelope captures app identity, clocks, sessions, drops, and reports', () => {
  const env = buildDiagnosticEnvelope({
    capturedAtMs: 1700000001000,
    jsPerfNowMs: 12345.6,
    jsSessionId: 'js-sess-1',
    appVersion: '1.2.72',
    commitHash: 'abc1234',
    buildTime: '2026-10-26T00:00:00Z',
    osMajor: 18,
    nativeDebug: {
      nativeSessionId: 'nat-sess-1',
      nativeAppVersion: '1.2.72',
      nativeBuildVersion: '72',
      osVersion: '18.1',
      clock: { uptime: 5416.86, epochMs: 1700000000950 },
      controlTranscript: [{ commandId: 1 }],
      controlTranscriptDropped: 0,
    },
    nativePolledAtMs: 1700000000960,
    jsEventsCount: 12,
    jsEventsDropped: 0,
    nativeEventsCount: 708,
    nativeEventsDropped: 0,
    enabledDomains: ['loader', 'stream'],
    lastPushReport: null,
    hasStreamVerifyReport: true,
  })

  assert.equal(env.build.appVersion, '1.2.72')
  assert.equal(env.build.commitHash, 'abc1234')
  assert.equal(env.build.nativeBuildVersion, '72')
  assert.equal(env.os.osVersionString, '18.1')
  assert.match(env.os.probeProvenanceNote, /evidence-based decoder probes/)
  assert.equal(env.jsSessionId, 'js-sess-1')
  assert.equal(env.nativeSessionId, 'nat-sess-1')
  assert.equal(env.clocks.nativeUptimeSec, 5416.86)
  assert.equal(env.clocks.nativeCaptureAgeMs, 40)
  assert.match(env.clocks.correlationNote, /monotonic systemUptime/)
  assert.equal(env.rings.controlTranscriptCount, 1)
  assert.equal(env.retainedReports.hasStreamVerifyReport, true)
  assert.ok(jsDebugSessionId().length > 0)
})

test('D-02: buildDiagnosticErrorSummary distinguishes danger, recoverable, push, and console mirror evidence', () => {
  const counts = summarizePushOutcomes([])
  counts.failed = 3
  counts.conflictsRecovered = 1

  const fakePushReport: PushRunReport = {
    runId: 'push-1',
    startedAt: '2026-10-26T00:00:00Z',
    completedAt: '2026-10-26T00:00:01Z',
    durationMs: 1000,
    status: 'completed',
    transport: 'web',
    baseKeyHashed: 'dav.example.com',
    cancelled: false,
    catalogRefresh: 'triggered',
    counts,
    failureGroups: [],
    rows: [],
    rowsTruncated: 0,
    firstFailureReason: 'PUT 403 Forbidden',
  }

  const summary = buildDiagnosticErrorSummary({
    jsEvents: [
      { t: 1, level: 'info', domain: 'sync', msg: 'Library loaded (cache-reuse)' },
      { t: 2, level: 'danger', domain: 'network', msg: 'load retry 1/3 scheduled' },
      { t: 3, level: 'danger', domain: 'global', msg: 'Uncaught ReferenceError' },
    ],
    nativeEvents: [
      { level: 'danger', domain: 'session', msg: 'Engine activation failed' },
      { level: 'danger', domain: 'loader', msg: 'stream: promoted t1 despite writer error' },
    ],
    lastPushReport: fakePushReport,
    hudConsoleMirror: ['[12:00:00] trackChanged -> t1'],
  })

  // 1 hard JS + 1 hard native + 3 push failed = 5 danger
  assert.equal(summary.dangerCount, 5)
  // 1 recoverable JS + 1 recoverable native + 1 push recovered = 3 recoverable
  assert.equal(summary.recoverableCount, 3)
  assert.equal(summary.consoleMirrorCount, 1)
  assert.match(summary.note, /legacy HUD-only/)
  assert.equal(summary.items.length, 7)
})

test('D-03: debugLog tracks ring capacity drops and filters opt-in domains', () => {
  clearJsDebugEvents()
  setEnabledDomains([])

  dbg('preload', 'ignored when domain off')
  assert.equal(jsDebugEventsSnapshot().length, 0)

  setEnabledDomains(['preload'])
  const origDebug = console.debug
  const origInfo = console.info
  const origWarn = console.warn
  console.debug = () => {}
  console.info = () => {}
  console.warn = () => {}
  try {
    dbg('preload', 'recorded when domain on')
    assert.equal(jsDebugEventsSnapshot().length, 1)

    for (let i = 0; i < 1005; i++) {
      dbgAlways('sync', `msg-${i}`)
    }
    assert.equal(jsDebugEventsSnapshot().length, 1000)
    assert.equal(jsDebugDroppedCount(), 6)

    dbgDanger('global', 'critical failure')
    assert.equal(jsDebugDroppedCount(), 7)
    assert.equal(jsDebugEventsSnapshot()[999].level, 'danger')
  } finally {
    console.debug = origDebug
    console.info = origInfo
    console.warn = origWarn
    setEnabledDomains([])
    clearJsDebugEvents()
  }
  assert.equal(jsDebugDroppedCount(), 0)
})
