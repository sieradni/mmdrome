import { normalizeForMatch } from "./matchNormalize"
import type { Track } from "../stores/appState"
import type { WebdavFileEntry, LocalMetadataStore, FileTagCacheEntry } from "./db"

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
  /** True when a confident tag match: exact title AND exact artist AND no
   *  duration conflict (6.4). */
  tagCertain: boolean
  /** Exact normalized-title tag match — the primary identity signal (6.5a). */
  tagTitleExact: boolean
  /** Both sides carry a duration and they differ beyond ±2 s (6.4 demotion). */
  tagDurationConflict: boolean
}

interface TagScore {
  score: number
  /** Exact title AND exact artist AND no duration conflict — the strongest
   *  verdict (the one the scanner auto-binds on). */
  certain: boolean
  /** Exact normalized-title match (the primary identity signal, 6.5a). */
  titleExact: boolean
  /** Both sides carry a duration and they differ beyond ±2 s (6.4). */
  durationConflict: boolean
}

/** In-file identity scoring: title is the strong signal; artist/album/track
 *  corroborate; equal byte size, year, and duration add corroboration. Year
 *  is corroboration only (a mismatch never demotes — reissues); duration
 *  beyond ±2 s DEMOTES certainty (a different-length file is a different
 *  version), while an absent/null duration on either side is no signal. */
function scoreAgainstTags(
  track: Track,
  entry: WebdavFileEntry,
  navSize: number | undefined,
): TagScore {
  if (!entry.tags) return { score: 0, certain: false, titleExact: false, durationConflict: false }
  const tags = entry.tags
  const fileTitle = normalizeForMatch(tags.title ?? '')
  if (!fileTitle) return { score: 0, certain: false, titleExact: false, durationConflict: false }

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
    return { score: 0, certain: false, titleExact: false, durationConflict: false }
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

  // Year corroboration (6.4): +5 when both sides agree within ±1 (reissues).
  // Absent on either side = no signal; a larger mismatch never demotes — the
  // title/artist are the identity, the year is only a tiebreaker.
  if (tags.year !== undefined && track.year !== undefined && Math.abs(tags.year - track.year) <= 1) {
    score += 5
  }

  // Duration corroboration (6.4): +10 within ±2 s. Absent/null on either side
  // (0, `getAudioProperties()` null for short/unparseable buffers) = no signal.
  // A genuine mismatch beyond ±2 s DEMOTES certainty — never a hard block.
  const fileDuration = tags.duration
  const navDuration = track.duration
  let durationConflict = false
  if (fileDuration !== undefined && fileDuration > 0 && navDuration > 0) {
    if (Math.abs(fileDuration - navDuration) <= 2) {
      score += 10
    } else {
      durationConflict = true
    }
  }

  return { score, certain: titleExact && artistExact && !durationConflict, titleExact, durationConflict }
}

/** A file's probed identity tags CONTRADICT a track when the file has a
 *  non-empty title that is not an exact (normalized) match for the track's
 *  title. Contradicting tags suppress BOTH the filename evidence and the
 *  byte-size fallback (6.0a/6.5b) — in-file identity outranks a filename. A
 *  file with NO identity title is not a contradiction (it still binds on
 *  filename/size). */
