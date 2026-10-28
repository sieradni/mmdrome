/**
 * REAL local servers for the "does it work against an actual server" half of the
 * device path: `node:http` processes the app talks to over a real socket — real
 * HTTP methods, real `PROPFIND` XML, real `Range` reads, real preconditions —
 * which no route mock (`webdavMock.ts`) can exercise. Used by
 * `realservers.spec.ts` and, for a real device, by `scripts/serve-fixtures.mjs`.
 *
 * Two MOVE precondition dialects: `strict` is RFC-shaped (a tagged `If` guards
 * the tagged resource, `If-Match` the request URI = the temp source,
 * `If-Unmodified-Since` the destination) and is what the ladder's first rung is
 * written for; `sabre-like` is the 2026-10-27 field shape, refusing the tagged
 * `If` outright and scoping `If-Match` to the temp source, so a client has to
 * walk its ladder and must NOT re-upload.
 *
 * Nothing here is product code: it exists to be talked to.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { buildMp3Fixture } from './fixture'

export type WebdavDialect = 'strict' | 'sabre-like'

interface LocalTrackSpec {
  id: string
  title: string
  artist: string
  album: string
  /** Audio frames — varies the byte size so two files never size-tie. */
  frames: number
}

const LOCAL_TRACKS: LocalTrackSpec[] = [
  { id: 's1', title: 'Song One', artist: 'Artist A', album: 'Album X', frames: 8 },
  { id: 's2', title: 'Song Two', artist: 'Artist B', album: 'Album Y', frames: 10 },
]

interface StoredFile {
  path: string
  bytes: Buffer
  etag: string
  lastModified: string
}

export interface LocalServerCounts {
  propfind: number
  get: number
  put: number
  move: number
  delete: number
  preconditionRejects: number
}

export interface LocalServers {
  /** e.g. http://127.0.0.1:53121 — the app appends /rest/<endpoint>.view. */
  subsonicUrl: string
  /** e.g. http://127.0.0.1:53122/dav/ — the app's WebDAV URL field. */
  webdavBaseUrl: string
  /** The directory the fixture files live in (the app crawls into it). */
  dir: string
  /** Current stored bytes for a relative path (undefined when absent). */
  fileBytes(path: string): Buffer | undefined
  /** Every relative path currently stored (a temp orphan shows up here). */
  storedPaths(): string[]
  /** Live request counters — the assertions that prove "no re-upload". */
  counts(): LocalServerCounts
  close(): Promise<void>
}

const DAV_HEADERS: Record<string, string> = {
  DAV: '1, 2',
  'Accept-Ranges': 'bytes',
  Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MOVE',
}

function httpDate(ms: number): string {
  return new Date(ms).toUTCString()
}

/** Content-derived strong tag with a revision suffix: two writers producing
 *  identical bytes still move the tag, which is what a precondition needs. */
function strongEtag(bytes: Buffer, revision: number): string {
  const digest = createHash('sha1').update(bytes).digest('hex').slice(0, 16)
  return `"${digest}-${revision}"`
}

/** Compare entity tags the way RFC 9110 does: a weak tag and its strong form
 *  are the SAME version, and the surrounding quotes are grammar, not value. */
