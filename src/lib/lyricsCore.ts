/**
 * Pure lyrics core — DOM/Dexie/fetch-free so every rule here is unit-testable.
 *
 * Sources: OpenSubsonic `getLyricsBySongId` structured lyrics (Navidrome ≥0.55
 * serves embedded SYLT/USLT tags + .lrc sidecars through it), with an LRC
 * fallback parser for text payloads.
 */

/** One lyric line. `startMs` is relative to the TRACK start (already includes
 *  any container/`[offset:…]` correction). `endMs` is derived — see
 *  `deriveLineEnds`. Unsynced docs carry lines with startMs = null. */
export interface LyricLine {
  startMs: number | null
  endMs: number | null
  text: string
}

/** The normalized lyric document the UI renders. */
export interface LyricDoc {
  synced: boolean
  lines: LyricLine[]
  /** Metadata from the container (may be absent). */
  lang?: string
  displayArtist?: string
  displayTitle?: string
}

/** Raw OpenSubsonic structured-lyrics object (subset we consume). */
export interface RawStructuredLyrics {
  synced?: boolean
  lang?: string
  displayArtist?: string
  displayTitle?: string
  /** Server-declared playback offset in MILLISECONDS (signed). */
  offset?: number
  line?: Array<{ start?: number; value?: string }>
}

/** Text used for instrumental-break markers (parsed empty lines and long
 *  gaps alike) — see `isBreakMarker`. */
export const BREAK_MARKER = '♪'

// ── LRC parsing ────────────────────────────────────────────────────────────

/** Matches one [mm:ss] / [mm:ss.xx] / [mm:ss.xxx] timestamp. */
const LRC_TIME = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

/** Non-timestamp bracketed tags we skip (metadata, not lyric content): any
 *  `[key:value]` whose key starts with a LETTER (timestamps start with digits:
 *  `[00:01.50]`), which covers ti/ar/al/by/offset/length plus unknown tools. */
const LRC_META_TAG = /^\[([A-Za-z][A-Za-z0-9_+-]*):(.*)\]$/

function parseLrcTimestamp(m: RegExpExecArray): number {
  const min = parseInt(m[1], 10)
  const sec = parseInt(m[2], 10)
  const fracRaw = m[3] ?? '0'
  // Centiseconds are the LRC convention (×10 → ms); a 3-digit fraction is
  // already milliseconds.
  const fracMs = fracRaw.length === 3 ? parseInt(fracRaw, 10) : parseInt(fracRaw.padEnd(2, '0'), 10) * 10
  return min * 60_000 + sec * 1000 + fracMs
}

/**
 * Parses an LRC payload into lyric lines.
 *
 * - One line may carry MULTIPLE timestamps (`[00:12.00][01:30.00]text`) —
 *   standard for repeated choruses; each timestamp becomes its own line.
 * - The `[offset:+ms]` tag shifts ALL timestamps: a POSITIVE offset means the
 *   lyrics display EARLIER (the LRC convention), so effective start =
 *   stamped − offset. (The container-level OpenSubsonic `offset` field is the
 *   opposite sign: start + offset — applied in `normalizeStructuredLyrics`.)
 * - Unknown bracketed tags are skipped; malformed input never throws.
 */
export function parseLrc(raw: string): LyricLine[] {
  const lines: LyricLine[] = []
  let offsetMs = 0

  for (const rawLine of raw.split(/\r\n|\r|\n/)) {
    // Consume only LEADING, back-to-back timestamps.
    const stamps: number[] = []
    let consumed = 0
    for (;;) {
      LRC_TIME.lastIndex = consumed
      const m = LRC_TIME.exec(rawLine)
      if (!m || m.index !== consumed) break
      stamps.push(parseLrcTimestamp(m))
      consumed = m.index + m[0].length
    }

    const text = rawLine.slice(consumed).trim()

    if (stamps.length === 0) {
      const meta = text.match(LRC_META_TAG)
      if (meta) {
        if (meta[1].toLowerCase() === 'offset') {
          const v = parseInt(meta[2].trim(), 10)
          if (Number.isFinite(v)) offsetMs = v
        }
        continue
      }
      // Untimed content line in an otherwise-synced payload: keep it as an
      // unsynced line so nothing user-visible is dropped.
      if (text.length > 0) lines.push({ startMs: null, endMs: null, text })
      continue
    }

    // Empty stamped line = instrumental stretch → break marker.
    lines.push(...stamps.map((t) => ({ startMs: t - offsetMs, endMs: null, text: text.length > 0 ? text : BREAK_MARKER })))
  }

  return lines
}