function tagsContradictTrack(track: Track, entry: WebdavFileEntry): boolean {
  const fileTitle = normalizeForMatch(entry.tags?.title ?? '')
  // Whitespace/punctuation-only title values carry no identity signal; treat
  // them like an absent title rather than suppressing a valid filename/size
  // fallback.
  if (!fileTitle) return false
  return fileTitle !== normalizeForMatch(track.title)
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
    // 6.5b: probed identity tags that contradict the track suppress ALL
    // filename/size evidence — the file's own tags outrank its name.
    const contradicts = tagsContradictTrack(track, entry)

    let nameScore = 0
    if (!contradicts) {
      if (cleanedFilename === navTitle) {
        nameScore = 100
      } else if (cleanedFilename.includes(navTitle)) {
        nameScore = 80 - Math.abs(cleanedFilename.length - navTitle.length)
      } else if (navTitle.includes(cleanedFilename)) {
        nameScore = 60 - Math.abs(cleanedFilename.length - navTitle.length)
      }

      // Size-only guess — weak, never binds alone (D8), suppressed when the
      // probed tags contradict the track.
      if (navSize && entry.size === navSize && nameScore === 0) {
        nameScore = 40
      }
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
      tagTitleExact: tag.titleExact,
      tagDurationConflict: tag.durationConflict,
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored
}

/** The single track→file verdict both views share: whether a scored lead
 *  auto-binds, stays ambiguous (user confirms), or has no evidence. */
type TrackMatchVerdict = 'bind' | 'ambiguous' | 'none'

function classifyScoredTrackMatch(scored: ScoredEntry[]): TrackMatchVerdict {
  if (scored.length === 0) return 'none'
  const top = scored[0]

  // Evidence gate (D8): auto-binding requires filename or tag evidence —
  // `nameScore === 40` is exactly the byte-size heuristic, and a size
  // coincidence is not proof a file IS the song (same-encode albums
  // historically auto-bound whole albums to one wrong file). Size-only
  // matches remain visible in the picker as suggestions — never an automatic
  // bind.
  if (top.score < 40 || (top.nameScore <= 40 && top.tagScore === 0)) return 'none'

  // A duration conflict attached to an exact title is explicit contradictory
  // evidence even when the filename and tag scores tie (the common case for a
  // title-only tag). Do this before the tag-vs-filename hierarchy so the
  // unique-title relaxation cannot bypass the duration safety rule.
  if (top.tagTitleExact && top.tagDurationConflict) return 'ambiguous'

  if (top.tagScore > top.nameScore) {
    // A substring tag match (not an exact title) is never certain enough.
    if (!top.tagTitleExact) return 'ambiguous'
    // 6.5a: an exact-title tag match without artist agreement binds only when
    // UNIQUE — artist is the tiebreaker across same-title files.
    if (!top.tagCertain && scored.slice(1).some((s) => s.tagTitleExact)) {
      return 'ambiguous'
    }
  }

  // Two files with the same top score (e.g. duplicate "01 - Intro.flac" in
  // different albums, same size) are indistinguishable — picking the first
  // index entry could rewrite the WRONG file's tags on Push.
  if (scored.length > 1 && top.score === scored[1].score) return 'ambiguous'
  return 'bind'
}

export function matchTrackToWebdav(
  track: Track,
  index: WebdavFileEntry[],
  excludePaths?: ReadonlySet<string>,
): TrackMatchResult {
  const scored = scoreTrackMatches(track, index, excludePaths)
  const verdict = classifyScoredTrackMatch(scored)
  if (verdict === 'bind') return { entry: scored[0].entry, ambiguous: false }
  return { entry: null, ambiguous: verdict === 'ambiguous' }
}

export interface MatchCandidates {
  status: 'matched' | 'ambiguous' | 'none'
  /** The top-score group — the tied entries when ambiguous, else the best near-miss. */
  promptCandidates: WebdavFileEntry[]
  /** Every matching-extension file, for the manual search picker. */
  allCandidates: WebdavFileEntry[]
  /** Why no confident match happened, for the File Matching row label. Null
   *  when the track matched. Pure derivation — every value is readable from
   *  the index + probed tags, so the UI never guesses. */
  reason: NoMatchReason | null
}

export type NoMatchReason =
  /** No file of this track's type exists in the index at all. */
  | 'no-file-on-server'
  /** Every same-type file's probed tags name a different song (6.5b suppression). */
  | 'tags-contradict'
  /** A size/filename candidate exists but its tags were never read (or the read failed). */
  | 'not-probed'
  /** The file was probed but carries no title identity to match on. */
  | 'no-identity-tags'
  /** The file's tag duration differs beyond ±2 s — a different version (6.4). */
  | 'duration-conflict'
  /** Evidence exists but is below the auto-bind confidence gate (D8). */
  | 'weak-evidence'
  /** Several files score equally, or a near-title tag match — the user confirms. */
  | 'ambiguous'

/** Why a track with no confident match missed, derived from the same scored
 *  evidence the verdict used. `allCandidates` is the same-type file set (the
 *  probe-contradicted files are absent from `scored` — they scored 0). */
function deriveNoMatchReason(scored: ScoredEntry[], allCandidates: WebdavFileEntry[]): NoMatchReason {
  if (scored.length === 0) {
    if (allCandidates.length === 0) return 'no-file-on-server'
    // Every same-type file scored 0 — either its probed tags contradicted the
    // track (6.5b suppression) or it is untagged with no size/filename hint.
    const anyIdentity = allCandidates.some((e) => !!normalizeForMatch(e.tags?.title ?? ''))
    return anyIdentity ? 'tags-contradict' : 'not-probed'
  }
  const top = scored[0]
  if (top.tagDurationConflict) return 'duration-conflict'
  if (top.tagScore === 0) {
    // The best lead scored only on filename/size — its tags are missing
    // (never probed / read failed) or empty (no identity to match on).
    return top.entry.tags ? 'no-identity-tags' : 'not-probed'
  }
  return 'weak-evidence'
}

/**
 * Candidate view for the File Matching UI: the same scoring as
 * `matchTrackToWebdav`, but exposes the tied/near-miss entries instead of
 * collapsing them to an unambiguous boolean, plus the reason no confident
 * match was reached.
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

  const verdict = classifyScoredTrackMatch(scored)
  if (verdict === 'none') {
    // No confident match: surface the best near-misses so the user sees why
    // nothing scored and has a starting point (size-only hits included — the
    // probe-contradicted ones are already excluded from `scored`).
    const reason = deriveNoMatchReason(scored, allCandidates)
    if (scored.length > 0) {
      return {
        status: 'none',
        promptCandidates: scored.slice(0, 5).map((s) => s.entry),
        allCandidates,
        reason,
      }
    }
    return { status: 'none', promptCandidates: [], allCandidates, reason }
  }

  const top = scored[0].score
  const group = scored.filter((s) => s.score === top).map((s) => s.entry)
  const reason: NoMatchReason | null = verdict === 'ambiguous'
    ? (scored[0].tagDurationConflict ? 'duration-conflict' : 'ambiguous')
    : null
  return {
    status: verdict === 'ambiguous' ? 'ambiguous' : 'matched',
    promptCandidates: group,
    allCandidates,
    reason,
  }
}

/** Navidrome's placeholder for a missing title (`navidromeSongToTrack` maps
 *  `song.title || 'Unknown Title'`). A track with no real title must never
 *  become a reverse-match candidate — the index is keyed by normalized title,
 *  and an empty/degenerate key could only bind untagged files to placeholder
 *  tracks. */
const UNKNOWN_TITLE = normalizeForMatch('Unknown Title')

/** normalizedTitle → tracks sharing that exact title. Empty and sentinel
 *  titles are excluded: they can only produce false reverse-matches. */
export interface TrackTitleIndex {
  byTitle: Map<string, Track[]>
}

export function buildTrackTitleIndex(tracks: Track[]): TrackTitleIndex {
  const byTitle = new Map<string, Track[]>()
  for (const t of tracks) {
    const title = normalizeForMatch(t.title)
    if (!title || title === UNKNOWN_TITLE) continue
    let list = byTitle.get(title)
    if (!list) {
      list = []
      byTitle.set(title, list)
    }
    list.push(t)
  }
  return { byTitle }
}

export interface FileTrackMatch {
  verdict: 'certain' | 'unique-title' | 'ambiguous' | 'none'
  trackId: string | null
}

/** Reverse matching (file → track) for probe-time auto-binding: given a probed
 *  file's identity tags, find the track(s) it matches. Only EXACT-title
 *  candidates are considered (near-title matches never auto-bind — they are
 *  the 'ambiguous' surface the user confirms); `excludeTrackIds` drops tracks
 *  already bound elsewhere, mirroring the scan's track→file first-claims
 *  direction. Verdicts: 'certain' (exact title AND artist AND no duration
 *  conflict, one track), 'unique-title' (exact title, one candidate — the
 *  6.5a relaxation for artist-less tags, demoted by a 6.4 duration conflict),
 *  'ambiguous' (shared title, never guessed), 'none' (no candidate). */
export function matchFileToTracks(
  entry: WebdavFileEntry,
  index: TrackTitleIndex,
  excludeTrackIds?: ReadonlySet<string>,
): FileTrackMatch {
  const fileTitle = entry.tags ? normalizeForMatch(entry.tags.title ?? '') : ''
  if (!fileTitle) return { verdict: 'none', trackId: null }

  const candidates = (index.byTitle.get(fileTitle) ?? []).filter(
    (t) => !excludeTrackIds?.has(t.trackId)
      && entry.filename.toLowerCase().endsWith(`.${t.fileType}`),
  )
  if (candidates.length === 0) return { verdict: 'none', trackId: null }

  const certain = candidates.filter((t) => scoreAgainstTags(t, entry, t.size).certain)
  if (certain.length === 1) return { verdict: 'certain', trackId: certain[0].trackId }
  if (certain.length > 1) return { verdict: 'ambiguous', trackId: null }

  if (candidates.length === 1) {
    // 6.4: the duration demotion also gates the unique-title relaxation — a
    // different-length file is a different version even when its title is
    // unique.
    const scored = scoreAgainstTags(candidates[0], entry, candidates[0].size)
    if (scored.durationConflict) return { verdict: 'ambiguous', trackId: null }
    return { verdict: 'unique-title', trackId: candidates[0].trackId }
  }
  return { verdict: 'ambiguous', trackId: null }
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
 * Change-detector over the PROBED tag cache (the second evidence channel):
 * FNV-1a over sorted `path|size|mtime|status|probedAt` pairs. `probedAt`
 * flips exactly when the probe writes a new result, while `mtime` makes a
 * same-size tag edit visible to the next freshness check. Tag CONTENT is
 * deliberately not hashed: these fields are change markers, and a rewritten
 * probedAt with identical tags is still new evidence.
 */
export function computeTagCacheFingerprint(entries: FileTagCacheEntry[]): string {
  const parts = entries.map((e) => `${e.path}\u0000${e.size}\u0000${e.lastModified ?? ''}\u0000${e.status}\u0000${e.probedAt}`)
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

/** Cache freshness policy for the tag probe (6.6). Successful and empty
 * results remain valid until the file size or WebDAV mtime changes. Parse
 * failures are retried after a long TTL; network failures use a short TTL so
 * an offline/online transition cannot poison a file for the rest of the session. */
export const TAG_NETWORK_ERROR_TTL_MS = 5 * 60 * 1000
export const TAG_UNREADABLE_TTL_MS = 6 * 60 * 60 * 1000
export const PROBE_SWEEP_MIN_FILES = 50

export type ProbeSweepMode = 'sweep-all' | 'hint-gated'

/** Decide whether the WebDAV server is probably the user's library. Bound
 * files leave the unclaimed pool, so a roughly 1:1 unclaimed-file/track ratio
 * is the safe point at which probing every remaining audio file is cheaper and
 * more complete than relying on filenames or byte-size hints. */
export function planProbeSweep(
  unclaimedFiles: number,
  unclaimedTracks: number,
): ProbeSweepMode {
  if (unclaimedFiles <= Math.max(unclaimedTracks, PROBE_SWEEP_MIN_FILES)) return 'sweep-all'
  return 'hint-gated'
}

export function tagCacheEntryIsFresh(
  entry: FileTagCacheEntry,
  currentSize: number,
  currentLastModified?: string,
  now = Date.now(),
): boolean {
  if (entry.size !== currentSize || mtimeChanged(entry.lastModified, currentLastModified)) return false
  if (entry.status === 'ok' || entry.status === 'empty') return true
  const age = Math.max(0, now - entry.probedAt)
  if (entry.status === 'network-error') return age < TAG_NETWORK_ERROR_TTL_MS
  return age < TAG_UNREADABLE_TTL_MS
}

/**
 * Remove cache rows for paths that disappeared from a COMPLETE server index.
 * A partial crawl must retain them: an unreadable directory may still contain
 * the file, and deleting its evidence would make a later recovery look like a
 * brand-new server. The returned arrays are new and the input is untouched.
 */
export function pruneTagCacheEntries(
  entries: FileTagCacheEntry[],
  activePaths: ReadonlySet<string>,
  indexComplete: boolean,
): { kept: FileTagCacheEntry[]; removed: FileTagCacheEntry[] } {
  if (!indexComplete) return { kept: [...entries], removed: [] }
  const kept: FileTagCacheEntry[] = []
  const removed: FileTagCacheEntry[] = []
  for (const entry of entries) {
    if (activePaths.has(entry.path)) kept.push(entry)
    else removed.push(entry)
  }
  return { kept, removed }
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

/** Reason an automatic bind (scan auto-match or probe-time reverse-match) was
 *  refused. The eligibility rules are the shared subset of `processItem`'s
 *  guards: never rebind a row that already owns a file, never override a
 *  manual verdict, and never touch a row awaiting push or dismissed. */
export type AutoBindDecision =
  | { bindable: true }
  | { bindable: false; reason: 'track-missing' | 'already-bound' | 'manual' | 'pending-sync' | 'ignored' }

export function canAutoBind(
  track: Track | undefined,
  existing: LocalMetadataStore | undefined,
): AutoBindDecision {
  if (!track) return { bindable: false, reason: 'track-missing' }
  if (existing?.webdavPath != null) return { bindable: false, reason: 'already-bound' }
  if (existing?.matchSource === 'manual') return { bindable: false, reason: 'manual' }
  if (existing?.syncStatus === 'pending_sync') return { bindable: false, reason: 'pending-sync' }
  if (existing?.ignored) return { bindable: false, reason: 'ignored' }
  return { bindable: true }
}
