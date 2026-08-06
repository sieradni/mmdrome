import { webdavFetch, authHeaders, buildWebdavUrl, normalizeUrl } from "./webdavUtils"
import { getTagLib } from "./taglibSingleton"
import { popmToLocalRating } from "./tagWriter"
import type { Track } from "../stores/appState"
import type { WebdavFileEntry, LocalMetadataStore } from "./db"

const METADATA_FETCH_TIMEOUT = 30000

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
  }, METADATA_FETCH_TIMEOUT)
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

export function matchTrackToWebdav(
  track: Track,
  index: WebdavFileEntry[],
): WebdavFileEntry | null {
  const navTitle = normalizeForMatch(track.title)
  const navSize = track.size

  const scored: { entry: WebdavFileEntry; score: number }[] = []

  for (const entry of index) {
    if (entry.filename.toLowerCase().endsWith(`.${track.fileType}`)) {
      const cleanedFilename = normalizeForMatch(extractTitleFromFilename(entry.filename))

      let score = 0
      if (cleanedFilename === navTitle) {
        score = 100
      } else if (cleanedFilename.includes(navTitle)) {
        score = 80 - Math.abs(cleanedFilename.length - navTitle.length)
      } else if (navTitle.includes(cleanedFilename)) {
        score = 60 - Math.abs(cleanedFilename.length - navTitle.length)
      }

      if (navSize && entry.size === navSize && score > 0) {
        score += 10
      }
      if (navSize && entry.size === navSize && score === 0) {
        score = 40
      }

      if (score > 0) scored.push({ entry, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)

  if (scored.length > 0 && scored[0].score >= 40) {
    return scored[0].entry
  }

  if (navSize) {
    const sizeMatch = index.find(
      (e) => e.size === navSize && e.filename.toLowerCase().endsWith(`.${track.fileType}`),
    )
    if (sizeMatch) return sizeMatch
  }

  return null
}

function getMetadataChunkSize(fileType: string): number {
  switch (fileType) {
    case "mp3":
    case "flac":
    case "ogg":
    case "opus":
    case "m4a":
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
}

export async function extractMetadataFromBuffer(
  buffer: ArrayBuffer,
  _fileType: string,
): Promise<FileMetadata> {
  let rating = 0
  let loved = false
  let comments = ''
  let taglibOpened = false

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

    file.dispose()
  } catch (e) {
    if (!taglibOpened) throw e
  }

  return { rating, loved, comments: comments || undefined }
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
  if (!match) return { rating: 0, loved: false }

  const meta = await readFileMetadata(baseUrl, match.path, user, token, track.fileType)
  return { ...meta, webdavPath: match.path }
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
