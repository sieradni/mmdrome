import { webdavFetch, authHeaders, buildWebdavUrl, normalizeUrl } from "./webdavUtils"
import { getTagLib } from "./taglibSingleton"
import { popmToLocalRating } from "./tagWriter"
import type { Track } from "../stores/appState"
import type { WebdavFileEntry, LocalMetadataStore } from "./db"

const METADATA_FETCH_TIMEOUT = 30000
const INDEX_PROPFIND_TIMEOUT = 90000

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "text/xml")
}

const DAV_NS = "DAV:"

function getChildText(parent: Element, tag: string, ns: string): string {
  const el = parent.getElementsByTagNameNS(ns, tag)[0]
  return el?.textContent ?? ""
}

function stripBasePath(baseUrl: string, href: string): string {
  const decoded = decodeURIComponent(href)
  try {
    const urlPath = new URL(normalizeUrl(baseUrl)).pathname.replace(/\/+$/, "")
    if (urlPath && decoded.toLowerCase().startsWith(urlPath.toLowerCase())) {
      return decoded.slice(urlPath.length).replace(/^\/+/, "")
    }
  } catch {}
  const urlStr = normalizeUrl(baseUrl)
  const escaped = urlStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return decoded.replace(new RegExp(`^${escaped}/?`, "i"), "")
}

