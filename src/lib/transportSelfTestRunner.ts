/**
 * Adapter half of the transport self-test (2026-10-22e). Reads the native
 * `getDebugState()` snapshot, hands its `controlTranscript` to the pure
 * evaluator in `transportSelfTest.ts`, and returns ONE paste-ready bundle.
 *
 * Read-only, by design: capturing never pauses, plays, seeks or changes a
 * setting. The graph-pause fix it was built to decide is now unconditional
 * policy (2026-10-23), so there is no experiment left to flip.
 *
 * The one thing no API can answer is the actual lock-screen glyph. This runner
 * therefore reports what the evidence DOES establish — the published rate, the
 * engine graph state, and whether iOS asked for a Pause the app did not need —
 * and the formatter says so in the bundle so a later reader cannot mistake it
 * for a UI observation.
 */
import { BackgroundAudio } from './nativePlugin'
import { appVersion } from './version'
import {
  analyzeTransportTranscript,
  formatTransportSelfTestBundle,
  overallVerdict,
  type TranscriptEntry,
} from './transportSelfTest'

interface DebugStateLike {
  controlTranscript?: unknown
  controlTranscriptDropped?: unknown
  nowPlaying?: unknown
  nowPlayingTimerActive?: unknown
  isRunning?: unknown
  isPlaying?: unknown
  desiredPlaying?: unknown
  interruptionActive?: unknown
  osVersion?: unknown
  nativeAppVersion?: unknown
  nativeBuildVersion?: unknown
  nativeSessionId?: unknown
}

export interface TransportSelfTestResult {
  report: string
  verdict: 'pass' | 'fail' | 'unknown'
}

async function readDebugState(): Promise<DebugStateLike | null> {
  try {
    const d = await (BackgroundAudio as unknown as { getDebugState?: () => Promise<DebugStateLike> })
      .getDebugState?.()
    return d ?? null
  } catch {
    return null
  }
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
  const analysis = analyzeTransportTranscript(transcript)
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
  return { report, verdict: overallVerdict(analysis) }
}
