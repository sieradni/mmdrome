import { normalizeForMatch } from "./matchNormalize"
import type { Track } from "../stores/appState"
import type { WebdavFileEntry, LocalMetadataStore } from "./db"

/**
 * Pure matching/scoring core for WebDAV file binding (TODO 3.6t): every
 * decision the scanner and the File Matching UI share — filename/tag scoring,
 * the auto-bind evidence gate, candidate classification, the index
 * fingerprint, and the mtime change-diff — lives here as a DOM/Dexie-free
 * module over plain data. `metadataReader`/`metadataScanner` are thin
 * interpreters that feed it probed entries and apply its verdicts.
 */

/** Known audio extensions the probe/scorer touches (mirrors Track['fileType']). */
const AUDIO_EXTENSIONS = ['mp3', 'flac', 'm4a', 'ogg', 'opus', 'wav', 'aac', 'aiff', 'wma']

export function isAudioFilePath(filename: string): boolean {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return false
  return AUDIO_EXTENSIONS.includes(filename.slice(dot + 1).toLowerCase())
}

function extractTitleFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".")
  const base = dot > 0 ? filename.slice(0, dot) : filename

  const bracketMatch = base.match(/^(.+?)\s+\[[^\]]*\]/)
  if (bracketMatch) return bracketMatch[1].trim()

  const stripLeading = base.replace(/^[\d\s._-]+/, "").trim()
  return stripLeading || base
}

export interface TrackMatchResult {
  entry: WebdavFileEntry | null
  /** True when several candidates tied for the best score — never guess. */
  ambiguous: boolean
}

interface ScoredEntry {
  entry: WebdavFileEntry
  /** Filename-vs-title score (0..110). */
  nameScore: number
  /** In-file tag identity score (0..), 0 when the file has no tags. */
  tagScore: number
  /** Best of both, plus the equal-size bonus. */
  score: number
  /** True when a confident tag match: exact title AND exact artist. */
  tagCertain: boolean
}

/** In-file identity scoring: title is the strong signal; artist/album/track
 *  corroborate; equal byte size adds a small bonus. `certain` = exact title
 *  AND exact artist (the only verdict the scanner auto-binds on). */
function scoreAgainstTags(
  track: Track,
  entry: WebdavFileEntry,
  navSize: number | undefined,
): { score: number; certain: boolean } {
  if (!entry.tags) return { score: 0, certain: false }
  const tags = entry.tags
  const fileTitle = normalizeForMatch(tags.title ?? '')
  if (!fileTitle) return { score: 0, certain: false }

  const navTitle = normalizeForMatch(track.title)
  const fileArtist = normalizeForMatch(tags?.artist ?? '')
  const navArtist = normalizeForMatch(track.artist)
  const fileAlbum = normalizeForMatch(tags?.album ?? '')
  const navAlbum = normalizeForMatch(track.album)

  let score = 0
  const titleExact = fileTitle === navTitle
  if (titleExact) {
    score = 100
  } else if (fileTitle.includes(navTitle) || navTitle.includes(fileTitle)) {
    score = 78 - Math.abs(fileTitle.length - navTitle.length)
  } else {
    return { score: 0, certain: false }
  }

  const artistExact = fileArtist !== '' && navArtist !== '' && fileArtist === navArtist
  if (artistExact) score += 25
  else if (fileArtist && navArtist && (fileArtist.includes(navArtist) || navArtist.includes(fileArtist))) score += 12

  if (fileAlbum && navAlbum && (fileAlbum === navAlbum || fileAlbum.includes(navAlbum) || navAlbum.includes(fileAlbum))) {
    score += fileAlbum === navAlbum ? 20 : 10
  }
  if (tags.trackNumber && track.trackNumber && tags.trackNumber === track.trackNumber) {
    score += 5
  }
  if (navSize && entry.size === navSize) {
    score += 5
  }

  return { score, certain: titleExact && artistExact }
}