// ── Structured-lyrics normalization ───────────────────────────────────────

/**
 * Normalizes a raw structuredLyrics object. Applies the container `offset`
 * (signed ms, ADDED to every line start — the OpenSubsonic field semantics),
 * sorts by start, and derives end times.
 */
export function normalizeStructuredLyrics(raw: RawStructuredLyrics): LyricDoc | null {
  const rows = Array.isArray(raw.line) ? raw.line : []
  const synced = raw.synced === true
  const containerOffset = typeof raw.offset === 'number' && Number.isFinite(raw.offset) ? raw.offset : 0

  const lines: LyricLine[] = []
  for (const row of rows) {
    const text = typeof row.value === 'string' ? row.value : ''
    if (text.trim().length === 0) continue
    const start = typeof row.start === 'number' && Number.isFinite(row.start) ? row.start + containerOffset : null
    lines.push({ startMs: synced ? start : null, endMs: null, text })
  }
  if (lines.length === 0) return null

  if (synced) {
    // A "synced" doc whose rows all lack timestamps degrades to unsynced —
    // the UI must not drive an empty timeline.
    if (lines.every((l) => l.startMs === null)) {
      return { synced: false, lines, lang: raw.lang, displayArtist: raw.displayArtist, displayTitle: raw.displayTitle }
    }
    lines.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0))
  }

  deriveLineEnds(lines, null)
  return { synced, lines, lang: raw.lang, displayArtist: raw.displayArtist, displayTitle: raw.displayTitle }
}

/**
 * Builds a doc from a plain-text payload (legacy getLyrics or unsynced tags):
 * one unsynced line per non-empty row.
 */
export function lyricsFromPlainText(text: string, meta?: { lang?: string; displayArtist?: string; displayTitle?: string }): LyricDoc {
  const lines: LyricLine[] = text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => ({ startMs: null, endMs: null, text: l }))
  return { synced: false, lines, lang: meta?.lang, displayArtist: meta?.displayArtist, displayTitle: meta?.displayTitle }
}

/** Chooses the best variant: synced beats unsynced; otherwise the first. */
export function pickLyricsVariant(raws: RawStructuredLyrics[]): RawStructuredLyrics | null {
  if (!Array.isArray(raws) || raws.length === 0) return null
  return raws.find((r) => r.synced === true) ?? raws[0]
}

// ── Timing ────────────────────────────────────────────────────────────────

/**
 * Fills `endMs` on every synced line: a line ends where the next line starts;
 * the LAST line ends at the track duration when known, otherwise at its start
 * + 5 s. A gap longer than `breakGapMs` gets an explicit "♪" break line
 * inserted at the gap MIDPOINT (it becomes active there, ending at the next
 * real line) so long instrumental stretches don't strand a stale highlight.
 * Untimed lines pass through untouched. Idempotent within a doc.
 */
export function deriveLineEnds(lines: LyricLine[], trackDurationMs: number | null, breakGapMs = 8_000): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startMs === null) continue
    const next = lines[i + 1]
    const nextStart = next && next.startMs !== null ? next.startMs : null
    if (nextStart !== null && nextStart - line.startMs >= breakGapMs) {
      const breakStart = line.startMs + Math.floor((nextStart - line.startMs) / 2)
      line.endMs = breakStart
      lines.splice(i + 1, 0, { startMs: breakStart, endMs: nextStart, text: BREAK_MARKER })
      i++ // skip the inserted break (its end is already correct)
      continue
    }
    line.endMs = nextStart ?? (trackDurationMs !== null ? trackDurationMs : line.startMs + 5_000)
  }
}

/**
 * Index of the active line at `tMs`, or −1 before the first line. Requires a
 * SYNCED doc (all `startMs` present — unsynced docs are rendered statically
 * and never ask). Returns the LAST line whose startMs ≤ tMs; break markers
 * participate like any line.
 */
export function activeLineIndex(lines: LyricLine[], tMs: number): number {
  if (lines.length === 0 || lines[0].startMs === null) return -1
  let lo = 0
  let hi = lines.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const start = lines[mid].startMs as number
    if (start <= tMs) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

// ── Break markers ─────────────────────────────────────────────────────────

/** True when the line is an instrumental-break marker ("♪") — parsed empty
 *  stamped lines and gaps-derived inserts alike. */
export function isBreakMarker(line: LyricLine): boolean {
  return line.text === BREAK_MARKER
}
