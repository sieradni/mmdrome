/**
 * Shared diagnostic envelope and cross-source error summary (D-01, D-02, D-04).
 *
 * Pure, DOM/Dexie-free so the envelope assembly, clock-skew / suspension-gap
 * correlation notes, and error aggregation across JS/native/push/control
 * sources are unit-testable in Node.
 */

import type { JsDebugEvent } from './debugLog'
import type { PushRunReport } from './pushOutcome'

export interface DiagnosticClockSample {
  jsEpochMs: number
  jsPerfNowMs: number
  nativeUptimeSec: number | null
  nativeEpochMs: number | null
  /** Difference between JS capture time and when the native snapshot was polled (ms). */
  nativeCaptureAgeMs: number | null
  /** Note explaining cross-clock correlation limits (monotonic uptime pauses during iOS suspend). */
  correlationNote: string
}

export interface DiagnosticEnvelope {
  capturedAtIso: string
  jsSessionId: string
  nativeSessionId: string | null
  build: {
    appVersion: string
    commitHash: string
    buildTime: string
    nativeAppVersion: string | null
    nativeBuildVersion: string | null
  }
  os: {
    osMajor: number | null
    osVersionString: string | null
    probeProvenanceNote: string
  }
  clocks: DiagnosticClockSample
  rings: {
    jsEventsCount: number
    jsEventsDropped: number
    nativeEventsCount: number
    nativeEventsDropped: number
    controlTranscriptCount: number
    controlTranscriptDropped: number
    enabledDomains: string[]
  }
  retainedReports: {
    hasPushReport: boolean
    pushRunId: string | null
    pushPhase: string | null
    hasStreamVerifyReport: boolean
  }
}

export interface DiagnosticErrorSummaryItem {
  source: 'js-event' | 'native-event' | 'push-report' | 'control-transcript' | 'hud-console'
  severity: 'danger' | 'recoverable' | 'console-mirror'
  count: number
  latestMessage: string
}

export interface DiagnosticErrorSummary {
  dangerCount: number
  recoverableCount: number
  consoleMirrorCount: number
  note: string
  items: DiagnosticErrorSummaryItem[]
}

export function buildDiagnosticEnvelope(input: {
  capturedAtMs: number
  jsPerfNowMs: number
  jsSessionId: string
  appVersion: string
  commitHash: string
  buildTime: string
  osMajor: number | null
  nativeDebug: Record<string, unknown> | null
  nativePolledAtMs: number | null
  jsEventsCount: number
  jsEventsDropped: number
  nativeEventsCount: number
  nativeEventsDropped: number
  enabledDomains: string[]
  lastPushReport: PushRunReport | null
  hasStreamVerifyReport: boolean
}): DiagnosticEnvelope {
  const nd = input.nativeDebug
  const nativeClock = (nd?.clock as { uptime?: number; epochMs?: number } | undefined) ?? null
  const nativeUptimeSec = typeof nativeClock?.uptime === 'number' ? nativeClock.uptime : null
  const nativeEpochMs = typeof nativeClock?.epochMs === 'number' ? nativeClock.epochMs : null
  const nativeCaptureAgeMs =
    input.nativePolledAtMs !== null ? Math.max(0, input.capturedAtMs - input.nativePolledAtMs) : null

  const controlTranscript = Array.isArray(nd?.controlTranscript) ? nd.controlTranscript : []
  const controlTranscriptDropped = typeof nd?.controlTranscriptDropped === 'number' ? nd.controlTranscriptDropped : 0

  return {
    capturedAtIso: new Date(input.capturedAtMs).toISOString(),
    jsSessionId: input.jsSessionId,
    nativeSessionId: typeof nd?.nativeSessionId === 'string' ? nd.nativeSessionId : null,
    build: {
      appVersion: input.appVersion,
      commitHash: input.commitHash,
      buildTime: input.buildTime,
      nativeAppVersion: typeof nd?.nativeAppVersion === 'string' ? nd.nativeAppVersion : null,
      nativeBuildVersion: typeof nd?.nativeBuildVersion === 'string' ? nd.nativeBuildVersion : null,
    },
    os: {
      osMajor: input.osMajor,
      osVersionString: typeof nd?.osVersion === 'string' ? nd.osVersion : null,
      probeProvenanceNote:
        'transcodeProbe verdicts are evidence-based decoder probes per format; OS version is context only and never overrides probe verdicts',
    },
    clocks: {
      jsEpochMs: input.capturedAtMs,
      jsPerfNowMs: Math.round(input.jsPerfNowMs),
      nativeUptimeSec,
      nativeEpochMs,
      nativeCaptureAgeMs,
      correlationNote:
        'nativeEvents.t uses monotonic systemUptime (pauses during iOS sleep); jsEvents.t uses wall-clock epoch ms. Compare across clocks using nativeEpochMs + nativeCaptureAgeMs, with uncertainty across device suspend.',
    },
    rings: {
      jsEventsCount: input.jsEventsCount,
      jsEventsDropped: input.jsEventsDropped,
      nativeEventsCount: input.nativeEventsCount,
      nativeEventsDropped: input.nativeEventsDropped,
      controlTranscriptCount: controlTranscript.length,
      controlTranscriptDropped,
      enabledDomains: input.enabledDomains,
    },
    retainedReports: {
      hasPushReport: input.lastPushReport !== null,
      pushRunId: input.lastPushReport?.runId ?? null,
      pushPhase: input.lastPushReport?.status ?? null,
      hasStreamVerifyReport: input.hasStreamVerifyReport,
    },
  }
}

