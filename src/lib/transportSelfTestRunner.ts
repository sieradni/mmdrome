/**
 * Adapter half of the transport self-test (2026-10-22e). Reads the native
 * `getDebugState()` snapshot, hands its `controlTranscript` to the pure
 * evaluator in `transportSelfTest.ts`, and returns ONE paste-ready bundle.
 *
 * Read-only, by design: capturing never pauses, plays, seeks or mutates the
 * experiment setting. The setting has its own explicit call
 * (`setGraphPauseOnUserPause`) because flipping it changes behavior the user is
 * about to listen to, and a "diagnose" button must not silently alter it.
 *
 * The one thing no API can answer is the actual lock-screen glyph. This runner
 * therefore reports what the evidence DOES establish — the published rate, the
 * engine graph state, and whether iOS asked for a Pause the app did not need —
 * and the formatter says so in the bundle so a later reader cannot mistake it
 * for a UI observation.
 */
import { Capacitor } from '@capacitor/core'
import { BackgroundAudio, nativeEngine } from './nativePlugin'
import { appVersion } from './version'
import {
  analyzeTransportTranscript,
  formatTransportSelfTestBundle,
  overallVerdict,
  type TranscriptEntry,
  type TransportAnalysis,
} from './transportSelfTest'

interface DebugStateLike {
  controlTranscript?: unknown
  controlTranscriptDropped?: unknown
  nowPlaying?: unknown
  nowPlayingTimerActive?: unknown
  graphPauseOnUserPause?: unknown
  isRunning?: unknown
  isPlaying?: unknown
  desiredPlaying?: unknown
  interruptionActive?: unknown
  appState?: unknown
  osVersion?: unknown
  nativeAppVersion?: unknown
  nativeBuildVersion?: unknown
  nativeSessionId?: unknown
  clock?: unknown
}

export interface TransportSelfTestResult {
  analysis: TransportAnalysis
  report: string
  verdict: 'pass' | 'fail' | 'unknown'
}

/** Native-only: the web engine has no output graph to pause. */
export function isTransportSelfTestAvailable(): boolean {
  return Capacitor.isNativePlatform()
}

async function readDebugState(): Promise<DebugStateLike | null> {
  try {
    const d = await (BackgroundAudio as unknown as { getDebugState?: () => Promise<DebugStateLike> }).getDebugState?.()
    return d ?? null
  } catch {
    return null
  }
}

/**
 * Flip the transport experiment (user Pause pauses the output graph, or keeps it
 * running). Resolves to the value the ENGINE now holds, so a failed bridge call
 * shows up as a mismatch rather than a silently stale toggle.
 */
export async function setGraphPauseOnUserPause(enabled: boolean): Promise<boolean> {
  if (!isTransportSelfTestAvailable()) return enabled
  try {
    const res = await nativeEngine.setTransportExperiment({ graphPauseOnUserPause: enabled })
    return Boolean(res?.graphPauseOnUserPause ?? enabled)
  } catch {
    return !enabled
  }
}

/** The setting the engine is actually running under, read from its own dump. */
export async function readGraphPauseOnUserPause(): Promise<boolean | null> {
  const d = await readDebugState()
  const value = d?.graphPauseOnUserPause
  return typeof value === 'boolean' ? value : null
}

/**
 * Capture and analyse. The transcript is native-retained (160 entries), so the
 * user reproduces first and presses the button afterwards — a bug that fired
 * before the HUD was even open is still in the ring.
 */
export async function captureTransportSelfTest(): Promise<TransportSelfTestResult | null> {
  const d = await readDebugState()
  if (!d) return null
  const transcript = Array.isArray(d.controlTranscript)
    ? (d.controlTranscript as TranscriptEntry[])
    : []
  const setting = typeof d.graphPauseOnUserPause === 'boolean' ? d.graphPauseOnUserPause : null
  const analysis = analyzeTransportTranscript(transcript, { graphPauseOnUserPause: setting })
  const nowPlaying = (d.nowPlaying ?? {}) as Record<string, unknown>
  const report = formatTransportSelfTestBundle({
    capturedAtMs: Date.now(),
    analysis,
    transcript,
    context: {
      jsVersion: appVersion,
      nativeVersion: d.nativeAppVersion,
      nativeBuild: d.nativeBuildVersion,
      osVersion: d.osVersion,
      engineRunning: d.isRunning,
      enginePlaying: d.isPlaying,
      desiredPlaying: d.desiredPlaying,
      interruptionActive: d.interruptionActive,
      timerActive: d.nowPlayingTimerActive,
      // The app's own assignment and its read-back — the pair that proves the
      // dictionary was written, never that the system displayed it.
      assignedRate: nowPlaying.assignedRate,
      readableRate: nowPlaying.readableRate,
      cleared: nowPlaying.cleared,
      transcriptDropped: d.controlTranscriptDropped,
      nativeSessionId: d.nativeSessionId,
    } as Record<string, unknown>,
  })
  return { analysis, report, verdict: overallVerdict(analysis) }
}
