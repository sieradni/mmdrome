/**
 * Transport self-test core (2026-10-22e).
 *
 * The reported failure — "pause in the app but the lock screen still shows a
 * Pause button" — has survived one release. Its remaining candidate causes all
 * live on the NATIVE side of the bridge, in a place no JS test can reach, and
 * the one fact that would settle it (which button iOS paints) cannot be read by
 * any API: `MPNowPlayingInfoCenter` only ever answers with what the APP
 * assigned. So this module does the part that CAN be decided from evidence,
 * automatically and in one press:
 *
 *   1. Did an app-originated Pause actually publish rate 0? (If it did not, the
 *      metadata theory is alive and the graph theory is irrelevant.)
 *   2. Was the output graph still RUNNING after that Pause? (The L1 signature:
 *      the app keeps reading as audio-active, so the system keeps presenting
 *      "playing".)
 *   3. Did the system send a Pause while the app was ALREADY paused? That can
 *      only happen if the system believes playback continues — it is proof of
 *      the stale state that needs no eyes on the lock screen.
 *   4. Was the "press twice" symptom an extra tap? A stale Pause immediately
 *      followed by a Play from the accessory, inside a short window.
 *   5. After a graph-paused Pause, does a Play restart the graph and publish
 *      playing again? (The risk the graph pause introduces: a resume that
 *      publishes "playing" over an engine that never restarted.)
 *
 * Everything here is pure: it folds the `controlTranscript` that
 * `getDebugState()` already returns (see `BackgroundAudioPlugin.recordControl`)
 * and never touches a plugin, a clock or the DOM — the runner adapts. The HUD
 * renders the rows and copies the bundle; the paste-ready form keeps the RAW
 * transcript tail so a reviewer can re-derive any verdict without the app.
 *
 * Deliberately NOT a "did the icon look right" check. It cannot be, and a
 * module that pretended otherwise would be the same mistake as trusting an
 * assigned dictionary.
 */

/** One entry of the native control transcript (`[String: Any]` over the bridge). */
export type TranscriptEntry = Record<string, unknown>

/** The flat snapshot `NowPlayingController.debugState()` records per publication. */
interface PublicationSnapshot {
  revision?: number
  publisher?: string
  assignedRate?: number
  assignedElapsed?: number
  readableRate?: number
  readableElapsed?: number
  readableTrackId?: string
  cleared?: boolean
}

/** The engine's side-effect-free command snapshot (`AudioEngine.controlState()`). */
interface ControlSnapshot {
  desiredPlaying?: boolean
  intentRevision?: number
  isPlaying?: boolean
  isRunning?: boolean
  activeNodePlaying?: boolean
  interruptionActive?: boolean
  hasLiveSchedule?: boolean
  graphPauseOnUserPause?: boolean
}

export type CheckStatus = 'pass' | 'fail' | 'unknown' | 'info'

export interface CheckRow {
  id: string
  label: string
  status: CheckStatus
  detail: string
}

/** One Pause the transcript shows, with the facts that discriminate the theories. */
export interface PauseObservation {
  commandId: number
  origin: string
  /** Engine graph state recorded AFTER the command was accepted. */
  graphRunningAfter: boolean | null
  /** What the app assigned to the Now Playing dictionary for that command. */
  assignedRate: number | null
  /** What the system dictionary immediately read back. */
  readableRate: number | null
  /** True when intent already read paused at receipt (a stale remote Pause). */
  stale: boolean
}

export interface TransportAnalysis {
  rows: CheckRow[]
  pauses: PauseObservation[]
  /** Remote Pause→Play pairs inside the extra-tap window. */
  extraTaps: { stalePauseCommandId: number; playCommandId: number; gapMs: number }[]
  /** The experiment setting in force at capture time (null if unrecorded). */
  graphPauseOnUserPause: boolean | null
}

/**
 * A "press twice quickly" pair is one gesture plus a correction. Anything wider
 * than this is the user retrying deliberately, which says nothing about state.
 */