function normalizeTag(tag: string): string {
  return tag.replace(/^W\//, '').replace(/^"|"$/g, '')
}

function xmlEscape(value: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
  return value.replace(/[&<>"']/g, (c) => map[c]!)
}

function hrefFor(path: string, isCollection = false): string {
  const encoded = path.split('/').map((s) => encodeURIComponent(s)).join('/')
  return `/dav/${encoded}${isCollection ? '/' : ''}`
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export async function startLocalServers(options: {
  dialect?: WebdavDialect
  /** Bind address. Loopback for tests; `0.0.0.0` when a real device on the
   *  LAN has to reach these servers (`scripts/serve-fixtures.mjs`). */
  host?: string
} = {}): Promise<LocalServers> {
  const bind = options.host ?? '127.0.0.1'
  const dialect: WebdavDialect = options.dialect ?? 'strict'
  const dir = 'New'
  const servers = new Set<Server>()

  // Every song is generated HERE so the WebDAV side serves the same bytes the
  // library advertises: the app's real taglib parse reads one and its index
  // sizes come from the other, exactly as in the field.
  const generated = LOCAL_TRACKS.map((t) => ({
    track: t,
    path: `${dir}/${t.title}.mp3`,
    bytes: buildMp3Fixture({ title: t.title, artist: t.artist, album: t.album, frames: t.frames }),
  }))

  // ── Library (Subsonic) ───────────────────────────────────────────────────
  const subsonic = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://subsonic.invalid')
    const endpoint = url.pathname.split('/').pop() ?? ''
    let payload: Record<string, unknown> = {}
    if (endpoint === 'ping.view') payload = { serverVersion: '0.50.0' }
    else if (endpoint === 'getScanStatus.view') payload = { scanStatus: { lastScan: '2026-01-01T00:00:00Z' } }
    else if (endpoint === 'search3.view') {
      payload = {
        searchResult3: {
          song: generated.map(({ track, bytes }) => ({
            id: track.id,
            title: track.title,
            artist: track.artist,
            album: track.album,
            duration: 180,
            suffix: 'mp3',
            size: bytes.length,
            starred: false,
            userRating: 0,
          })),
        },
      }
    } else if (endpoint === 'stream.view') {
      const song = generated.find((g) => g.track.id === url.searchParams.get('id'))
      if (!song) {
        res.writeHead(404, cors(req)).end()
        return
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(song.bytes.length),
        'Accept-Ranges': 'bytes',
        ...cors(req),
      })
      res.end(song.bytes)
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors(req) })
    res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...payload } }))
  })

  // ── Files (WebDAV) ───────────────────────────────────────────────────────
  const files = new Map<string, StoredFile>()
  const dirs = new Set<string>([dir])
  const counters: LocalServerCounts = { propfind: 0, get: 0, put: 0, move: 0, delete: 0, preconditionRejects: 0 }
  let revision = 0

  for (const { path, bytes } of generated) {
    files.set(path, { path, bytes, etag: strongEtag(bytes, ++revision), lastModified: httpDate(Date.now() - 60_000) })
  }

  /** Children of `path` — one level, or every descendant when `recursive`.
   *  Depth: 0 requests never reach here (the caller only asks on depth ≠ '0'). */
  function descendants(root: string, recursive: boolean): { dir: string | null; file: StoredFile | null }[] {
    const out: { dir: string | null; file: StoredFile | null }[] = []
    const queue = [root]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const child of dirs) {
        const parent = child.includes('/') ? child.slice(0, child.lastIndexOf('/')) : ''
        if (parent !== current) continue
        out.push({ dir: child, file: null })
        queue.push(child)
      }
      for (const file of files.values()) {
        const parent = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
        if (parent === current) out.push({ dir: null, file })
      }
      if (!recursive) break
    }
    return out
  }

  function relPath(pathname: string): string {
    let decoded = pathname
    try {
      decoded = decodeURIComponent(pathname)
    } catch { /* malformed escape — use the raw value, as the app's own strip does */ }
    return decoded.replace(/^\/dav\/?/, '').replace(/\/+$/, '')
  }

  function cors(req: IncomingMessage): Record<string, string> {
    return {
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Methods': 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MOVE',
      'Access-Control-Allow-Headers':
        'authorization, content-type, depth, destination, overwrite, if, if-match, if-unmodified-since, cache-control, range',
      'Access-Control-Expose-Headers': 'etag, last-modified, content-length, content-range, accept-ranges, dav',
      Vary: 'Origin',
    }
  }

  /** RFC 4918 tagged If list: `(<uri> ["etag"])`, or the bare `(["etag"])`
   *  form whose target is the request URI. */
  function taggedIfVerdict(header: string, requestPath: string): 'pass' | 'fail' {
    const tagged = [...header.matchAll(/<([^>]*)>\s*\(\s*(\[[^\]]*\])\s*\)/g)]
    const conditions = tagged.length
      ? tagged.map((m) => ({ target: relPath(new URL(m[1], 'http://dav.invalid').pathname), tags: m[2] }))
      : [...header.matchAll(/\(\s*(\[[^\]]*\])\s*\)/g)].map((m) => ({ target: requestPath, tags: m[1] }))
    for (const condition of conditions) {
      const file = files.get(condition.target)
      const wanted = [...condition.tags.matchAll(/"([^"]+)"/g)].map((m) => normalizeTag(m[1]))
      if (!file || !wanted.includes(normalizeTag(file.etag))) return 'fail'
    }
    return 'pass'
  }

  function preconditionRefuses(req: IncomingMessage, requestPath: string, destination: string): boolean {
    const ifHeader = req.headers.if as string | undefined
    const ifMatch = req.headers['if-match'] as string | undefined
    const ifUnmodified = req.headers['if-unmodified-since'] as string | undefined

    if (ifHeader) {
      // The field server shape (2026-10-27): this dialect is refused outright,
      // which is what sends a real client down its ladder.
      if (dialect === 'sabre-like') return true
      if (taggedIfVerdict(ifHeader, requestPath) === 'fail') return true
    }
    if (ifMatch) {
      // RFC 7232 §3.1: If-Match is evaluated against the TARGET RESOURCE = the
      // request URI. For a temp-file MOVE that is the SOURCE, never the
      // Destination — so a destination etag here can never pass.
      if (ifMatch.trim() === '*') {
        if (!files.has(requestPath)) return true
      } else {
        const live = files.get(requestPath)?.etag
        const wanted = [...ifMatch.matchAll(/"([^"]+)"/g)].map((m) => normalizeTag(m[1]))
        if (!live || !wanted.includes(normalizeTag(live))) return true
      }
    }
    if (ifUnmodified) {
      const file = files.get(destination)
      const limit = Date.parse(ifUnmodified)
      if (file && Number.isFinite(limit) && Date.parse(file.lastModified) > limit) return true
    }
    return false
  }

  const webdav = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://dav.invalid')
    const path = relPath(url.pathname)
    const headers = { ...DAV_HEADERS, ...cors(req) }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers).end()
      return
    }

    if (req.method === 'PROPFIND') {
      counters.propfind++
      const depth = String(req.headers.depth ?? '1')
      const isCollection = path === '' || dirs.has(path)
      const responses: string[] = []
      if (isCollection) {
        responses.push(
          `<response><href>${hrefFor(path, true)}</href><propstat><prop>` +
            `<resourcetype><collection/></resourcetype><getlastmodified>${httpDate(Date.now() - 120_000)}</getlastmodified>` +
            `</prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
        )
        // The app builds its index with ONE `Depth: infinity` request (and only
        // falls back to per-directory `Depth: 1` crawls when a server refuses
        // it), so honoring `infinity` is not optional here.
        for (const { dir, file } of descendants(path, depth === 'infinity')) {
          responses.push(
            dir !== null
              ? `<response><href>${hrefFor(dir, true)}</href><propstat><prop>` +
                `<resourcetype><collection/></resourcetype><getlastmodified>${httpDate(Date.now() - 120_000)}</getlastmodified>` +
                `</prop><status>HTTP/1.1 200 OK</status></propstat></response>`
              : `<response><href>${hrefFor(file!.path)}</href><propstat><prop>` +
                `<resourcetype/><getcontentlength>${file!.bytes.length}</getcontentlength>` +
                `<getlastmodified>${file!.lastModified}</getlastmodified><getetag>${xmlEscape(file!.etag)}</getetag>` +
                `</prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
          )
        }
      } else if (files.has(path)) {
        const file = files.get(path)!
        responses.push(
          `<response><href>${hrefFor(file.path)}</href><propstat><prop>` +
            `<resourcetype/><getcontentlength>${file.bytes.length}</getcontentlength>` +
            `<getlastmodified>${file.lastModified}</getlastmodified><getetag>${xmlEscape(file.etag)}</getetag>` +
            `</prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
        )
      }
      const body = `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">${responses.join('')}</multistatus>`
      res.writeHead(207, { ...headers, 'Content-Type': 'application/xml; charset=utf-8' }).end(body)
      return
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = files.get(path)
      if (!file) {
        res.writeHead(404, headers).end()
        return
      }
      counters.get++
      const base = { ...headers, 'Content-Type': 'audio/mpeg', ETag: file.etag, 'Last-Modified': file.lastModified }
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''))
      if (range) {
        const start = Number(range[1])
        const end = range[2] ? Math.min(Number(range[2]), file.bytes.length - 1) : file.bytes.length - 1
        if (start > end || start >= file.bytes.length) {
          res.writeHead(416, { ...base, 'Content-Range': `bytes */${file.bytes.length}` }).end()
          return
        }
        const slice = file.bytes.subarray(start, end + 1)
        res.writeHead(206, {
          ...base,
          'Content-Length': String(slice.length),
          'Content-Range': `bytes ${start}-${end}/${file.bytes.length}`,
        })
        res.end(req.method === 'HEAD' ? undefined : slice)
        return
      }
      res.writeHead(200, { ...base, 'Content-Length': String(file.bytes.length) })
      res.end(req.method === 'HEAD' ? undefined : file.bytes)
      return
    }

    if (req.method === 'PUT') {
      counters.put++
      const bytes = await readBody(req)
      files.set(path, { path, bytes, etag: strongEtag(bytes, ++revision), lastModified: httpDate(Date.now()) })
      res.writeHead(201, { ...headers, ETag: files.get(path)!.etag }).end()
      return
    }

    if (req.method === 'DELETE') {
      counters.delete++
      files.delete(path)
      res.writeHead(204, headers).end()
      return
    }

    if (req.method === 'MOVE') {
      counters.move++
      const destinationHeader = String(req.headers.destination ?? '')
      const destination = relPath(new URL(destinationHeader, 'http://dav.invalid').pathname)
      const source = files.get(path)
      if (!source) {
        res.writeHead(404, headers).end()
        return
      }
      if (preconditionRefuses(req, path, destination)) {
        counters.preconditionRejects++
        res.writeHead(412, headers).end('Precondition Failed')
        return
      }
      const replaced = files.has(destination)
      files.delete(path)
      files.set(destination, {
        path: destination,
        bytes: source.bytes,
        etag: strongEtag(source.bytes, ++revision),
        lastModified: httpDate(Date.now()),
      })
      res.writeHead(replaced ? 204 : 201, headers).end()
      return
    }

    res.writeHead(405, headers).end()
  })

  await Promise.all([
    new Promise<void>((resolve) => subsonic.listen(0, bind, resolve)),
    new Promise<void>((resolve) => webdav.listen(0, bind, resolve)),
  ])
  servers.add(subsonic)
  servers.add(webdav)

  const subsonicPort = (subsonic.address() as { port: number }).port
  const webdavPort = (webdav.address() as { port: number }).port

  return {
    subsonicUrl: `http://127.0.0.1:${subsonicPort}`,
    webdavBaseUrl: `http://127.0.0.1:${webdavPort}/dav/`,
    dir,
    fileBytes: (p) => files.get(p)?.bytes,
    storedPaths: () => [...files.keys()],
    counts: () => ({ ...counters }),
    close: () => new Promise<void>((resolve) => {
      let remaining = servers.size
      for (const server of servers) {
        server.close(() => {
          if (--remaining === 0) resolve()
        })
        server.closeAllConnections?.()
      }
    }),
  }
}
