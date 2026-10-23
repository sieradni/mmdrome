/**
 * Transport self-test core (2026-10-22e, reduced 2026-10-23).
 *
 * Folds the native `controlTranscript` into verdicts about the lock-screen
 * play/pause report, whose cause is now settled: a user Pause that left the
 * `AVAudioEngine` running kept the app reading as audio-active, so iOS kept
 * presenting "playing"; pausing the output graph fixed it on the reporting
 * device (A/B on 1.2.66, recorded in docs/plans/2026-10-22-field-reliability…).
 *
 * What survives is the passive instrument: did the app publish a paused
 * dictionary, did the graph actually stop, did the system ask for a Pause the app
 * had already made (only a stale system state does that — the one stale-icon
 * proof that needs no eyes), and did a resume restart the graph. The glyph
 * itself is still unanswerable from any API, so it is never claimed: the bundle
 * says so in its own last line.
 *
 * Two rules the field bundles taught (2026-10-23); both are pinned by tests
 * because both were shipped wrong first:
 *
 *  1. A command's publication is emitted BEFORE the command record and shares
 *     its outer `commandId`. Attribution is by that id — a forward scan graded a
 *     pause with the NEXT command's rate and found nothing for the last command
 *     in the ring.
 *  2. A command's graph state is read from its publication's `engine` snapshot,
 *     falling back to the command's own `after`. Reading only the command
 *     snapshot condemned a resume that the very next publication proved healthy.
 */

/** One entry of the native control transcript (`[String: Any]` over the bridge). */
export type TranscriptEntry = Record<string, unknown>

/** The engine's side-effect-free snapshot (`AudioEngine.controlState()`). */
interface ControlSnapshot {
  desiredPlaying?: boolean
  isPlaying?: boolean
  isRunning?: boolean
}

export type CheckStatus = 'pass' | 'fail' | 'unknown'

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
  /** Output-graph state after the command: its publication, else its `after`. */
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
  return isNum(entry.t) ? entry.t : null
}

function controlOf(entry: TranscriptEntry, key: 'before' | 'after'): ControlSnapshot {
  return asObj(entry[key]) as ControlSnapshot
}

/**
 * The publication belonging to each command, keyed by `commandId`. A command
 * publishes its dictionary and then records itself, so both rows carry the id;
 * `command:<origin>` is that command's own write and outranks the ambient
 * `state` edge it may also follow. Ambient rows carry `commandId: 0` and are
 * never attributed to a command.
 */
function publicationByCommand(transcript: TranscriptEntry[]): Map<number, TranscriptEntry> {
  const byId = new Map<number, TranscriptEntry>()
  for (const entry of transcript) {
    if (entry.kind !== 'publication') continue
    const id = entry.commandId
    if (!isNum(id) || id <= 0) continue
    const publisher = String(asObj(entry.snapshot).publisher ?? '')
    if (!byId.has(id) || publisher.startsWith('command:')) byId.set(id, entry)
  }
  return byId
}

/**
 * Publish-then-render: the publication's `engine` snapshot is the state the
 * system was told about, so it is the truth; a command without one falls back to
 * its own `after`. Returns null when neither row carries a boolean.
 */
function graphRunningAfter(
  publication: TranscriptEntry | undefined,
  after: ControlSnapshot,
): boolean | null {
  const engine = asObj(publication?.engine)
  if (isBool(engine.isRunning)) return engine.isRunning
  return isBool(after.isRunning) ? after.isRunning : null
}