/** The size-only fallback is suppressed when the file's PROBED tags
 *  contradict the track (a coincidental same-size file must not auto-bind). */
function tagsContradictSize(track: Track, entry: WebdavFileEntry): boolean {
  const fileTitle = entry.tags?.title
  if (!fileTitle) return false
  return normalizeForMatch(fileTitle) !== normalizeForMatch(track.title)
}

/** Re-verification verdict for an EXISTING binding judged against the file
 *  at that path: exact normalized title match = 'verified'; a definitively
 *  different title = 'conflict'; no/missing/unreadable tags = 'unknown'.
 *  This is the single comparison source for the Re-verify flows (bulk
 *  button + per-row "Update file link") — the only places existing bindings
 *  are re-judged after a server switch. 'conflict' is a strong hint, not
 *  proof (feat./live/alternate titles normalize differently), so callers
 *  must never auto-clear on it — only refuse to write. */
export function verifyEntryAgainstTrack(
  track: Track,
  entry: WebdavFileEntry,
): 'verified' | 'conflict' | 'unknown' {
  const fileTitle = entry.tags?.title
  const navTitle = track.title
  if (!fileTitle || !navTitle) return 'unknown'
  const f = normalizeForMatch(fileTitle)
  const n = normalizeForMatch(navTitle)
  if (!f || !n) return 'unknown'
  return f === n ? 'verified' : 'conflict'
}

/** Score every eligible entry of the index against the track (filename, size,
 *  and — when the entry carries probed tags — in-file identity). */