const RECOVERABLE_PATTERNS = [
  /retry \d+\/\d+/i,
  /re-attempt/i,
  /Range-resumes/i,
  /scratch retained/i,
  /parked/i,
  /reparked/i,
  /recovered/i,
  /promoted .* despite writer error/i,
  /continuation for/i,
]

function isRecoverableMessage(msg: string): boolean {
  return RECOVERABLE_PATTERNS.some((re) => re.test(msg))
}

/**
 * Summarize danger vs recoverable failures across JS events, native events,
 * durable WebDAV push reports, and the HUD-only console/event mirror (`errorLog`).
 * Quiet recoveries are classified as `recoverable` so they remain visible for
 * postmortem without inflating permanent danger totals.
 */
export function buildDiagnosticErrorSummary(input: {
  jsEvents: JsDebugEvent[]
  nativeEvents: Array<{ level?: string; domain?: string; msg?: string }>
  lastPushReport: PushRunReport | null
  hudConsoleMirror: string[]
}): DiagnosticErrorSummary {
  const items: DiagnosticErrorSummaryItem[] = []
  let dangerCount = 0
  let recoverableCount = 0

  const jsDanger = input.jsEvents.filter((e) => e.level === 'danger')
  const jsRecov = jsDanger.filter((e) => isRecoverableMessage(e.msg))
  const jsHard = jsDanger.filter((e) => !isRecoverableMessage(e.msg))
  if (jsHard.length > 0) {
    dangerCount += jsHard.length
    items.push({
      source: 'js-event',
      severity: 'danger',
      count: jsHard.length,
      latestMessage: `[${jsHard[jsHard.length - 1].domain}] ${jsHard[jsHard.length - 1].msg}`,
    })
  }
  if (jsRecov.length > 0) {
    recoverableCount += jsRecov.length
    items.push({
      source: 'js-event',
      severity: 'recoverable',
      count: jsRecov.length,
      latestMessage: `[${jsRecov[jsRecov.length - 1].domain}] ${jsRecov[jsRecov.length - 1].msg}`,
    })
  }

  const natDanger = input.nativeEvents.filter((e) => e.level === 'danger')
  const natRecov = natDanger.filter((e) => isRecoverableMessage(String(e.msg ?? '')))
  const natHard = natDanger.filter((e) => !isRecoverableMessage(String(e.msg ?? '')))
  if (natHard.length > 0) {
    dangerCount += natHard.length
    const last = natHard[natHard.length - 1]
    items.push({
      source: 'native-event',
      severity: 'danger',
      count: natHard.length,
      latestMessage: `[${last.domain ?? '?'}] ${last.msg ?? ''}`,
    })
  }
  if (natRecov.length > 0) {
    recoverableCount += natRecov.length
    const last = natRecov[natRecov.length - 1]
    items.push({
      source: 'native-event',
      severity: 'recoverable',
      count: natRecov.length,
      latestMessage: `[${last.domain ?? '?'}] ${last.msg ?? ''}`,
    })
  }

  const pr = input.lastPushReport
  if (pr) {
    const pushFailed = pr.counts.failed
    if (pushFailed > 0) {
      dangerCount += pushFailed
      items.push({
        source: 'push-report',
        severity: 'danger',
        count: pushFailed,
        latestMessage: pr.firstFailureReason ?? `${pushFailed} WebDAV push row(s) failed`,
      })
    }
    if (pr.counts.conflictsRecovered > 0) {
      recoverableCount += pr.counts.conflictsRecovered
      items.push({
        source: 'push-report',
        severity: 'recoverable',
        count: pr.counts.conflictsRecovered,
        latestMessage: `WebDAV push recovered ${pr.counts.conflictsRecovered} conflict(s) on retry`,
      })
    }
  }

  const consoleMirrorCount = input.hudConsoleMirror.length
  if (consoleMirrorCount > 0) {
    items.push({
      source: 'hud-console',
      severity: 'console-mirror',
      count: consoleMirrorCount,
      latestMessage: input.hudConsoleMirror[0],
    })
  }

  return {
    dangerCount,
    recoverableCount,
    consoleMirrorCount,
    note:
      'errorLog is the legacy HUD-only console.error + bridge transition mirror (includes routine trackChanged/playbackState lines); use items[] for structured danger vs recoverable verdicts.',
    items,
  }
}