export async function buildWebdavFileIndex(
  baseUrl: string,
  user: string,
  token: string,
): Promise<WebdavFileEntry[]> {
  const url = buildWebdavUrl(baseUrl, "/")
  const res = await webdavFetch(url, {
    method: "PROPFIND",
    headers: {
      ...authHeaders(user, token),
      Depth: "infinity",
    },
  }, INDEX_PROPFIND_TIMEOUT)
  if (!res.ok) throw new Error(`PROPFIND / failed: ${res.status}`)
  const xml = await res.text()
  const doc = parseXml(xml)
  const responses = doc.getElementsByTagNameNS(DAV_NS, "response")

  const entries: WebdavFileEntry[] = []
  for (const resp of responses) {
    const href = getChildText(resp, "href", DAV_NS)
    const cleaned = stripBasePath(baseUrl, href)
    if (!cleaned) continue

    const props = resp.getElementsByTagNameNS(DAV_NS, "prop")[0]
    if (!props) continue

    const isCollection = props.getElementsByTagNameNS(DAV_NS, "collection")[0]
    if (isCollection) continue

    const filename = cleaned.split("/").pop() || cleaned
    const sizeStr = props.getElementsByTagNameNS(DAV_NS, "getcontentlength")[0]?.textContent
    const modStr = props.getElementsByTagNameNS(DAV_NS, "getlastmodified")[0]?.textContent
    entries.push({
      path: cleaned,
      filename,
      size: sizeStr ? parseInt(sizeStr, 10) || 0 : 0,
      lastModified: modStr || undefined,
    })
  }

  return entries
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
 * Given the current PROPFIND index and cached metadata, return the set of
 * tracks whose file has been modified (or that need matching for the first time).
 */
export function findChangedTracks(
  tracks: Track[],
  metadata: Map<string, LocalMetadataStore>,
  newIndex: WebdavFileEntry[],
  pathTimestamps: Map<string, string>,
): { changed: Track[]; unmatched: Track[] } {
  const changed: Track[] = []
  const unmatched: Track[] = []

  for (const t of tracks) {
    const meta = metadata.get(t.trackId)
    if (meta?.webdavPath) {
      const cached = meta.webdavLastModified
      const current = pathTimestamps.get(meta.webdavPath)
      if (current !== cached) {
        changed.push(t)
      }
    } else {
      unmatched.push(t)
    }
  }

  return { changed, unmatched }
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim()
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

/** Known audio extensions the probe/scorer touches (mirrors Track['fileType']). */
const AUDIO_EXTENSIONS = ['mp3', 'flac', 'm4a', 'ogg', 'opus', 'wav', 'aac', 'aiff', 'wma']

export function isAudioFilePath(filename: string): boolean {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return false
  return AUDIO_EXTENSIONS.includes(filename.slice(dot + 1).toLowerCase())
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

  if (scored.length > 0 && scored[0].score >= 40) {
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

  if (track.size) {
    const sizeMatches = index.filter(
      (e) => e.size === track.size
        && e.filename.toLowerCase().endsWith(`.${track.fileType}`)
        && !excludePaths?.has(e.path)
        && !tagsContradictSize(track, e),
    )
    if (sizeMatches.length === 1) return { entry: sizeMatches[0], ambiguous: false }
    if (sizeMatches.length > 1) return { entry: null, ambiguous: true }
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

  if (scored.length > 0 && scored[0].score >= 40) {
    const top = scored[0].score
    const group = scored.filter((s) => s.score === top).map((s) => s.entry)
    return {
      status: group.length > 1 ? 'ambiguous' : 'matched',
      promptCandidates: group,
      allCandidates,
    }
  }

  // No confident match: surface the best near-misses (or a unique size hit)
  // so the user sees why nothing scored and has a starting point.
  if (scored.length > 0) {
    return {
      status: 'none',
      promptCandidates: scored.slice(0, 5).map((s) => s.entry),
      allCandidates,
    }
  }
  if (track.size) {
    const sizeOnly = allCandidates.filter((e) => e.size === track.size)
    if (sizeOnly.length > 0) {
      return { status: 'none', promptCandidates: sizeOnly.slice(0, 5), allCandidates }
    }
  }
  return { status: 'none', promptCandidates: [], allCandidates }
}

function getMetadataChunkSize(fileType: string): number {
  switch (fileType) {
    case "mp3":
    case "flac":
    case "ogg":
    case "opus":
    case "m4a":
    case "wav":
    case "aac":
    case "aiff":
    case "wma":
      return 262144
    default:
      return 65536
  }
}

export async function readMetadataChunk(
  baseUrl: string,
  filePath: string,
  user: string,
  token: string,
  fileType: string,
  chunkSize?: number,
): Promise<ArrayBuffer> {
  const url = buildWebdavUrl(baseUrl, filePath)
  const size = chunkSize ?? getMetadataChunkSize(fileType)
  const res = await webdavFetch(url, {
    method: "GET",
    headers: {
      ...authHeaders(user, token),
      Range: `bytes=0-${size - 1}`,
    },
  }, METADATA_FETCH_TIMEOUT)
  if (!res.ok) {
    if (res.status === 416) {
      const fullRes = await webdavFetch(url, { headers: authHeaders(user, token) }, METADATA_FETCH_TIMEOUT)
      if (!fullRes.ok) throw new Error(`GET ${filePath} failed: ${fullRes.status}`)
      return fullRes.arrayBuffer()
    }
    throw new Error(`Range GET ${filePath} failed: ${res.status}`)
  }
  return res.arrayBuffer()
}

export interface FileMetadata {
  rating: number
  loved: boolean
  comments?: string
  /** Identity tags, read from the same taglib pass (used for tag matching). */
  title?: string
  artist?: string
  album?: string
  trackNumber?: number
}

function firstPropValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0]?.toString().trim()
  if (typeof value === 'string') return value.trim()
  return undefined
}

function parseTrackNumber(value: unknown): number | undefined {
  const raw = firstPropValue(value)
  if (!raw) return undefined
  const num = parseInt(raw.split('/')[0], 10)
  return isNaN(num) ? undefined : num
}

export async function extractMetadataFromBuffer(
  buffer: ArrayBuffer,
  _fileType: string,
): Promise<FileMetadata> {
  let rating = 0
  let loved = false
  let comments = ''
  let taglibOpened = false
  let title: string | undefined
  let artist: string | undefined
  let album: string | undefined
  let trackNumber: number | undefined

  try {
    const taglib = await getTagLib()
    const file = await taglib.open(new Uint8Array(buffer))
    taglibOpened = true

    const r = file.getRating()
    if (r !== undefined && r !== null && r > 0) {
      rating = popmToLocalRating(Math.round(r * 255))
    }

    const props = file.properties()
    // MusicBee writes the loved flag as either "LOVERATING" (M4A/iTunes-style
    // atom) or "LOVE RATING" (ID3/TXXX). Check both, normalizing whitespace.
    const loveKey = Object.keys(props).find(
      (k) => k.replace(/\s+/g, '').toUpperCase() === 'LOVERATING'
    )
    const loveRating = loveKey ? props[loveKey] : undefined
    if (Array.isArray(loveRating) && loveRating[0] === 'L') {
      loved = true
    }

    const rawRating = props['RATING']
    if (Array.isArray(rawRating) && rating === 0) {
      const parsed = parseInt(rawRating[0], 10)
      if (!isNaN(parsed) && parsed > 0) rating = Math.min(100, parsed)
    }

    const rawComments = props['COMMENTS']
    if (Array.isArray(rawComments) && rawComments[0]) {
      comments = rawComments[0]
    }

    const rawComment = props['COMMENT']
    if (!comments && Array.isArray(rawComment) && rawComment[0]) {
      comments = rawComment[0]
    }
    title = firstPropValue(props['TITLE'])
    artist = firstPropValue(props['ARTIST'])
    album = firstPropValue(props['ALBUM'])
    trackNumber = parseTrackNumber(props['TRACKNUMBER'])

    file.dispose()
  } catch (e) {
    if (!taglibOpened) throw e
  }

  return { rating, loved, comments: comments || undefined, title, artist, album, trackNumber }
}

export async function readFileMetadata(
  baseUrl: string,
  filePath: string,
  user: string,
  token: string,
  fileType: string,
): Promise<FileMetadata> {
  const maxChunkSize = 8388608
  let chunkSize = getMetadataChunkSize(fileType)

  while (true) {
    const buffer = await readMetadataChunk(baseUrl, filePath, user, token, fileType, chunkSize)
    const gotFullFile = buffer.byteLength < chunkSize
    try {
      return await extractMetadataFromBuffer(buffer, fileType)
    } catch (err) {
      if (chunkSize >= maxChunkSize || gotFullFile) throw err
      chunkSize *= 2
    }
  }
}

export async function readFileMetadataWithIndex(
  track: Track,
  baseUrl: string,
  user: string,
  token: string,
  index: WebdavFileEntry[],
): Promise<FileMetadata & { webdavPath?: string }> {
  const match = matchTrackToWebdav(track, index)
  if (!match.entry || match.ambiguous) return { rating: 0, loved: false }

  const meta = await readFileMetadata(baseUrl, match.entry.path, user, token, track.fileType)
  return { ...meta, webdavPath: match.entry.path }
}

export async function extractRawTagProperties(buffer: ArrayBuffer): Promise<Record<string, unknown>> {
  const taglib = await getTagLib()
  const file = await taglib.open(new Uint8Array(buffer))

  const props = file.properties()
  const result: Record<string, unknown> = {
    getRating: file.getRating(),
    properties: { ...props },
  }

  file.dispose()
  return result
}
