import { webdavFetch, authHeaders, buildWebdavUrl, stripBasePath } from "./webdavUtils"
import { getTagLib } from "./taglibSingleton"
import { popmToLocalRating } from "./tagWriter"
import { matchTrackToWebdav } from "./metadataCore"
import type { Track } from "../stores/appState"
import type { WebdavFileEntry } from "./db"

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

class PropfindError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "PropfindError"
    this.status = status
  }
}

/** Servers that refuse `Depth: infinity` (DoS protection) commonly answer
 *  403/409/412 — the recursive crawl fallback only triggers on these. */
const DEPTH_FALLBACK_STATUSES = new Set([403, 409, 412])

const CRAWL_CONCURRENCY = 6

/** One PROPFIND at the given depth: returns file entries and child collection
 *  paths (relative to the base URL). */
async function propfindDir(
  baseUrl: string,
  user: string,
  token: string,
  path: string,
  depth: string,
): Promise<{ entries: WebdavFileEntry[]; collections: string[] }> {
  const url = buildWebdavUrl(baseUrl, path)
  const res = await webdavFetch(url, {
    method: "PROPFIND",
    headers: {
      ...authHeaders(user, token),
      Depth: depth,
    },
  }, INDEX_PROPFIND_TIMEOUT)
  if (!res.ok) throw new PropfindError(res.status, `PROPFIND ${path} failed: ${res.status}`)
  const xml = await res.text()
  const doc = parseXml(xml)
  const responses = doc.getElementsByTagNameNS(DAV_NS, "response")

  const entries: WebdavFileEntry[] = []
  const collections: string[] = []
  for (const resp of responses) {
    const href = getChildText(resp, "href", DAV_NS)
    const cleaned = stripBasePath(baseUrl, href)
    if (!cleaned) continue

    const props = resp.getElementsByTagNameNS(DAV_NS, "prop")[0]
    if (!props) continue

    const filename = cleaned.split("/").pop() || cleaned
    if (props.getElementsByTagNameNS(DAV_NS, "collection")[0]) {
      // Normalize the trailing slash so dir keys dedupe across servers.
      collections.push(cleaned.replace(/\/+$/, ""))
      continue
    }

    const sizeStr = props.getElementsByTagNameNS(DAV_NS, "getcontentlength")[0]?.textContent
    const modStr = props.getElementsByTagNameNS(DAV_NS, "getlastmodified")[0]?.textContent
    entries.push({
      path: cleaned,
      filename,
      size: sizeStr ? parseInt(sizeStr, 10) || 0 : 0,
      lastModified: modStr || undefined,
    })
  }

  return { entries, collections }
}

/** Fallback for servers that refuse `Depth: infinity`: breadth-first crawl of
 *  every directory with `Depth: 1` requests. Produces the same relative-path
 *  entries as the flat probe, so matching/scoring are unaffected. A directory
 *  that fails mid-crawl is skipped with a warning — a partial index degrades
 *  to "more no-match rows", never to stale Push targets; only a total failure
 *  (root probe included) propagates. */
async function crawlIndex(
  baseUrl: string,
  user: string,
  token: string,
): Promise<WebdavFileEntry[]> {
  const entries: WebdavFileEntry[] = []
  const seen = new Set<string>()
  const pending: string[] = []

  const root = await propfindDir(baseUrl, user, token, "/", "1")
  entries.push(...root.entries)
  for (const dir of root.collections) {
    if (!seen.has(dir)) {
      seen.add(dir)
      pending.push(dir)
    }
  }

  while (pending.length > 0) {
    const batch = pending.splice(0, CRAWL_CONCURRENCY)
    const results = await Promise.all(batch.map(async (dir) => {
      try {
        return { ok: true as const, result: await propfindDir(baseUrl, user, token, dir, "1") }
      } catch (err) {
        console.warn(`mmdrome WebDAV crawl: skipping unreadable directory "${dir}"`, err)
        return { ok: false as const, result: undefined }
      }
    }))
    for (const res of results) {
      if (!res.ok) continue
      entries.push(...res.result!.entries)
      for (const dir of res.result!.collections) {
        if (!seen.has(dir)) {
          seen.add(dir)
          pending.push(dir)
        }
      }
    }
  }

  return entries
}

export async function buildWebdavFileIndex(
  baseUrl: string,
  user: string,
  token: string,
): Promise<WebdavFileEntry[]> {
  try {
    return (await propfindDir(baseUrl, user, token, "/", "infinity")).entries
  } catch (err) {
    if (err instanceof PropfindError && DEPTH_FALLBACK_STATUSES.has(err.status)) {
      return crawlIndex(baseUrl, user, token)
    }
    throw err
  }
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
  fileType: string,
): Promise<FileMetadata> {
  let rating = 0
  let loved = false
  let comments = ''
  let title: string | undefined
  let artist: string | undefined
  let album: string | undefined
  let trackNumber: number | undefined

  const taglib = await getTagLib()
  const file = await taglib.open(new Uint8Array(buffer))
  try {
    const r = file.getRating()
    if (r !== undefined && r !== null && r > 0) {
      // getRating() is normalized 0..1 for every format (ID3v2 POPM/255,
      // Vorbis RATING/100, MP4 freeform atom/100). MP3 re-quantizes through
      // the MusicBee-calibrated POPM grid; other formats map straight to the
      // 0..100 local scale — running them through the POPM grid would inflate
      // e.g. 80 (0.8*255=204 -> grid says 90).
      rating = fileType === "mp3"
        ? popmToLocalRating(Math.round(r * 255))
        : Math.min(100, Math.max(0, Math.round(r * 100)))
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

    return { rating, loved, comments: comments || undefined, title, artist, album, trackNumber }
  } finally {
    // Never leak the WASM handle: an exception mid-parse must not skip
    // dispose(), and a dispose failure must never mask the read error.
    try {
      file.dispose()
    } catch {
      // ignore
    }
  }
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
  try {
    const props = file.properties()
    return {
      getRating: file.getRating(),
      properties: { ...props },
    }
  } finally {
    try {
      file.dispose()
    } catch {
      // ignore
    }
  }
}
