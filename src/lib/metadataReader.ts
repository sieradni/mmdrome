import { readTags } from "taglib-wasm/simple"
import type { Track } from "../stores/appState"
import type { WebdavFileEntry, LocalMetadataStore } from "./db"

function authHeaders(user: string, token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`${user}:${token}`)}` }
}

function normalizeUrl(base: string): string {
  return base.replace(/\/+$/, "")
}

function buildWebdavUrl(base: string, path: string): string {
  return `${normalizeUrl(base)}/${path.replace(/^\/+/, "")}`
}

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
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: {
      ...authHeaders(user, token),
      Depth: "infinity",
    },
  })
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
      return 262144
    case "flac":
    case "ogg":
    case "opus":
      return 65536
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
): Promise<ArrayBuffer> {
  const url = buildWebdavUrl(baseUrl, filePath)
  const chunkSize = getMetadataChunkSize(fileType)
  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...authHeaders(user, token),
      Range: `bytes=0-${chunkSize - 1}`,
    },
  })
  if (!res.ok) {
    if (res.status === 416) {
      const fullRes = await fetch(url, { headers: authHeaders(user, token) })
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
}

export async function extractMetadataFromBuffer(
  buffer: ArrayBuffer,
  fileType: string,
): Promise<FileMetadata> {
  let rating = 0
  let loved = false

  try {
    const tags = await readTags(buffer)

    if (tags.ratings && tags.ratings.length > 0) {
      const r = tags.ratings[0]
      rating = Math.round((r.rating ?? 0) * 100)
    }

    const props = tags as Record<string, unknown>
    const loveRating = props["LOVE RATING"]
    if (Array.isArray(loveRating) && loveRating[0] === "L") {
      loved = true
    }

    const rawRating = props["RATING"]
    if (Array.isArray(rawRating) && rating === 0) {
      const parsed = parseInt(rawRating[0], 10)
      if (!isNaN(parsed) && parsed > 0) rating = Math.min(100, parsed)
    }
  } catch {
    // file too small or corrupt — rating stays 0
  }

  return { rating, loved }
}

export async function readFileMetadata(
  baseUrl: string,
  filePath: string,
  user: string,
  token: string,
  fileType: string,
): Promise<FileMetadata> {
  const buffer = await readMetadataChunk(baseUrl, filePath, user, token, fileType)
  return extractMetadataFromBuffer(buffer, fileType)
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