/** Fold the transcript into verdicts. */
export function analyzeTransportTranscript(transcript: TranscriptEntry[]): TransportAnalysis {
  const rows: CheckRow[] = []
  const pauses: PauseObservation[] = []
  const extraTaps: TransportAnalysis['extraTaps'] = []

  const commands = transcript.filter((entry) => entry.kind === 'command')

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
    }
  }

  const publications = publicationByCommand(transcript)

  for (const entry of commands) {
    if (entry.semantic !== 'pause') continue
    const commandId = isNum(entry.commandId) ? entry.commandId : -1
    const publication = publications.get(commandId)
    const snapshot = asObj(publication?.snapshot)
    pauses.push({
      commandId,
      origin: String(entry.origin ?? 'unknown'),
      graphRunningAfter: graphRunningAfter(publication, controlOf(entry, 'after')),
      assignedRate: isNum(snapshot.assignedRate) ? snapshot.assignedRate : null,
      readableRate: isNum(snapshot.readableRate) ? snapshot.readableRate : null,
      // Already-paused intent at receipt: the system asked for a Pause the app
      // did not need. Only a stale system state produces that.
      stale: controlOf(entry, 'before').desiredPlaying === false,
    })
  }

  // 1 — did the app publish a paused dictionary?
  const appPauses = pauses.filter((p) => p.origin === 'app-bridge')
  const remotePauses = pauses.filter((p) => p.origin === 'remote-command')
  if (appPauses.length === 0) {
    rows.push({
      id: 'app-pause-published',
      label: 'app Pause publishes rate 0',
      status: 'unknown',
      detail: 'no app-origin Pause in the retained transcript',
    })
  } else {
    const unrecorded = appPauses.filter((p) => p.assignedRate === null)
    const wrong = appPauses.filter(
      (p) => p.assignedRate !== null && (p.assignedRate !== 0 || p.readableRate !== 0),
    )
    // A proven fault outranks missing evidence; missing evidence never passes.
    const status: CheckStatus = wrong.length > 0 ? 'fail' : unrecorded.length > 0 ? 'unknown' : 'pass'
    rows.push({
      id: 'app-pause-published',
      label: 'app Pause publishes rate 0',
      status,
      detail:
        wrong.length > 0
          ? `${wrong.length}/${appPauses.length} app Pause(s) did not publish/read back rate 0 (commandIds ${wrong
              .map((p) => p.commandId)
              .join(', ')}) — the lock screen has nothing but this dictionary to read`
          : unrecorded.length > 0
            ? `no publication recorded for app Pause(s) ${unrecorded
                .map((p) => p.commandId)
                .join(', ')} — the ring may have rolled; reproduce, then capture`
            : `all ${appPauses.length} app Pause(s) published and read back rate 0`,
    })
  }

  // 2 — did every Pause stop the output graph? This is the shipped policy: a
  // running AVAudioEngine keeps the app reading as audio-active, which is the
  // stale lock-screen button. Any accepted Pause that leaves it running is the
  // bug the field reported.
  const graphKnown = pauses.filter((p) => p.graphRunningAfter !== null)
  const graphRunning = graphKnown.filter((p) => p.graphRunningAfter === true)
  rows.push({
    id: 'graph-after-pause',
    label: 'output graph after Pause',
    status: graphKnown.length === 0 ? 'unknown' : graphRunning.length === 0 ? 'pass' : 'fail',
    detail:
      graphKnown.length === 0
        ? 'no Pause carried an engine snapshot'
        : graphRunning.length === 0
          ? `all ${graphKnown.length} Pause(s) stopped the output graph`
          : `${graphRunning.length}/${graphKnown.length} Pause(s) left the output graph RUNNING (commandIds ${graphRunning
              .map((p) => p.commandId)
              .join(', ')}) — the stale-lock-screen condition`,
  })

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
    const entry = commands[i]
    if (entry.semantic !== 'pause' || entry.origin !== 'remote-command') continue
    if (controlOf(entry, 'before').desiredPlaying !== false) continue
    const pauseTs = secondsOf(entry)
    if (pauseTs === null) continue
    for (let j = i + 1; j < commands.length; j++) {
      const next = commands[j]
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

  // 5 — the resume risk: a Play that publishes playing over a graph that never
  // came back is silence with a playing UI. Resolved from the play's OWN
  // publication, which is the state the system was shown.
  let checked = 0
  let stranded = 0
  // Observed independently of the Play loop: a graph-stopped Pause with no Play
  // yet is "not measured", while no graph-stopped Pause at all is "not exercised".
  const graphStoppedPause = pauses.some((p) => p.graphRunningAfter === false)
  for (let i = 0; i < commands.length; i++) {
    const entry = commands[i]
    if (entry.semantic !== 'play') continue
    const prevPause = [...commands.slice(0, i)].reverse().find((e) => e.semantic === 'pause')
    if (!prevPause) continue
    const pauseId = isNum(prevPause.commandId) ? prevPause.commandId : -1
    if (graphRunningAfter(publications.get(pauseId), controlOf(prevPause, 'after')) !== false) {
      continue
    }
    checked++
    const playId = isNum(entry.commandId) ? entry.commandId : -1
    if (graphRunningAfter(publications.get(playId), controlOf(entry, 'after')) === false) stranded++
  }
  rows.push({
    id: 'resume-after-graph-pause',
    label: 'Play restarts a paused graph',
    status: checked === 0 ? 'unknown' : stranded === 0 ? 'pass' : 'fail',
    detail:
      checked === 0
        ? graphStoppedPause
          ? 'a graph-stopped Pause has no following Play yet — resume and check the audio'
          : 'no graph-stopped Pause recorded yet — pause in the app, then Play'
        : stranded === 0
          ? `${checked} Play(s) after a graph-stopped Pause left the graph running`
          : `${stranded}/${checked} Play(s) left the graph stopped — the resume is stranded (silence with a playing UI)`,
  })

  return { rows, pauses, extraTaps }
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
  const contextKeys = Object.keys(input.context).sort()
  if (contextKeys.length > 0) {
    lines.push(
      'context: ' + contextKeys.map((k) => `${k}=${JSON.stringify(input.context[k])}`).join(' '),
    )
  }
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
