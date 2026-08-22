import { webdavFetch, authHeaders, buildWebdavUrl, stripBasePath } from "./webdavUtils"
import { getTagLib } from "./taglibSingleton"
import { popmToLocalRating } from "./tagWriter"
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
  // DOMParser reports malformed XML through <parsererror> instead of throwing.
  // Treat it as a failed fresh index; publishing an empty index would otherwise
  // make the caller believe every server file vanished and could prune cache
  // evidence on a later complete-looking response.
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error(`Invalid WebDAV XML for ${path}`)
  }
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
 *  entries as the flat probe, so candidate display remains useful. A directory
 *  that fails mid-crawl is skipped with a warning and `complete` is false —
 *  scanner auto-binding must refuse to treat the partial set as authoritative
 *  (an unseen duplicate could win), while cache pruning and vanished-path
 *  clearing remain disabled. Only a total failure (root probe included)
 *  propagates. */
export interface WebdavIndexBuildResult {
  entries: WebdavFileEntry[]
  /** False when the Depth:1 fallback had to skip a directory. */
  complete: boolean
}

async function crawlIndex(
  baseUrl: string,
  user: string,
  token: string,
): Promise<WebdavIndexBuildResult> {
  const entries: WebdavFileEntry[] = []
  const seen = new Set<string>()
  const pending: string[] = []
  let complete = true

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
        complete = false
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

  return { entries, complete }
}

export async function buildWebdavFileIndexDetailed(
  baseUrl: string,
  user: string,
  token: string,
): Promise<WebdavIndexBuildResult> {
  try {
    return { entries: (await propfindDir(baseUrl, user, token, "/", "infinity")).entries, complete: true }
  } catch (err) {
    if (err instanceof PropfindError && DEPTH_FALLBACK_STATUSES.has(err.status)) {
      return crawlIndex(baseUrl, user, token)
    }
    throw err
  }
}

/** Compatibility wrapper for callers that only need the file list. */
export async function buildWebdavFileIndex(
  baseUrl: string,
  user: string,
  token: string,
): Promise<WebdavFileEntry[]> {
  return (await buildWebdavFileIndexDetailed(baseUrl, user, token)).entries
}

function getMetadataChunkSize(fileType: string): number {
  // Data-efficiency: keep initial small, grow on demand. Opus/ogg/m4a/wav
  // often need >262 kB for tags (3162 retries for 2383 files in the 3.6 MB
  // log, wav 33 MB with tags at tail returned empty on 262 kB). Start them
  // at 512 kB — halves retries for large Vorbis/MP4 + wav without wasting
  // 750 kB on every small mp3 (mp3 tags at head, duration now dropped when
  // truncated so 262 kB is enough for identity).
  if (fileType === 'opus' || fileType === 'ogg' || fileType === 'm4a' || fileType === 'wav' || fileType === 'aiff') {
    return 524288
  }
  switch (fileType) {
    case "mp3":
    case "flac":
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
  let res: Awaited<ReturnType<typeof webdavFetch>>
  try {
    res = await webdavFetch(url, {
      method: "GET",
      headers: {
        ...authHeaders(user, token),
        Range: `bytes=0-${size - 1}`,
      },
    }, METADATA_FETCH_TIMEOUT)
  } catch (err) {
    throw new FileMetadataError('network', `Range GET ${filePath} failed`, err)
  }
  if (!res.ok) {
    if (res.status === 416) {
      let fullRes: Awaited<ReturnType<typeof webdavFetch>>
      try {
        fullRes = await webdavFetch(url, { headers: authHeaders(user, token) }, METADATA_FETCH_TIMEOUT)
      } catch (err) {
        throw new FileMetadataError('network', `GET ${filePath} failed`, err)
      }
      if (!fullRes.ok) throw new FileMetadataError('network', `GET ${filePath} failed: ${fullRes.status}`)
      try {
        return await fullRes.arrayBuffer()
      } catch (err) {
        throw new FileMetadataError('network', `Reading GET ${filePath} failed`, err)
      }
    }
    throw new FileMetadataError('network', `Range GET ${filePath} failed: ${res.status}`)
  }
  try {
    return await res.arrayBuffer()
  } catch (err) {
    throw new FileMetadataError('network', `Reading GET ${filePath} failed`, err)
  }
}

export type FileMetadataFailureKind = 'network' | 'parse'

/** A typed boundary between WebDAV transport failures and tag parsing failures.
 * The probe uses this to choose a retry TTL without treating a temporary
 * outage as a permanently unreadable file. */
export class FileMetadataError extends Error {
  readonly kind: FileMetadataFailureKind
  constructor(kind: FileMetadataFailureKind, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'FileMetadataError'
    this.kind = kind
  }
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
  /** Release year from DATE/YEAR, when present. */
  year?: number
  /** Audio duration in seconds; absent means taglib had no usable duration. */
  duration?: number
}

function firstPropValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0]?.toString().trim()
  if (typeof value === 'string') return value.trim()
  return undefined
}