export const EXTRA_TAP_WINDOW_MS = 2500

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/** Native timestamps are monotonic SECONDS since process start, not epoch ms. */
function secondsOf(entry: TranscriptEntry): number | null {
  const t = entry.t
  return isNum(t) ? t : null
}

function controlOf(entry: TranscriptEntry, key: 'before' | 'after'): ControlSnapshot {
  return asObj(entry[key]) as ControlSnapshot
}

/**
 * The publication that belongs to a command. Commands and their resulting
 * publication land back to back (`interpret` publishes inside the command), but
 * artwork/timer publications can interleave, so this takes the first
 * publication at or after the command's own entry and no further than the next
 * command.
 */
function publicationFor(
  transcript: TranscriptEntry[],
  commandIndex: number,
): PublicationSnapshot | null {
  for (let i = commandIndex + 1; i < transcript.length; i++) {
    const entry = transcript[i]
    const kind = entry.kind
    if (kind === 'command') return null
    if (kind === 'publication') return asObj(entry.snapshot) as PublicationSnapshot
  }
  return null
}

/**
 * Fold the transcript into verdicts. `opts.graphPauseOnUserPause` is the
 * setting the capture reports; it decides what checks 2 and 5 EXPECT, not what
 * they observe — an observation that contradicts the setting is itself a
 * finding (the toggle did not reach the engine).
 */