function scoreTrackMatches(
  track: Track,
  index: WebdavFileEntry[],
  excludePaths?: ReadonlySet<string>,
): ScoredEntry[] {
  const navTitle = normalizeForMatch(track.title)
  const navSize = track.size

  const scored: ScoredEntry[] = []

  for (const entry of index) {
    if (excludePaths?.has(entry.path)) continue
    if (!entry.filename.toLowerCase().endsWith(`.${track.fileType}`)) continue

    const cleanedFilename = normalizeForMatch(extractTitleFromFilename(entry.filename))

    let nameScore = 0
    if (cleanedFilename === navTitle) {
      nameScore = 100
    } else if (cleanedFilename.includes(navTitle)) {
      nameScore = 80 - Math.abs(cleanedFilename.length - navTitle.length)
    } else if (navTitle.includes(cleanedFilename)) {
      nameScore = 60 - Math.abs(cleanedFilename.length - navTitle.length)
    }

    // Size-only guess — suppressed when probed tags contradict the track.
    if (navSize && entry.size === navSize && nameScore === 0 && !tagsContradictSize(track, entry)) {
      nameScore = 40
    }

    const tag = scoreAgainstTags(track, entry, navSize)

    let score = Math.max(nameScore, tag.score)
    // A tag verdict that beats a weak filename/name guess is the trusted one
    // (the file "is" that song); ties stay ties.
    if (tag.score > 0 && tag.score > nameScore) {
      score = tag.score
    }
    // Historical size bonus on top of an equal-size filename match.
    if (nameScore > 0 && navSize && entry.size === navSize && score === nameScore) {
      score += 10
    }

    if (score > 0) scored.push({
      entry,
      nameScore,
      tagScore: tag.score,
      score,
      tagCertain: tag.certain,
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored
}

export function matchTrackToWebdav(
  track: Track,
  index: WebdavFileEntry[],
  excludePaths?: ReadonlySet<string>,
): TrackMatchResult {
  const scored = scoreTrackMatches(track, index, excludePaths)

  // Auto-binding requires filename or tag evidence: `nameScore === 40` is
  // exactly the byte-size heuristic, and a size coincidence is not proof a
  // file IS the song (same-encode albums historically auto-bound whole
  // albums to one wrong file). Size-only matches remain visible in the
  // File Matching picker as suggestions — never an automatic bind. The
  // `track.size` fallback that duplicated this path is gone.
  if (scored.length > 0 && scored[0].score >= 40
      && (scored[0].nameScore > 40 || scored[0].tagScore > 0)) {
    // A tag verdict that is not title+artist-certain must not auto-bind —
    // surface it as ambiguous so the user confirms (the picker shows tags).
    if (scored[0].tagScore > scored[0].nameScore && !scored[0].tagCertain) {
      return { entry: null, ambiguous: true }
    }
    // Two files with the same score (e.g. duplicate "01 - Intro.flac" in
    // different albums, same size) are indistinguishable — picking the first
    // index entry could rewrite the WRONG file's tags on Push.
    if (scored.length > 1 && scored[0].score === scored[1].score) {
      return { entry: null, ambiguous: true }
    }
    return { entry: scored[0].entry, ambiguous: false }
  }

  return { entry: null, ambiguous: false }
}

export interface MatchCandidates {
  status: 'matched' | 'ambiguous' | 'none'
  /** The top-score group — the tied entries when ambiguous, else the best near-miss. */
  promptCandidates: WebdavFileEntry[]
  /** Every matching-extension file, for the manual search picker. */
  allCandidates: WebdavFileEntry[]
}

/**
 * Candidate view for the File Matching UI: the same scoring as
 * `matchTrackToWebdav`, but exposes the tied/near-miss entries instead of
 * collapsing them to an unambiguous boolean.
 */
export function matchTrackToWebdavCandidates(
  track: Track,
  index: WebdavFileEntry[],
  excludePaths?: ReadonlySet<string>,
): MatchCandidates {
  const scored = scoreTrackMatches(track, index, excludePaths)
  const allCandidates = index.filter(
    (e) => e.filename.toLowerCase().endsWith(`.${track.fileType}`)
      && !excludePaths?.has(e.path),
  )

  // Same evidence gate as `matchTrackToWebdav`: a byte-size-only lead must
  // not classify as 'matched' (a size-only TIE would otherwise count
  // 'ambiguous' here while the scanner counts it 'no-match' — the count
  // line and scan result would disagree). Size-only entries still surface
  // as near-miss suggestions below.
  if (scored.length > 0 && scored[0].score >= 40
      && (scored[0].nameScore > 40 || scored[0].tagScore > 0)) {
    const top = scored[0].score
    const group = scored.filter((s) => s.score === top).map((s) => s.entry)
    // Mirrors `matchTrackToWebdav`: a tag verdict that beats the filename
    // guess without title+artist certainty must not auto-bind — classify it
    // ambiguous so listUnresolvedMatches' counts agree with the scanner's.
    const tagLedUncertain = scored[0].tagScore > scored[0].nameScore && !scored[0].tagCertain
    return {
      status: group.length > 1 || tagLedUncertain ? 'ambiguous' : 'matched',
      promptCandidates: group,
      allCandidates,
    }
  }

  // No confident match: surface the best near-misses so the user sees why
  // nothing scored and has a starting point (size-only hits included — the
  // probe-contradicted ones are already excluded from `scored`).
  if (scored.length > 0) {
    return {
      status: 'none',
      promptCandidates: scored.slice(0, 5).map((s) => s.entry),
      allCandidates,
    }
  }
  return { status: 'none', promptCandidates: [], allCandidates }
}

/**
 * Change-detector over the server file set (sorted `path|size` pairs, FNV-1a).
 * The scanner gates its unmatched-track retry on this: a previously unmatched
 * row can only become matchable when a file is added, renamed, or its size
 * changes (a tag rewrite changes size too) — none of which can happen while
 * the set is unchanged. mtimes are deliberately excluded: a pure tag edit
 * cannot create a new match, and matched rows are already re-read on their own
 * mtime diff.
 */
export function computeIndexFingerprint(index: WebdavFileEntry[]): string {
  const parts = index.map((e) => `${e.path}\u0000${e.size}`)
  parts.sort()
  let hash = 0x811c9dc5
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      hash ^= p.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  return hash.toString(36)
}

/**
 * Slims the in-memory (tagged) index down to the fields the PERSISTED snapshot
 * actually needs (TODO 3.6a). The content-probe `tags` live in their own
 * `webdavFileTags` cache and bloat every persisted index row; the fingerprint
 * diff hashes only `path`+`size`, and the debug fallback reads path/filename/
 * size. Drops `tags` so the snapshot stays small — but the index is still
 * persisted (the prior-fingerprint diff depends on it).
 */
export function slimIndexForPersistence(index: WebdavFileEntry[]): WebdavFileEntry[] {
  return index.map((e) => ({
    path: e.path,
    filename: e.filename,
    size: e.size,
    lastModified: e.lastModified,
  }))
}

/** Build a Map<webdavPath, lastModified> from the index for fast lookup. */
export function buildPathTimestamps(index: WebdavFileEntry[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const e of index) {
    if (e.lastModified) map.set(e.path, e.lastModified)
  }
  return map
}

/**
 * Normalizes an mtime string to epoch milliseconds, or `undefined` when
 * absent or unparseable (Date.parse failures — non-standard formats fall
 * back to the raw-string comparison in `mtimeChanged`, never a guess).
 */
export function parseMtimeToEpoch(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const t = Date.parse(value)
  return Number.isNaN(t) ? undefined : t
}

/**
 * The single mtime comparison point for scan diffs (TODO 3.6t/3.7b): a row is
 * "changed" when the current index stamp differs from the cached one. Both
 * sides are normalized to epoch FIRST — format variance after a server switch
 * (RFC1123 `Mon, 01 Jan 2024 00:00:00 GMT` vs ISO `2024-01-01T00:00:00Z` for
 * the same instant) must not mass-flag unchanged files. When either side is
 * absent or unparseable there is no epoch to compare, so the diff falls back
 * to raw-string inequality: a server that omits `getlastmodified` leaves
 * `current` undefined, which never equals a cached stamp, so such rows
 * re-read on every scan (safe direction — false "changed" costs a re-read,
 * never a skipped one).
 */
export function mtimeChanged(
  cached: string | undefined,
  current: string | undefined,
): boolean {
  const c = parseMtimeToEpoch(cached)
  const n = parseMtimeToEpoch(current)
  if (c !== undefined && n !== undefined) {
    return c !== n
  }
  return current !== cached
}

/**
 * Webdav-mode comment import (TODO 3.7a): the file is authoritative, but a
 * file that LACKS the comment tag entirely must not wipe a cached value —
 * the tag is absent, not empty, so the file says nothing about comments.
 * `extractMetadataFromBuffer` maps an empty comment to `undefined`, so on the
 * real paths "file has a comment" is `fileComments !== undefined`; the
 * `||` also defends the boundary against a stray empty string — an empty
 * comment can never erase a real cached one.
 */
export function mergeFileComments(
  cached: string | undefined,
  fileComments: string | undefined,
): string | undefined {
  return fileComments || cached
}

/**
 * Given the current PROPFIND index and cached metadata, return the set of
 * tracks whose file has been modified (or that need matching for the first time).
 */
export function findChangedTracks(
  tracks: Track[],
  metadata: Map<string, LocalMetadataStore>,
  pathTimestamps: Map<string, string>,
): { changed: Track[]; unmatched: Track[] } {
  const changed: Track[] = []
  const unmatched: Track[] = []

  for (const t of tracks) {
    const meta = metadata.get(t.trackId)
    if (meta?.webdavPath) {
      const cached = meta.webdavLastModified
      const current = pathTimestamps.get(meta.webdavPath)
      if (mtimeChanged(cached, current)) {
        changed.push(t)
      }
    } else {
      unmatched.push(t)
    }
  }

  return { changed, unmatched }
}