function getPropValue(props: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    if (props[k] !== undefined) {
      const val = firstPropValue(props[k])
      if (val !== undefined && val !== '') return val
    }
  }
  const upperKeys = keys.map((k) => k.toUpperCase())
  for (const propKey of Object.keys(props)) {
    if (upperKeys.includes(propKey.toUpperCase())) {
      const val = firstPropValue(props[propKey])
      if (val !== undefined && val !== '') return val
    }
  }
  return undefined
}

function parseTrackNumberFromProps(props: Record<string, unknown>): number | undefined {
  const raw = getPropValue(props, ['TRACKNUMBER', 'TRACK'])
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
  let year: number | undefined
  let duration: number | undefined

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

    comments = getPropValue(props, ['COMMENTS', 'COMMENT']) ?? ''

    title = getPropValue(props, ['TITLE'])
    artist = getPropValue(props, ['ARTIST'])
    album = getPropValue(props, ['ALBUM'])
    trackNumber = parseTrackNumberFromProps(props)

    const rawYear = getPropValue(props, ['DATE', 'YEAR'])
    if (rawYear) {
      const parsedYear = parseInt(rawYear.slice(0, 4), 10)
      if (Number.isFinite(parsedYear) && parsedYear > 0) year = parsedYear
    }

    // Audio properties are returned by the same open handle, so duration adds
    // no network read. Some short/partially fetched formats return null or 0;
    // preserve that as absent so matching treats it as no signal.
    const audioProperties = file.audioProperties()
    const parsedDuration = audioProperties?.duration
    if (parsedDuration !== undefined && Number.isFinite(parsedDuration) && parsedDuration > 0) {
      duration = parsedDuration
    }

    console.log(`[metadata-reader] TagLib extracted for ${fileType}:`, {
      propsKeys: Object.keys(props),
      title,
      artist,
      album,
      trackNumber,
      year,
      duration,
      rating,
      loved,
      comments: comments || undefined,
    })

    return { rating, loved, comments: comments || undefined, title, artist, album, trackNumber, year, duration }
  } catch (err) {
    console.warn(`[metadata-reader] TagLib parse error for ${fileType}:`, err)
    throw err
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
  fileSize?: number,
): Promise<FileMetadata> {
  const maxChunkSize = 8388608
  let chunkSize = getMetadataChunkSize(fileType)
  console.log(`[metadata-reader] Reading ${fileType} metadata for ${filePath} (initial chunk: ${chunkSize} bytes${fileSize ? `, fileSize: ${fileSize}` : ''})`)

  while (true) {
    const buffer = await readMetadataChunk(baseUrl, filePath, user, token, fileType, chunkSize)
    const gotFullFile = buffer.byteLength < chunkSize
    try {
      const meta = await extractMetadataFromBuffer(buffer, fileType)
      // Duration for many formats is unreliable from a head-only Range:
      // - Ogg/Opus: granule at tail (20 s vs 158 s for 1.95 MB)
      // - MP3 without Xing: estimated from truncated fileSize (262 kB @ 192k → 10 s vs 403 s)
      //   The three remaining ambiguous mp3 in the 2.1 MB log (10 s/6 s/9 s for
      //   5–9 MB files) are exactly this — joint stereo 192/224/320k CBR/VBR.
      // Fetching the tail to fix it costs a full-file GET (1–3 MB × 2k = GBs).
      // Instead drop duration when truncated so matching uses no-signal (no false
      // ambiguous). FLAC/WAV/AIFF store duration in the head STREAMINFO/RIFF and
      // remain usable.
      const durationUnreliable = fileType === 'opus' || fileType === 'ogg' || fileType === 'mp3' || fileType === 'm4a' || fileType === 'aac' || fileType === 'wma'
      if (durationUnreliable && !gotFullFile) {
        // gotFullFile = buffer.byteLength < chunkSize — true only when we got
        // the whole file (or server ignored Range). Otherwise head-only.
        if (meta.duration !== undefined) {
          const sizeInfo = fileSize ? `${buffer.byteLength}/${fileSize}` : `${buffer.byteLength}/${chunkSize}`
          console.log(`[metadata-reader] ${fileType} duration truncated for ${filePath}: ${meta.duration}s from ${sizeInfo} bytes — dropping duration for matching (saves full-file fetch)`)
        }
        return { ...meta, duration: undefined }
      }
      console.log(`[metadata-reader] Successfully read metadata for ${filePath}:`, meta)
      return meta
    } catch (err) {
      if (chunkSize >= maxChunkSize || gotFullFile) {
        console.warn(`[metadata-reader] Failed to parse metadata for ${filePath} after chunk size ${chunkSize}:`, err)
        if (err instanceof FileMetadataError) throw err
        throw new FileMetadataError('parse', `Could not parse metadata for ${filePath}`, err)
      }
      chunkSize *= 2
      // Clamp to fileSize when known to avoid overshooting
      if (fileSize !== undefined && chunkSize > fileSize) chunkSize = fileSize
      console.log(`[metadata-reader] Chunk size insufficient for ${filePath}, retrying with ${chunkSize} bytes`)
    }
  }
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