export function analyzeTransportTranscript(
  transcript: TranscriptEntry[],
  opts: { graphPauseOnUserPause?: boolean | null } = {},
): TransportAnalysis {
  const setting = isBool(opts.graphPauseOnUserPause) ? opts.graphPauseOnUserPause : null
  const rows: CheckRow[] = []
  const pauses: PauseObservation[] = []
  const extraTaps: TransportAnalysis['extraTaps'] = []

  const commands = transcript
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind === 'command')

  if (commands.length === 0) {
    return {
      rows: [
        {
          id: 'transcript',
          label: 'command transcript present',
          status: 'unknown',
          detail: 'no commands recorded — reproduce the Pause first, then run the test',
        },
      ],
      pauses: [],
      extraTaps: [],
      graphPauseOnUserPause: setting,
    }
  }

  for (const { entry, index } of commands) {
    const semantic = String(entry.semantic ?? '')
    if (semantic !== 'pause') continue
    const after = controlOf(entry, 'after')
    const before = controlOf(entry, 'before')
    const publication = publicationFor(transcript, index)
    const assigned = isNum(publication?.assignedRate) ? (publication!.assignedRate as number) : null
    const readable = isNum(publication?.readableRate) ? (publication!.readableRate as number) : null
    pauses.push({
      commandId: isNum(entry.commandId) ? entry.commandId : -1,
      origin: String(entry.origin ?? 'unknown'),
      graphRunningAfter: isBool(after.isRunning) ? after.isRunning : null,
      assignedRate: assigned,
      readableRate: readable,
      // Already-paused intent at receipt: the system asked for a Pause the app
      // did not need. Only a stale system state produces that.
      stale: before.desiredPlaying === false,
    })
  }

  const appPauses = pauses.filter((p) => p.origin === 'app-bridge')
  const remotePauses = pauses.filter((p) => p.origin === 'remote-command')

  // 1 — did the app publish a paused dictionary?
  if (appPauses.length === 0) {
    rows.push({
      id: 'app-pause-published',
      label: 'app Pause publishes rate 0',
      status: 'unknown',
      detail: 'no app-origin Pause in the retained transcript',
    })
  } else {
    const bad = appPauses.filter((p) => p.readableRate !== 0 || p.assignedRate === null)
    rows.push({
      id: 'app-pause-published',
      label: 'app Pause publishes rate 0',
      status: bad.length === 0 ? 'pass' : 'fail',
      detail:
        bad.length === 0
          ? `all ${appPauses.length} app Pause(s) read back rate 0`
          : `${bad.length}/${appPauses.length} app Pause(s) did not read back rate 0 (commandIds ${bad
              .map((p) => p.commandId)
              .join(', ')}) — the metadata path is at fault`,
    })
  }

  // 2 — was the output graph still running? This is the L1 discriminator.
  const graphKnown = appPauses.filter((p) => p.graphRunningAfter !== null)
  if (graphKnown.length === 0) {
    rows.push({
      id: 'graph-after-pause',
      label: 'output graph after app Pause',
      status: 'unknown',
      detail: 'no app Pause carried an engine snapshot',
    })
  } else {
    const running = graphKnown.filter((p) => p.graphRunningAfter === true)
    const wantRunning = setting === false
    const contradicts = wantRunning ? graphKnown.length - running.length : running.length
    rows.push({
      id: 'graph-after-pause',
      label: 'output graph after app Pause',
      status: contradicts === 0 ? 'pass' : 'fail',
      detail:
        (setting === null
          ? 'setting not recorded — '
          : `graphPauseOnUserPause=${setting} — `) +
        `${running.length}/${graphKnown.length} app Pause(s) left the graph RUNNING` +
        (contradicts === 0
          ? ''
          : wantRunning
            ? ' (graph stopped although the experiment was off)'
            : ' (graph kept running although the experiment was on) — if the lock screen is also stale, L1 is confirmed'),
    })
  }

  // 3 — a remote Pause while already paused is proof of a stale system state.
  if (remotePauses.length === 0) {
    rows.push({
      id: 'stale-remote-pause',
      label: 'system sent Pause while already paused',
      status: 'unknown',
      detail: 'no system-origin Pause in the transcript — press the lock-screen control first',
    })
  } else {
    const stale = remotePauses.filter((p) => p.stale)
    rows.push({
      id: 'stale-remote-pause',
      label: 'system sent Pause while already paused',
      status: stale.length > 0 ? 'fail' : 'pass',
      detail:
        stale.length > 0
          ? `${stale.length}/${remotePauses.length} system Pause(s) arrived after the app was already paused (commandIds ${stale
              .map((p) => p.commandId)
              .join(', ')}) — the system believed playback continued without reading it off the lock screen`
          : `${remotePauses.length} system Pause(s), all while the app believed it was playing`,
    })
  }

  // 4 — the extra tap: a stale remote Pause then a remote Play inside the window.
  for (let i = 0; i < commands.length; i++) {
    const { entry } = commands[i]
    if (entry.kind !== 'command' || entry.semantic !== 'pause') continue
    if (entry.origin !== 'remote-command') continue
    if (controlOf(entry, 'before').desiredPlaying !== false) continue
    const pauseTs = secondsOf(entry)
    if (pauseTs === null) continue
    for (let j = i + 1; j < commands.length; j++) {
      const next = commands[j].entry
      const semantic = String(next.semantic ?? '')
      if (semantic === 'pause') break
      if (semantic !== 'play' && semantic !== 'toggle') continue
      if (next.origin !== 'remote-command') continue
      const ts = secondsOf(next)
      if (ts === null) continue
      const gapMs = (ts - pauseTs) * 1000
      if (gapMs <= EXTRA_TAP_WINDOW_MS) {
        extraTaps.push({
          stalePauseCommandId: isNum(entry.commandId) ? entry.commandId : -1,
          playCommandId: isNum(next.commandId) ? next.commandId : -1,
          gapMs: Math.round(gapMs),
        })
      }
      break
    }
  }
  rows.push({
    id: 'extra-tap',
    label: 'no corrective second press needed',
    status: extraTaps.length === 0 ? 'pass' : 'fail',
    detail:
      extraTaps.length === 0
        ? 'no stale-Pause → Play pair inside the extra-tap window'
        : extraTaps
            .map((t) => `stale Pause #${t.stalePauseCommandId} → Play #${t.playCommandId} after ${t.gapMs} ms`)
            .join('; '),
  })

  // 5 — the graph-pause risk: a resume that publishes playing over a dead graph.
  if (setting === false) {
    rows.push({
      id: 'resume-after-graph-pause',
      label: 'Play restarts a paused graph',
      status: 'info',
      detail: 'experiment off — no graph was paused, nothing to restart',
    })
  } else {
    let checked = 0
    let stranded = 0
    let sawPlayAfterPause = false
    for (let i = 0; i < commands.length; i++) {
      const cur = commands[i].entry
      if (cur.kind !== 'command' || cur.semantic !== 'play') continue
      const prevPause = [...commands.slice(0, i)]
        .reverse()
        .find(({ entry }) => entry.kind === 'command' && entry.semantic === 'pause')
      if (!prevPause) continue
      const pausedGraph = controlOf(prevPause.entry, 'after').isRunning === false
      if (!pausedGraph) continue
      sawPlayAfterPause = true
      const after = controlOf(cur, 'after')
      if (after.isRunning === false || after.isPlaying === false) {
        // A Play that is still buffering legitimately reports isPlaying false;
        // only a Play whose graph never came back is the dangerous shape.
        if (after.isRunning === false) stranded++
      }
      checked++
    }
    rows.push({
      id: 'resume-after-graph-pause',
      label: 'Play restarts a paused graph',
      status: !sawPlayAfterPause ? 'unknown' : stranded === 0 ? 'pass' : 'fail',
      detail: !sawPlayAfterPause
        ? 'no Play followed a graph-paused Pause yet — resume and check the audio'
        : stranded === 0
          ? `${checked} Play(s) after a graph-paused Pause left the graph running`
          : `${stranded}/${checked} Play(s) left the graph stopped — the resume is stranded (silence with a playing UI)`,
    })
  }

  return { rows, pauses, extraTaps, graphPauseOnUserPause: setting }
}

/** A settled verdict for the whole capture (the HUD's one-word answer). */
export function overallVerdict(analysis: TransportAnalysis): 'pass' | 'fail' | 'unknown' {
  if (analysis.rows.some((r) => r.status === 'fail')) return 'fail'
  if (analysis.rows.some((r) => r.status === 'unknown')) return 'unknown'
  return 'pass'
}

/**
 * Paste-ready bundle. The RAW tail is included on purpose: every verdict above
 * is re-derivable from it, so a report can be audited without re-running.
 */
export function formatTransportSelfTestBundle(input: {
  capturedAtMs: number
  analysis: TransportAnalysis
  transcript: TranscriptEntry[]
  context: Record<string, unknown>
  rawTail?: number
}): string {
  const { analysis, transcript } = input
  const tail = input.rawTail ?? 40
  const lines: string[] = []
  lines.push('=== TRANSPORT SELF-TEST (lock screen play/pause) ===')
  lines.push(`captured: ${new Date(input.capturedAtMs).toISOString()}`)
  const ctx = input.context
  const ctxKeys = Object.keys(ctx).sort()
  if (ctxKeys.length > 0) {
    lines.push(
      'context: ' + ctxKeys.map((k) => `${k}=${JSON.stringify(ctx[k])}`).join(' '),
    )
  }
  lines.push(`experiment: graphPauseOnUserPause=${String(analysis.graphPauseOnUserPause)}`)
  lines.push(`verdict: ${overallVerdict(analysis).toUpperCase()}`)
  lines.push('')
  lines.push('CHECKS')
  for (const row of analysis.rows) {
    lines.push(`  [${row.status.toUpperCase().padEnd(7)}] ${row.label}: ${row.detail}`)
  }
  lines.push('')
  lines.push('PAUSES')
  if (analysis.pauses.length === 0) lines.push('  (none)')
  for (const p of analysis.pauses) {
    lines.push(
      `  #${p.commandId} origin=${p.origin} graphRunningAfter=${String(p.graphRunningAfter)}` +
        ` assignedRate=${String(p.assignedRate)} readableRate=${String(p.readableRate)}` +
        ` stale=${p.stale}`,
    )
  }
  lines.push('')
  lines.push(`RAW TRANSCRIPT (last ${Math.min(tail, transcript.length)} of ${transcript.length})`)
  for (const entry of transcript.slice(-tail)) {
    lines.push('  ' + JSON.stringify(entry))
  }
  lines.push('REMINDER: a pass here proves what the APP assigned and did — not what iOS painted.')
  return lines.join('\n')
}
